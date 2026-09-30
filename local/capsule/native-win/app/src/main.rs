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
use vyre_capsule_win::{devicekey, drive, update};
use vyre_capsule_win::shell;

/// The data-only signal native-core reads (C22). A value, never a callable host object.
const SHELL_SIGNAL: &str = r#"Object.defineProperty(window, "__VYRE_SHELL__", { value: Object.freeze({ platform: "windows" }), writable: false, configurable: false });"#;

struct Live {
    hotkey: Mutex<String>,
    /// The seed for the pairing the person started: 16 CSPRNG bytes, memory only, five minutes.
    /// The person's Deck turns it into a Wink ticket, so nothing travels back to this computer.
    seed: Mutex<Option<(String, std::time::Instant)>>,
    /// An offer resolved by the bundled page and awaiting the person's Pair.
    pending: Mutex<Option<PendingOut>>,
}

#[derive(Serialize, Clone)]
struct PendingOut {
    name: String,
    fingerprint: String,
    /// The host the panel will load. Always shown, since the name is the box's own free text.
    host: String,
    /// True when the host is not on vyre.run; the confirm page shows it as its own line.
    own_domain: bool,
    #[serde(skip)]
    address: String,
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
    // Written to the app's own data dir (not the shared temp dir), then re-hashed from disk so
    // what runs is what was checked.
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    update::check_file(&listed, &name, &std::fs::read(&path).map_err(|e| e.to_string())?)?;
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

const SEED_LIFE: std::time::Duration = std::time::Duration::from_secs(300);

/// Start "Add this computer": a fresh 16-byte seed, shown to the person (QR or words), never put
/// in a link or a log. Replaces any earlier seed.
#[tauri::command]
fn begin_pair(live: State<Live>) -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    let seed = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    *live.seed.lock().unwrap() = Some((seed.clone(), std::time::Instant::now()));
    *live.pending.lock().unwrap() = None;
    seed
}

/// The bundled page resolved the ticket for our seed and hands over what the sealed record says.
/// Refused unless a live seed exists and no offer is already waiting.
#[tauri::command]
fn offer_pair(app: AppHandle, live: State<Live>, name: String, fingerprint: String, handle: Option<String>, address: Option<String>) -> Result<(), String> {
    match live.seed.lock().unwrap().as_ref() {
        Some((_, at)) if at.elapsed() <= SEED_LIFE => {}
        _ => return Err("This pairing ran out of time. Start again.".into()),
    }
    if live.pending.lock().unwrap().is_some() { return Err("A pairing is already waiting for your answer.".into()); }
    let pin = shell::pin_from_offer(handle.as_deref(), address.as_deref()).map_err(|_| "That server's address does not check out.")?;
    let host = pin.address.trim_start_matches("https://").to_string();
    let clean = |s: &str, max: usize| s.chars().filter(|c| !c.is_control()).take(max).collect::<String>();
    *live.pending.lock().unwrap() = Some(PendingOut { name: clean(&name, 64), fingerprint: clean(&fingerprint, 16), host, own_domain: pin.own_domain, address: pin.address });
    let _ = WebviewWindowBuilder::new(&app, "confirm", WebviewUrl::App("confirm.html".into()))
        .title("Vyre").inner_size(480.0, 340.0).resizable(false).build();
    Ok(())
}

#[tauri::command]
fn pending_pair(live: State<Live>) -> Option<PendingOut> { live.pending.lock().unwrap().clone() }

#[tauri::command]
fn cancel_pair(app: AppHandle, live: State<Live>) {
    *live.pending.lock().unwrap() = None;
    *live.seed.lock().unwrap() = None;
    if let Some(w) = app.get_webview_window("confirm") { let _ = w.close(); }
}

/// The person said Pair: pin the address the sealed record named, and open the panel there.
#[tauri::command]
fn confirm_pair(app: AppHandle, live: State<Live>) -> Result<(), String> {
    let p = live.pending.lock().unwrap().take().ok_or("Nothing to pair.")?;
    *live.seed.lock().unwrap() = None;
    save_pairing(app.clone(), p.address)?;
    if let Some(w) = app.get_webview_window("confirm") { let _ = w.close(); }
    Ok(())
}

/// A `vyre://open` link: a fixed route on the pinned origin, nothing else. Pairing has no link.
fn handle_link(app: &AppHandle, link: &str) {
    if let Some(path) = shell::open_path(link) { show_panel(app, &path); }
}

// The Noise device key. The private half stays here, DPAPI-protected on Windows; a bundled page
// gets only the public half and DH results (relay/client/shellkey.js).
fn key_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("device.key"))
}

#[cfg(windows)]
fn protect(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if encrypt { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out) }
        else { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out) }
    };
    if ok == 0 { return Err("Windows would not open the device key.".into()); }
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe { LocalFree(out.pbData as _) };
    Ok(v)
}

// Off Windows this only exists so the crate builds for local checks; it is never shipped.
#[cfg(not(windows))]
fn protect(data: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> { Ok(data.to_vec()) }

fn device_secret(app: &AppHandle) -> Result<[u8; 32], String> {
    let path = key_path(app)?;
    if let Ok(blob) = std::fs::read(&path) {
        let raw = protect(&blob, false)?;
        return raw.try_into().map_err(|_| "The device key file is damaged.".to_string());
    }
    use rand::RngCore;
    let mut k = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut k);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, protect(&k, true)?).map_err(|e| e.to_string())?;
    Ok(k)
}

fn b64u(b: &[u8]) -> String { use base64::Engine; base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b) }

#[tauri::command]
fn device_key_pub(app: AppHandle) -> Result<String, String> { Ok(b64u(&devicekey::public_key(&device_secret(&app)?))) }

#[tauri::command]
fn device_key_dh(app: AppHandle, remote: String) -> Result<String, String> {
    use base64::Engine;
    let r: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(remote).ok().and_then(|v| v.try_into().ok()).ok_or("That is not a public key.")?;
    Ok(b64u(&devicekey::dh(&device_secret(&app)?, &r)?))
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
        .invoke_handler(tauri::generate_handler![get_state, save_pairing, set_autostart, notify, mount_drive, unmount_drive, begin_pair, offer_pair, pending_pair, confirm_pair, cancel_pair, device_key_pub, device_key_dh])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Live { hotkey: Mutex::new(bind_hotkey(&handle)), seed: Mutex::new(None), pending: Mutex::new(None) });

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
