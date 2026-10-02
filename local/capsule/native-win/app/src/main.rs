// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Vyre Windows shell (plans/windows.md sections 3 and 7, steps 2-6). Two kinds of window:
//! bundled local pages (first-run, settings) that hold the shell's only commands, and the main
//! panel, a WebView2 on the person's own server with no capability, a navigation allowlist and
//! nothing but a frozen data constant injected. The trust rules are in `vyre_capsule_win::shell`.

mod core_host;
mod countersign;

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
use vyre_capsule_win::{devicekey, drive, history, update};
use vyre_capsule_win::shell;

/// The data-only signal native-core reads (C22). A value, never a callable host object.
/// The product name the person sees (window titles, toasts, the tray tooltip). The installer and the
/// update file keep the plain "Vyre" name, which the updater matches on.
/// A Windows tool by full path from the Windows folder, never by name (no planting from the working directory).
fn sys(rel: &str) -> String { shell::system_path(std::env::var("SystemRoot").ok().as_deref(), rel) }

const APP_NAME: &str = "Vyre Lumen";

const TRAY_DARK_TASKBAR: &[u8] = include_bytes!("../icons/lumen-tray-white.ico");
const TRAY_LIGHT_TASKBAR: &[u8] = include_bytes!("../icons/lumen-tray-black.ico");

/// The tray glyph that reads on the current taskbar: black on a light one, white on a dark one.
fn tray_icon() -> Option<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(if taskbar_is_light() { TRAY_LIGHT_TASKBAR } else { TRAY_DARK_TASKBAR }).ok()
}

/// SystemUsesLightTheme (1 is a light taskbar), read straight from the registry: no process is
/// started, so there is nothing on the search path to plant. Unreadable counts as dark, the Windows
/// 11 default.
#[cfg(windows)]
fn taskbar_is_light() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let sub: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0".encode_utf16().collect();
    let val: Vec<u16> = "SystemUsesLightTheme\0".encode_utf16().collect();
    let mut data: u32 = 0;
    let mut size: u32 = 4;
    let rc = unsafe { RegGetValueW(HKEY_CURRENT_USER, sub.as_ptr(), val.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), &mut data as *mut u32 as *mut _, &mut size) };
    rc == 0 && data == 1
}

#[cfg(not(windows))]
fn taskbar_is_light() -> bool { false }

const SHELL_SIGNAL: &str = r#"Object.defineProperty(window, "__VYRE_SHELL__", { value: Object.freeze({ platform: "windows" }), writable: false, configurable: false });"#;

struct Live {
    hotkey: Mutex<String>,
    /// The seed for the pairing the person started: 16 CSPRNG bytes, memory only, five minutes.
    /// The person's Deck turns it into a Wink ticket, so nothing travels back to this computer.
    seed: Mutex<Option<(String, std::time::Instant)>>,
    /// An offer resolved by the bundled page and awaiting the person's Pair.
    pending: Mutex<Option<PendingOut>>,
    /// The person pressed Pair on the confirm window; the bundled page may now run the handshake.
    confirmed: Mutex<bool>,
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

/// The "Import history" window: a bundled page that lists what this PC holds (#26).
fn show_history(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("history") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "history", WebviewUrl::App("history.html".into()))
        .title(APP_NAME)
        .inner_size(560.0, 720.0)
        .build();
    if let Ok(w) = built {
        let a = app.clone();
        w.on_window_event(move |e| {
            if let tauri::WindowEvent::Destroyed = e {
                let a = a.clone();
                std::thread::spawn(move || a.state::<core_host::CoreHost>().let_go_if_idle());
            }
        });
    }
}

fn show_first_run(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("first-run") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "first-run", WebviewUrl::App("first-run.html".into()))
        .title(APP_NAME)
        // Tall enough for the pairing code (QR, 13 words, buttons) without scrolling much.
        .inner_size(520.0, 760.0)
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
        .title(APP_NAME)
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
            .title(APP_NAME)
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

/// What agent sessions this PC holds (Claude Code, Codex, Grok, Gemini CLI): names, sizes, dates and the
/// folder each ran in, never what was said (history.rs). Runs only when the person opens the history
/// window, reads nothing else and sends nothing.
#[tauri::command]
async fn scan_history(app: AppHandle) -> Result<serde_json::Value, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let roots = history::agent_roots(&|k| std::env::var(k).ok(), &home);
        let opts = history::Opts { temp: vec![std::env::temp_dir()], vyre_home: Some(home.join(".vyre")) };
        history::scan(&roots, &opts)
    })
    .await
    .map_err(|e| e.to_string())
}

// Commands that build a window are async: a synchronous command runs on the main thread, and creating a
// webview there deadlocks on Windows (the confirm window stayed at about:blank on a real runner).
/// The local helper's state, for the history screen: off, getting it, starting, up or failed (with why).
#[tauri::command]
fn core_status(core: State<core_host::CoreHost>) -> core_host::CoreState { core.state() }

/// Get the local helper and start it if it is not running. Slow the first time (a download).
#[tauri::command]
async fn core_ensure(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<core_host::CoreHost>().ensure(&app)).await.map_err(|e| e.to_string())?
}

/// One call to one of the helper's fixed tools (core_calls::ALLOWED); the page never names a path or header.
#[tauri::command]
async fn core_call(app: AppHandle, tool: String, input: serde_json::Value) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let core = app.state::<core_host::CoreHost>();
        let out = core.call(&tool, &input)?;
        // A sync import keeps the core up (and across app starts); stopping any import lets it go.
        if tool == "import.start" && input["mode"] == "sync" { core.note_sync(&app, true); }
        if tool == "import.stop" { core.note_sync(&app, false); }
        Ok(out)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_pairing(app: AppHandle, address: String) -> Result<(), String> {
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
    let mut cmd = Command::new(sys("System32\\schtasks.exe"));
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

fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut buf = Vec::new();
    ureq::get(url).set("User-Agent", "vyre-app").call().map_err(|e| e.to_string())?.into_reader().take(limit).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// What the update check found. Nothing is installed here.
enum Answer {
    /// The newest signed release has nothing newer than this build.
    Current(String),
    /// A newer installer, listed and hashed in the signed sums.
    Newer { name: String, version: String, base: String, listed: std::collections::HashMap<String, String> },
    /// The release cannot be trusted or read; the reason is plain words.
    Refused(String),
}

fn latest_check() -> Answer {
    let current = option_env!("VYRE_APP_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
    let run = || -> Result<Answer, String> {
        let feed = String::from_utf8(fetch("https://github.com/vyre-ai/vyre/releases.atom", 4 << 20)?).map_err(|_| "the releases feed is not text")?;
        let tag = update::pick_tag(&feed).ok_or("no stable release found")?;
        let base = update::release_base(&tag);
        // A release this app cannot verify is refused, never read part way: no signature file, no update.
        let sums = fetch(&format!("{base}/SHA256SUMS"), 1 << 20).map_err(|e| format!("{tag}: no SHA256SUMS ({e})"))?;
        let sig = match fetch(&format!("{base}/SHA256SUMS.sig"), 4096) {
            Ok(b) => String::from_utf8(b).map_err(|_| "signature is not text")?,
            Err(_) => return Ok(Answer::Refused(format!("{tag} has no SHA256SUMS.sig, so it is unsigned"))),
        };
        let listed = update::verify_sums(&sums, &sig, update::RELEASE_KEY)?;
        Ok(match update::newer_installer(&listed, current) {
            Some((name, version)) => Answer::Newer { name, version, base, listed },
            None => Answer::Current(tag),
        })
    };
    run().unwrap_or_else(|e| Answer::Refused(e))
}

/// Download and run a newer installer, but only one the Vyre release key signed for. Unsigned,
/// unlisted, hash-mismatched and not-newer all refuse; nothing is written until every check passes.
fn check_update(app: &AppHandle) -> Result<Option<String>, String> {
    let Answer::Newer { name, version, base, listed } = latest_check() else { return Ok(None) };
    let bytes = fetch(&format!("{base}/{name}"), 300 << 20)?;
    update::check_file(&listed, &name, &bytes)?;
    // Written to the app's own data dir (not the shared temp dir), then re-hashed from disk so
    // what runs is what was checked.
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    update::check_file(&listed, &name, &std::fs::read(&path).map_err(|e| e.to_string())?)?;
    std::process::Command::new(&path).args(["/S", "/UPDATE"]).spawn().map_err(|e| e.to_string())?;
    let _ = app.notification().builder().title(APP_NAME).body(format!("Updating to {version}.")).show();
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
    let mut cmd = std::process::Command::new(sys("System32\\net.exe"));
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
    let _ = std::process::Command::new(sys("explorer.exe")).arg(format!("{letter}\\")).spawn();
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
    *live.confirmed.lock().unwrap() = false;
    seed
}

/// The bundled page resolved the ticket for our seed and hands over what the sealed record says.
/// Refused unless a live seed exists and no offer is already waiting.
#[tauri::command]
async fn offer_pair(app: AppHandle, live: State<'_, Live>, name: String, fingerprint: String, handle: Option<String>, address: Option<String>) -> Result<(), String> {
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
        .title(APP_NAME).inner_size(480.0, 340.0).resizable(false).build();
    Ok(())
}

#[tauri::command]
fn pending_pair(live: State<Live>) -> Option<PendingOut> { live.pending.lock().unwrap().clone() }

#[tauri::command]
fn cancel_pair(app: AppHandle, live: State<Live>) {
    *live.pending.lock().unwrap() = None;
    *live.seed.lock().unwrap() = None;
    *live.confirmed.lock().unwrap() = false;
    if let Some(w) = app.get_webview_window("confirm") { let _ = w.close(); }
}

/// The person pressed Pair: nothing is pinned yet. The bundled page sees "confirmed", runs the
/// handshake, and only a finished handshake pins (finish_pair).
#[tauri::command]
fn confirm_pair(app: AppHandle, live: State<Live>) -> Result<(), String> {
    if live.pending.lock().unwrap().is_none() { return Err("Nothing to pair.".into()); }
    *live.confirmed.lock().unwrap() = true;
    if let Some(w) = app.get_webview_window("confirm") { let _ = w.close(); }
    Ok(())
}

/// "waiting" (no answer yet), "confirmed", or "cancelled" (the person said no, or it ran out).
#[tauri::command]
fn pair_status(live: State<Live>) -> &'static str {
    let live_seed = matches!(live.seed.lock().unwrap().as_ref(), Some((_, at)) if at.elapsed() <= SEED_LIFE);
    if *live.confirmed.lock().unwrap() { "confirmed" }
    else if live.pending.lock().unwrap().is_some() && live_seed { "waiting" }
    else { "cancelled" }
}

/// The handshake finished: pin the confirmed address (with what `connect` needs to stay linked,
/// which holds no secret), close the pairing page and open the panel.
#[tauri::command]
async fn finish_pair(app: AppHandle, live: State<'_, Live>, link: serde_json::Value) -> Result<(), String> {
    if !*live.confirmed.lock().unwrap() { return Err("The pairing was not confirmed.".into()); }
    let p = live.pending.lock().unwrap().take().ok_or("Nothing to pair.")?;
    *live.seed.lock().unwrap() = None;
    *live.confirmed.lock().unwrap() = false;
    let path = record_path(&app).ok_or("No place to save on this computer.")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, serde_json::json!({ "address": p.address, "link": link }).to_string()).map_err(|e| e.to_string())?;
    if let Some(w) = app.get_webview_window("first-run") { let _ = w.close(); }
    ensure_link_window(&app);
    // The helper may ask the app to vouch for it for the next fifteen minutes, once.
    app.state::<core_host::CoreHost>().note_paired();
    show_panel(&app, "/quick");
    Ok(())
}

/// What `connect` needs to stay linked to the paired box (no secret in it), for the link window.
#[tauri::command]
fn get_link(app: AppHandle) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(record_path(&app)?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("link").filter(|l| l.is_object()).cloned()
}

/// The persistent, hidden, bundled page that holds the box channel and makes box calls (Drive).
/// The main panel never gets this: only this window has the device key commands after pairing.
fn ensure_link_window(app: &AppHandle) {
    if app.get_webview_window("link").is_some() || get_link(app.clone()).is_none() { return; }
    let _ = WebviewWindowBuilder::new(app, "link", WebviewUrl::App("link.html".into()))
        .title("Vyre link").visible(false).build();
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
pub(crate) fn protect(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> { protect_with(data, encrypt, None) }

/// DPAPI for the current account, with an optional entropy string so a blob made for one purpose opens only for that purpose.
#[cfg(windows)]
pub(crate) fn protect_with(data: &[u8], encrypt: bool, entropy: Option<&[u8]>) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    // Never let Windows raise its own dialog from here.
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 1;
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let ent = entropy.map(|e| CRYPT_INTEGER_BLOB { cbData: e.len() as u32, pbData: e.as_ptr() as *mut u8 });
    let entp: *const CRYPT_INTEGER_BLOB = ent.as_ref().map(|e| e as *const _).unwrap_or(std::ptr::null());
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if encrypt { CryptProtectData(&input, std::ptr::null(), entp, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        else { CryptUnprotectData(&input, std::ptr::null_mut(), entp, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
    };
    if ok == 0 { return Err("Windows would not open the device key.".into()); }
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe { LocalFree(out.pbData as _) };
    Ok(v)
}

// Off Windows this only exists so the crate builds for local checks; it is never shipped.
#[cfg(not(windows))]
pub(crate) fn protect(data: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> { Ok(data.to_vec()) }
#[cfg(not(windows))]
pub(crate) fn protect_with(data: &[u8], _encrypt: bool, _entropy: Option<&[u8]>) -> Result<Vec<u8>, String> { Ok(data.to_vec()) }

static KEY_LOCK: Mutex<()> = Mutex::new(());

/// Read the device key, or make it once. Two first calls cannot both create one (the lock), a
/// key that exists but cannot be opened is an error and never replaced, and a new key is written
/// to a side file then renamed into place, so a crash leaves either no key or a whole one.
fn device_secret(app: &AppHandle) -> Result<[u8; 32], String> {
    let _guard = KEY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = key_path(app)?;
    if path.exists() {
        let blob = std::fs::read(&path).map_err(|e| e.to_string())?;
        let raw = protect(&blob, false)?;
        return raw.try_into().map_err(|_| "The device key file is damaged.".to_string());
    }
    use rand::RngCore;
    let mut k = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut k);
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("device.key.{}.tmp", std::process::id()));
    std::fs::write(&tmp, protect(&k, true)?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(k)
}

fn b64u(b: &[u8]) -> String { use base64::Engine; base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b) }

/// The public half of the app's presence key (SPKI, base64url), offered to the server when this PC pairs so the server can check what the key signs later.
#[tauri::command]
fn presence_key_pub(app: AppHandle) -> Result<String, String> { Ok(countersign::proof_key(&app)?.public_spki_b64u()) }

/// The presence proof for starting a person session on this device with the session key the link page made. Signs one tool, for a key that
/// is exactly a public P-256 JWK (vyre_capsule_win::presence_proof), and nothing else.
#[tauri::command]
fn person_start_proof(app: AppHandle, key: serde_json::Value) -> Result<String, String> {
    use base64::Engine;
    use rand::RngCore;
    let input = vyre_capsule_win::presence_proof::person_start_input(&key)?;
    let mut n = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut n);
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    countersign::proof_key(&app)?.person_start_proof(&input, ts, &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(n))
}

/// The link page's answer to the server call the app asked it to make for the local helper (core_host::Bridge).
#[tauri::command]
fn companion_result(core: State<core_host::CoreHost>, id: u64, answer: serde_json::Value) { core.bridge.answer(id, answer); }

#[tauri::command]
fn device_key_pub(app: AppHandle) -> Result<String, String> { Ok(b64u(&devicekey::public_key(&device_secret(&app)?))) }

#[tauri::command]
fn device_key_dh(app: AppHandle, remote: String) -> Result<String, String> {
    use base64::Engine;
    let r: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(remote).ok().and_then(|v| v.try_into().ok()).ok_or("That is not a public key.")?;
    Ok(b64u(&devicekey::dh(&device_secret(&app)?, &r)?))
}

/// `Vyre.exe --selftest <file>` with VYRE_SELFTEST=1: checks the Windows-only pieces on a real PC
/// (DPAPI round trip, the taskbar theme read, both tray icons decode, the pinned-path helper), writes
/// one line per check to <file>, and exits. It opens no window and touches no pairing or key file.
fn selftest(out: &str) {
    let mut lines = Vec::new();
    let mut check = |name: &str, r: Result<String, String>| lines.push(match r { Ok(d) => format!("pass {name} {d}"), Err(e) => format!("FAIL {name} {e}") });
    check("dpapi-roundtrip", (|| {
        let secret = [7u8; 32];
        let sealed = protect(&secret, true)?;
        if sealed == secret { return Err("the blob equals the secret".into()); }
        let back = protect(&sealed, false)?;
        if back == secret { Ok(format!("{} byte blob", sealed.len())) } else { Err("did not round-trip".into()) }
    })());
    check("taskbar-theme", Ok(if taskbar_is_light() { "light".into() } else { "dark".into() }));
    check("tray-icons-decode", (|| {
        for (n, b) in [("white", TRAY_DARK_TASKBAR), ("black", TRAY_LIGHT_TASKBAR)] {
            tauri::image::Image::from_bytes(b).map_err(|e| format!("{n}: {e}"))?;
        }
        Ok("both".into())
    })());
    check("system-path", Ok(sys("System32\\icacls.exe")));
    // The live update check against GitHub (read only, installs nothing).
    check("update-check", Ok(match latest_check() { Answer::Current(t) => format!("signed {t}, nothing newer"), Answer::Newer { name, version, .. } => format!("newer {version} ({name})"), Answer::Refused(r) => format!("refused: {r}") }));
    check("version", Ok(option_env!("VYRE_APP_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")).to_string()));
    let _ = std::fs::write(out, lines.join("\n") + "\n");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if std::env::var("VYRE_SELFTEST").as_deref() == Ok("1") {
        if let Some(i) = args.iter().position(|a| a == "--selftest") {
            if let Some(out) = args.get(i + 1) { selftest(out); return; }
        }
    }
    // Built only with `--features selftest` (the VM proofs): it installs a package that is not the release's, so a release build has no such door.
    #[cfg(feature = "selftest")]
    if std::env::var("VYRE_SELFTEST").as_deref() == Ok("1") {
        if let Some(i) = args.iter().position(|a| a == "--core-selftest") {
            if let (Some(work), Some(pkg), Some(zip), Some(out)) = (args.get(i + 1), args.get(i + 2), args.get(i + 3), args.get(i + 4)) {
                let r = core_host::selftest(std::path::Path::new(work), std::path::Path::new(pkg), std::path::Path::new(zip));
                let _ = std::fs::write(out, r.lines.join("\n") + "\n");
                return;
            }
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch (a vyre:// link) arrives through the deep-link plugin below.
            show_panel(app, "/quick");
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_state, scan_history, core_status, core_ensure, core_call, save_pairing, set_autostart, notify, mount_drive, unmount_drive, begin_pair, offer_pair, pending_pair, confirm_pair, cancel_pair, pair_status, finish_pair, device_key_pub, device_key_dh, get_link, presence_key_pub, person_start_proof, companion_result])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(core_host::CoreHost::new());
            app.manage(Live { hotkey: Mutex::new(bind_hotkey(&handle)), seed: Mutex::new(None), pending: Mutex::new(None), confirmed: Mutex::new(false) });

            let open = MenuItem::with_id(app, "open", "Open Vyre", true, None::<&str>)?;
            let drive = MenuItem::with_id(app, "drive", "Open Vyre Drive", true, None::<&str>)?;
            let history = MenuItem::with_id(app, "history", "Import history", true, None::<&str>)?;
            let allow = MenuItem::with_id(app, "allow", "Allow local helper", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &drive, &history, &allow, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_panel(app, "/quick"),
                    "drive" => { use tauri::Emitter; let _ = app.emit_to("link", "vyre-drive", ()); }
                    "history" => show_history(app),
                    "allow" => app.state::<core_host::CoreHost>().tap(),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle_panel(tray.app_handle());
                    }
                });
            tray = tray.tooltip(APP_NAME);
            if let Some(icon) = tray_icon().or_else(|| app.default_window_icon().cloned()) { tray = tray.icon(icon); }
            let tray = tray.build(app)?;
            // Follow the taskbar theme; once a minute is plenty.
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                if let Some(icon) = tray_icon() { let _ = tray.set_icon(Some(icon)); }
            });

            // Start in the tray; show the panel only when first-run is needed.
            if pinned(&handle).is_none() { show_first_run(&handle); }
            ensure_link_window(&handle);
            // A "keep them in sync" import the person started earlier gets its helper back.
            if pinned(&handle).is_some() && handle.state::<core_host::CoreHost>().restore_sync(&handle) {
                let h = handle.clone();
                std::thread::spawn(move || { let _ = h.state::<core_host::CoreHost>().ensure(&h); });
            }
            spawn_update_loop(handle.clone());

            use tauri_plugin_deep_link::DeepLinkExt;
            let link_app = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for u in event.urls() { handle_link(&link_app, u.as_str()); }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("vyre app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event { app.state::<core_host::CoreHost>().stop(); }
            // A tray app keeps running with no window open: closing the last window (finishing pairing closes
            // the first-run page before the panel exists) asks to exit with no code, and that is refused.
            // Quit from the tray exits with a code and goes through.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() { api.prevent_exit(); }
            }
        });
}
