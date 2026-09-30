// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Vyre Windows shell (plans/windows.md sections 3 and 7, steps 2-6). Two kinds of window:
//! bundled local pages (first-run, settings) that hold the shell's only commands, and the main
//! panel, a WebView2 on the person's own server with no capability, a navigation allowlist and
//! nothing but a frozen data constant injected. The trust rules are in `vyre_capsule_win::shell`.

use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use vyre_capsule_win::hotkey;
use vyre_capsule_win::shell::Pinned;

/// The data-only signal native-core reads (C22). A value, never a callable host object.
const SHELL_SIGNAL: &str = r#"Object.defineProperty(window, "__VYRE_SHELL__", { value: Object.freeze({ platform: "windows" }), writable: false, configurable: false });"#;

struct Live {
    hotkey: Mutex<String>,
}

#[derive(Serialize)]
struct StateOut {
    paired: bool,
    address: Option<String>,
    hotkey: String,
}

fn record_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("pairing.json"))
}

/// The pinned origin, from the pairing record the shell wrote itself. Nothing else feeds it.
fn pinned(app: &AppHandle) -> Option<Pinned> {
    let text = std::fs::read_to_string(record_path(app)?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    Pinned::parse(v.get("address")?.as_str()?)
}

fn open_external(app: &AppHandle, url: &str) {
    // Only https, handed to the system browser; never loaded in the panel.
    if url.starts_with("https://") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

fn show_first_run(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("first-run") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "first-run", WebviewUrl::App("first-run.html".into()))
        .title("Vyre")
        .inner_size(480.0, 360.0)
        .resizable(false)
        .build();
}

/// Open (or reveal) the main panel at `path` on the pinned origin.
fn show_panel(app: &AppHandle, path: &str) {
    let Some(pin) = pinned(app) else { return show_first_run(app) };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(pin.url_for(path).parse().expect("pinned url"));
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let nav_pin = pin.clone();
    let nav_app = app.clone();
    let popup_app = app.clone();
    let popup_pin = pin.clone();
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(pin.url_for(path).parse().expect("pinned url")))
        .title("Vyre")
        .inner_size(560.0, 720.0)
        .initialization_script(SHELL_SIGNAL)
        .on_navigation(move |url| {
            if nav_pin.allows(url.as_str()) { return true; }
            open_external(&nav_app, url.as_str());
            false
        })
        .on_new_window(move |url, _features| {
            // No in-panel popups: off-origin links go to the system browser, same-origin
            // ones are simply refused.
            if !popup_pin.allows(url.as_str()) { open_external(&popup_app, url.as_str()); }
            NewWindowResponse::Deny
        })
        .build();
    if let Ok(w) = built {
        let w2 = w.clone();
        w.on_window_event(move |e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w2.hide();
            }
        });
    }
}

fn toggle_panel(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) => { let _ = w.hide(); }
        _ => show_panel(app, "/quick"),
    }
}

/// Bind the default hotkey, falling back to Ctrl+Alt+Space when another app holds it.
fn bind_hotkey(app: &AppHandle) -> String {
    let gs = app.global_shortcut();
    let handler = |app: &AppHandle, _s: &tauri_plugin_global_shortcut::Shortcut, ev: tauri_plugin_global_shortcut::ShortcutEvent| {
        if ev.state == ShortcutState::Pressed { toggle_panel(app); }
    };
    let default_ok = gs.on_shortcut(hotkey::DEFAULT.label().as_str(), handler).is_ok();
    let (binding, tell) = hotkey::choose(default_ok);
    if !default_ok {
        let _ = gs.on_shortcut(binding.label().as_str(), handler);
    }
    if tell {
        let _ = app.notification().builder()
            .title("Vyre")
            .body(format!("{} was taken, so Vyre uses {}.", hotkey::DEFAULT.label(), binding.label()))
            .show();
    }
    binding.label()
}

#[tauri::command]
fn get_state(app: AppHandle, live: State<Live>) -> StateOut {
    let pin = pinned(&app);
    StateOut { paired: pin.is_some(), address: pin.map(|p| p.origin().to_string()), hotkey: live.hotkey.lock().unwrap().clone() }
}

#[tauri::command]
fn save_pairing(app: AppHandle, address: String) -> Result<(), String> {
    let pin = Pinned::parse(&address).ok_or("That is not a server address. Try alex.vyre.run.")?;
    let path = record_path(&app).ok_or("No place to save on this computer.")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, serde_json::json!({ "address": pin.origin() }).to_string()).map_err(|e| e.to_string())?;
    if let Some(w) = app.get_webview_window("first-run") { let _ = w.close(); }
    show_panel(&app, "/quick");
    Ok(())
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    use std::process::Command;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new("schtasks");
    if enabled {
        cmd.args(["/Create", "/TN", "Vyre", "/TR", &format!("\"{}\"", exe.display()), "/SC", "ONLOGON", "/RL", "LIMITED", "/F"]);
    } else {
        cmd.args(["/Delete", "/TN", "Vyre", "/F"]);
    }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_state, save_pairing, set_autostart, notify])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Live { hotkey: Mutex::new(bind_hotkey(&handle)) });

            let open = MenuItem::with_id(app, "open", "Open Vyre", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_panel(app, "/quick"),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle_panel(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.build(app)?;

            // Start in the tray; show the panel only when first-run is needed.
            if pinned(&handle).is_none() { show_first_run(&handle); }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("vyre app");
}
