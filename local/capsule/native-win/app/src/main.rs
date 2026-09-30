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
use vyre_capsule_win::{drive, update, wink};
use vyre_capsule_win::shell;

/// The data-only signal native-core reads (C22). A value, never a callable host object.
const SHELL_SIGNAL: &str = r#"Object.defineProperty(window, "__VYRE_SHELL__", { value: Object.freeze({ platform: "windows" }), writable: false, configurable: false });"#;

struct Live {
    hotkey: Mutex<String>,
    /// The nonce this app issued for an "Add this computer" the person started (C7). Only a
    /// `vyre://pair` link carrying it is honored.
    nonce: Mutex<Option<String>>,
    /// A ticket that resolved and awaits the person's yes, with the address it would pin.
    pending: Mutex<Option<(wink::Offer, String)>>,
}

#[derive(Serialize)]
struct PendingOut {
    name: String,
    fingerprint: String,
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

const RELEASE_BASE: &str = "https://github.com/vyre-ai/vyre/releases/latest/download";

fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut buf = Vec::new();
    ureq::get(url).call().map_err(|e| e.to_string())?.into_reader().take(limit).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Download and run a newer installer, but only one the Vyre release key signed for. Unsigned,
/// unlisted, hash-mismatched and not-newer all refuse; nothing is written until every check passes.
fn check_update(app: &AppHandle) -> Result<Option<String>, String> {
    let sums = fetch(&format!("{RELEASE_BASE}/SHA256SUMS"), 1 << 20)?;
    let sig = String::from_utf8(fetch(&format!("{RELEASE_BASE}/SHA256SUMS.sig"), 4096)?).map_err(|_| "signature is not text")?;
    let listed = update::verify_sums(&sums, &sig, update::RELEASE_KEY)?;
    let Some((name, version)) = update::newer_installer(&listed, env!("CARGO_PKG_VERSION")) else { return Ok(None) };
    let bytes = fetch(&format!("{RELEASE_BASE}/{name}"), 300 << 20)?;
    update::check_file(&listed, &name, &bytes)?;
    let path = std::env::temp_dir().join(&name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    std::process::Command::new(&path).arg("/S").spawn().map_err(|e| e.to_string())?;
    let _ = app.notification().builder().title("Vyre").body(format!("Updating to {version}.")).show();
    app.exit(0);
    Ok(Some(version))
}

/// Once at start, then daily. Failures are silent: the app keeps working on the version it has.
fn spawn_update_loop(app: AppHandle) {
    std::thread::spawn(move || loop {
        let _ = check_update(&app);
        std::thread::sleep(std::time::Duration::from_secs(24 * 3600));
    });
}

fn net_use(args: &[String]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("net");
    cmd.args(args);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    let out = cmd.output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text) } else { Err(drive::explain(&text)) }
}

/// Map a Vyre Drive share (the UNC from the box's files.drive.address) to a free letter and
/// open it in Explorer. Only 100.100.100.100@8080 shares are accepted, whoever asks.
#[tauri::command]
fn mount_drive(unc: String) -> Result<String, String> {
    if !drive::is_vyre_unc(&unc) { return Err("That is not a Vyre Drive share.".into()); }
    let used = net_use(&[]).map(|o| drive::used_letters(&o)).unwrap_or_default();
    let letter = drive::free_letter(&used, |l| std::path::Path::new(&format!("{l}\\")).exists()).ok_or("No free drive letter.")?;
    net_use(&drive::map_args(&letter, &unc))?;
    let _ = std::process::Command::new("explorer").arg(format!("{letter}\\")).spawn();
    Ok(letter)
}

#[tauri::command]
fn unmount_drive(letter: String) -> Result<(), String> {
    let b = letter.as_bytes();
    if b.len() != 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' { return Err("That is not a drive letter.".into()); }
    net_use(&drive::unmap_args(&letter.to_ascii_uppercase())).map(|_| ())
}

const RELAY: &str = "https://relay.vyre.run";

/// Issue this app's nonce for "Add this computer"; the Deck's Wink link must carry it back.
#[tauri::command]
fn begin_pair(live: State<Live>) -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    let n = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    *live.nonce.lock().unwrap() = Some(n.clone());
    n
}

#[tauri::command]
fn pending_pair(live: State<Live>) -> Option<PendingOut> {
    live.pending.lock().unwrap().as_ref().map(|(o, _)| PendingOut { name: o.name.clone(), fingerprint: o.fingerprint.clone() })
}

#[tauri::command]
fn cancel_pair(app: AppHandle, live: State<Live>) {
    *live.pending.lock().unwrap() = None;
    *live.nonce.lock().unwrap() = None;
    if let Some(w) = app.get_webview_window("confirm") { let _ = w.close(); }
}

/// The person said yes: pin the address the sealed record named, and open the panel there.
#[tauri::command]
fn confirm_pair(app: AppHandle, live: State<Live>) -> Result<(), String> {
    let (_, address) = live.pending.lock().unwrap().take().ok_or("Nothing to pair.")?;
    *live.nonce.lock().unwrap() = None;
    save_pairing(app.clone(), address)?;
    if let Some(w) = app.get_webview_window("confirm") { let _ = w.close(); }
    Ok(())
}

/// A `vyre://pair` link: honored only with this app's own nonce. The ticket is looked up once at
/// the relay, MAC-checked and opened, then shown to the person before anything is pinned.
fn handle_link(app: &AppHandle, link: &str) {
    let live = app.state::<Live>();
    if let Some(path) = shell::open_path(link) {
        show_panel(app, &path);
        return;
    }
    let Some(nonce) = live.nonce.lock().unwrap().clone() else { return };
    if !shell::pair_matches(link, &nonce) { return; }
    let ticket = url_param(link, "ticket").and_then(|t| {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(t).ok()
    });
    let Some(ticket) = ticket.filter(|t| t.len() == wink::TICKET_BYTES) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let body = serde_json::json!({ "loc": wink::locator(&ticket) }).to_string();
        let res = ureq::post(&format!("{RELAY}/v1/pair")).set("content-type", "application/json").send_string(&body);
        let Ok(res) = res else { return };
        let Ok(v) = res.into_json::<serde_json::Value>() else { return };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let offer = wink::open_record(&ticket, v["record"].as_str().unwrap_or(""), v["mac"].as_str().unwrap_or(""), now);
        let Ok(offer) = offer else { return };
        // Only a handle on vyre.run gives an address; anything else is not pinned from a ticket.
        let Some(address) = offer.address() else { return };
        *app.state::<Live>().pending.lock().unwrap() = Some((offer, address));
        let _ = WebviewWindowBuilder::new(&app, "confirm", WebviewUrl::App("confirm.html".into()))
            .title("Vyre").inner_size(480.0, 320.0).resizable(false).build();
    });
}

fn url_param(link: &str, key: &str) -> Option<String> {
    url::Url::parse(link).ok()?.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch (a vyre:// link) arrives through the deep-link plugin below.
            show_panel(app, "/quick");
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_state, save_pairing, set_autostart, notify, mount_drive, unmount_drive, begin_pair, pending_pair, confirm_pair, cancel_pair])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Live { hotkey: Mutex::new(bind_hotkey(&handle)), nonce: Mutex::new(None), pending: Mutex::new(None) });

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
            spawn_update_loop(handle.clone());

            use tauri_plugin_deep_link::DeepLinkExt;
            let link_app = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for u in event.urls() { handle_link(&link_app, u.as_str()); }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("vyre app");
}
