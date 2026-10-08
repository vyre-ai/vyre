// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Vyre Windows shell (plans/windows.md sections 3 and 7, steps 2-6). Two kinds of window:
//! bundled local pages (first-run, settings) that hold the shell's only commands, and the main
//! panel, a WebView2 on the person's own server with no capability, a navigation allowlist and
//! nothing but a frozen data constant injected. The trust rules are in `vyre_capsule_win::shell`.

mod ncrypt;

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
use vyre_capsule_win::{applog, bundled, devicekey, drive, update};
use vyre_capsule_win::shell;

/// The data-only signal native-core reads (C22). A value, never a callable host object.
/// The product name the person sees (window titles, toasts, the tray tooltip). The installer and the
/// update file keep the plain "Vyre" name, which the updater matches on.
/// A Windows tool by full path from the Windows folder, never by name (no planting from the working directory).
fn sys(rel: &str) -> String { shell::system_path(std::env::var("SystemRoot").ok().as_deref(), rel) }

/// %LOCALAPPDATA%\Vyre\logs\app.log. Every refusal and failure of a key, a window or the bundled app lands here with its real reason (no key, seed or message is ever written).
fn log(kind: &str, who: &str, what: &str) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let file = applog::path(std::env::var("LOCALAPPDATA").ok().as_deref(), &std::env::temp_dir());
    applog::append(&file, &applog::line(now, kind, who, what));
}

/// A result, with its failure logged under the command's name. The reason travels on to the page unchanged.
fn logged<T>(who: &str, r: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &r { log("fail", who, e); }
    r
}

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

/// What the main panel (the person's own server's page) is told about this shell, as frozen data and four calls. The calls are the identity key's (identity_public, identity_sign) and the TPM
/// key's (enclave_public, enclave_sign): the page gets public keys and signatures, never a seed. They are the same shape as the Mac app's window.__vyreShell.identity, so the page runs one way.
/// Only these four commands are permitted to the panel (capabilities/main-identity.json), and each refuses unless it is called from the pinned origin (`from_pinned`).
fn shell_signal(version: &str, boxless: bool) -> String {
    let v = serde_json::to_string(version).unwrap_or_else(|_| "\"\"".into());
    let boxless = if boxless { "true" } else { "false" };
    format!(r#"(function () {{
  Object.defineProperty(window, "__VYRE_SHELL__", {{ value: Object.freeze({{ platform: "windows" }}), writable: false, configurable: false }});
  var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return;
  var identity = Object.freeze({{
    public: function (create) {{ return inv("identity_public", {{ create: !!create }}); }},
    sign: function (message) {{ return inv("identity_sign", {{ message: message }}); }},
    has: function () {{ return inv("identity_has", {{}}); }},
    forget: function () {{ return inv("identity_forget", {{}}); }},
    setupDone: function () {{ return inv("setup_finished", {{}}); }},
    enclavePublic: function (create) {{ return inv("enclave_public", {{ create: !!create }}); }},
    enclaveSign: function (message, prompt) {{ return inv("enclave_sign", {{ message: message, prompt: prompt }}); }},
    agreePublic: function (create) {{ return inv("agree_public", {{ create: !!create }}); }},
    agree: function (epk) {{ return inv("agree_secret", {{ epk: epk }}); }}
  }});
  Object.defineProperty(window, "__vyreShell", {{ value: Object.freeze({{ kind: "windows", boxless: {boxless}, version: {v}, identity: identity }}), writable: false, configurable: false }});
}})();"#)
}

struct Live {
    hotkey: Mutex<String>,
}

/// The short typed code (WINK-NNPP-PPPP) ships in release builds (the user's ruling of 5 Oct; the lead corrected an earlier reading). It is on unless a build sets VYRE_TYPED_CODE=0 at compile time,
/// which hides the bundled first-run page's typed path and makes `finish_typed_pair` refuse.
/// Whether a build-time switch says exactly "0". Compared byte by byte: stable Rust cannot match a `str` in a constant.
const fn env_is_zero(v: Option<&str>) -> bool {
    match v {
        Some(s) => {
            let b = s.as_bytes();
            b.len() == 1 && b[0] == b'0'
        }
        None => false,
    }
}
const TYPED_CODE: bool = !env_is_zero(option_env!("VYRE_TYPED_CODE"));

#[derive(Serialize)]
struct StateOut {
    paired: bool,
    typed_code: bool,
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

/// The folder the app's web build was put in when this app was built (VYRE_APP_WEB_DIR overrides, for a hand-run check), or None when it was built without it.
fn bundled_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = match std::env::var("VYRE_APP_WEB_DIR") {
        Ok(d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => app.path().resource_dir().ok()?.join("app-web"),
    };
    if bundled::has_build(&dir) { Some(dir) } else { None }
}

/// Open (or reveal) the app's own window: the bundled web build at its own origin, with this computer's keys behind it and no server needed. This is the first run on Windows (paste the
/// reservation code, become yourself, then Join a team or Add a server) and every run after.
fn show_app(app: &AppHandle, path: &str) {
    let url = format!("{}{}", bundled::START, path.trim_start_matches('/'));
    if let Some(w) = app.get_webview_window("main") {
        if !path.is_empty() && path != "/quick" { if let Ok(u) = url.parse() { let _ = w.navigate(u); } }
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let nav_app = app.clone();
    let popup_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(bundled::START.parse().expect("bundled url")));
    // A build made for the Windows proof (VYRE_PROOF_DEVTOOLS_PORT set when it was COMPILED, never at run time) lets the test driver read the page over the DevTools protocol. A release is not built with it.
    // (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS did not open the port: wry passes its own arguments, which win.)
    #[cfg(windows)]
    let builder = match option_env!("VYRE_PROOF_DEVTOOLS_PORT") {
        Some(port) => builder.additional_browser_args(&format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}")),
        None => builder,
    };
    let built = builder
        .title(APP_NAME)
        .inner_size(560.0, 760.0)
        // WebView2 serves a custom scheme at http(s)://<scheme>.localhost; https makes the page a secure context, as the Mac's is.
        .use_https_scheme(true)
        .on_page_load(|w, p| log("note", "page", &format!("{:?} {}", p.event(), p.url())))
        .initialization_script(shell_signal(&app.package_info().version.to_string(), true))
        .on_navigation(move |url| {
            if bundled::is_page(url.as_str()) { return true; }
            open_external(&nav_app, url.as_str());
            false
        })
        .on_new_window(move |url, _features| {
            if !bundled::is_page(url.as_str()) { open_external(&popup_app, url.as_str()); }
            NewWindowResponse::Deny
        })
        .build();
    match built {
        Ok(w) => {
            log("note", "show_app", "the window was built");
            let w2 = w.clone();
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    let _ = w2.hide();
                }
            });
        }
        Err(e) => log("fail", "show_app", &e.to_string()),
    }
}

fn show_first_run(app: &AppHandle) {
    // The app's own window is the only first run. The release always carries the web build (build.rs refuses to build without it), so there is no second, older first-run page to fall back to.
    show_app(app, "");
}

/// Open (or reveal) the main panel at `path` on the pinned origin.
fn show_panel(app: &AppHandle, path: &str) {
    // One origin for the life of the app (lead ruling, 8 Oct): the window stays on https://vyreapp.localhost before and after pairing, so the identity key (a Windows Hello passkey bound to that origin's rp)
    // signs in the same place, and the person's server is reached over the relay, as the Mac's window does at vyreapp://box.
    show_app(app, path);
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
    StateOut { typed_code: TYPED_CODE, paired: pin.is_some(), address: pin.map(|p| p.origin().to_string()), hotkey: live.hotkey.lock().unwrap().clone() }
}

// Commands that build a window are async: a synchronous command runs on the main thread, and creating a
// webview there deadlocks on Windows (the confirm window stayed at about:blank on a real runner).
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
    std::process::Command::new(&path).arg("/S").spawn().map_err(|e| e.to_string())?;
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

/// A pairing made with the typed code another device showed (relay/client/join.js, the ack typed back there is the person's yes): keep it as the device-first pairing does, pinned to the
/// box's own address. Only the bundled first-run page may call this; the address is checked by `pin_from_offer`.
#[tauri::command]
async fn finish_typed_pair(app: AppHandle, link: serde_json::Value, address: Option<String>, handle: Option<String>) -> Result<(), String> {
    if !TYPED_CODE { return Err("Pairing by a typed code is off in this build. Open your Vyre by its address and pair there.".into()); }
    // The address the pairing named, held to the rules for what the shell may pin (shell::pin_from_offer): on vyre.run it must be exactly the box's own handle's address.
    let choice = shell::pin_from_offer(handle.as_deref(), address.as_deref()).map_err(|_| "The pairing gave no address this app can open.")?;
    let pin = Pinned::parse(&choice.address).ok_or("The pairing gave no address this app can open.")?;
    if !link.is_object() { return Err("The pairing was not complete.".into()); }
    let path = record_path(&app).ok_or("No place to save on this computer.")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, serde_json::json!({ "address": pin.origin(), "link": link }).to_string()).map_err(|e| e.to_string())?;
    if let Some(w) = app.get_webview_window("first-run") { let _ = w.close(); }
    ensure_link_window(&app);
    show_panel(&app, "/quick");
    Ok(())
}

/// The identity key's and the TPM key's commands are the main panel's only ones, and only from the pinned origin: the capability lets the panel call them, and this refuses any other page
/// (a navigation that slipped past, a frame) before a key is touched.
fn from_pinned(app: &AppHandle, webview: &tauri::Webview, request: &tauri::ipc::Request<'_>) -> Result<(), String> {
    if webview.label() != "main" { log("refuse", "bridge", "a window other than main called a key command"); return Err("Not allowed here.".into()); }
    // The app's own bundled page (its top-level page and the frame that made this call are both exactly its origin) is the other caller allowed; the pinned server's page is the first.
    {
        let top = webview.url().ok();
        let frame = request.headers().get("origin").and_then(|v| v.to_str().ok());
        if top.as_ref().map_or(false, |u| bundled::is_page(u.as_str())) && bundled::is_origin(frame) { return Ok(()); }
    }
    let Some(pin) = pinned(app) else { log("refuse", "bridge", "no paired server and not the bundled page"); return Err("Not allowed here.".into()) };
    // The top-level page is the pinned one...
    let url = webview.url().map_err(|_| "Not allowed here.".to_string())?;
    if !pin.allows(url.as_str()) { log("refuse", "bridge", "the page is not the pinned origin"); return Err("Not allowed here.".into()); }
    // ...and so is the frame that made THIS call: the capability admits any https frame, so a cross-origin iframe inside the pinned page would pass the check above. Its call carries its own Origin.
    let origin = request.headers().get("origin").and_then(|v| v.to_str().ok());
    if !pin.is_origin(origin) { log("refuse", "bridge", "the calling frame is not the pinned origin"); }
    if !pin.is_origin(origin) { return Err("Not allowed here.".into()); }
    Ok(())
}

fn identity_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("identity.key")).map_err(|e| e.to_string())
}

static IDENTITY_LOCK: Mutex<()> = Mutex::new(());

/// The Ed25519 identity seed, DPAPI-protected on this computer; made once with `create`. It never leaves Rust.
fn identity_seed(app: &AppHandle, create: bool) -> Result<[u8; 32], String> {
    let r = identity_seed_inner(app, create);
    // "There is no key on this computer." with create false is an ordinary answer (nothing made yet), not a failure worth a line.
    if let Err(e) = &r { if create || !e.starts_with("There is no key") { log("fail", "identity_seed", e); } }
    r
}

fn identity_seed_inner(app: &AppHandle, create: bool) -> Result<[u8; 32], String> {
    let _guard = IDENTITY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = identity_path(app)?;
    if path.exists() {
        let raw = protect(&std::fs::read(&path).map_err(|e| format!("Could not read the identity key file: {e}"))?, false)?;
        return raw.try_into().map_err(|_| "The identity key file is damaged.".to_string());
    }
    if !create { return Err("There is no key on this computer.".into()); }
    use rand::RngCore;
    let mut k = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut k);
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not make the folder for the identity key: {e}"))?;
    let tmp = dir.join(format!("identity.key.{}.tmp", std::process::id()));
    std::fs::write(&tmp, protect(&k, true)?).map_err(|e| format!("Could not save the identity key: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not save the identity key: {e}"))?;
    Ok(k)
}

fn unb64u(s: &str) -> Result<Vec<u8>, String> { use base64::Engine; base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).map_err(|_| "That is not a message to sign.".to_string()) }

#[tauri::command]
fn identity_public(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>, create: bool) -> Result<String, String> {
    from_pinned(&app, &webview, &request)?;
    Ok(b64u(&vyre_capsule_win::identity::public_key(&identity_seed(&app, create)?)))
}

#[tauri::command]
fn identity_sign(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>, message: String) -> Result<String, String> {
    from_pinned(&app, &webview, &request)?;
    let m = unb64u(&message)?;
    if m.is_empty() || m.len() > 64 * 1024 { return Err("That is not a message to sign.".into()); }
    Ok(b64u(&vyre_capsule_win::identity::sign(&identity_seed(&app, false)?, &m)))
}

fn setup_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("setup.done")).map_err(|e| e.to_string())
}

fn setup_done(app: &AppHandle) -> bool { setup_path(app).map(|p| p.exists()).unwrap_or(false) }

/// The page says setup has finished (the person paired a server or joined a team): from now on the app starts hidden in the tray.
#[tauri::command]
fn setup_finished(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    from_pinned(&app, &webview, &request)?;
    let path = setup_path(&app)?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("Could not make the app folder: {e}"))?; }
    logged("setup_finished", std::fs::write(&path, b"1").map_err(|e| format!("Could not save that setup is finished: {e}")))
}

/// Is there an identity key on this computer? Answers without opening it.
#[tauri::command]
fn identity_has(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    from_pinned(&app, &webview, &request)?;
    Ok(identity_path(&app)?.exists())
}

/// Forget this computer's identity key (Settings, "Forget this computer's key"). The page asks for it by name; the line in the log says it happened.
#[tauri::command]
fn identity_forget(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    from_pinned(&app, &webview, &request)?;
    let _guard = IDENTITY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = identity_path(&app)?;
    log("note", "identity_forget", "the identity key file was deleted at the page's request");
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => logged("identity_forget", Err(format!("Could not forget the key: {e}"))),
    }
}

#[tauri::command]
fn enclave_public(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>, create: bool) -> Result<String, String> {
    from_pinned(&app, &webview, &request)?;
    Ok(b64u(&logged("enclave_public", ncrypt::public_point(create))?))
}

/// The shell's own yes or no, in a Windows message box the page cannot draw over, with the words the shell wrote from the bytes.
#[cfg(windows)]
fn confirm_native(said: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO};
    let w = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let text = w(&format!("{}\n\nSign this with your computer's key?", said));
    let title = w("Vyre");
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND) == IDYES }
}
#[cfg(not(windows))]
fn confirm_native(_said: &str) -> bool { false }

/// The TPM key signs only after Windows has asked the person (Windows Hello). `prompt` is the words the page gave for it; Windows shows its own.
#[tauri::command]
fn enclave_sign(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>, message: String, prompt: Option<String>) -> Result<String, String> {
    from_pinned(&app, &webview, &request)?;
    // KP-3: the page's `prompt` is never shown. The shell reads the bytes, says what they are in its own window, and signs nothing it cannot read. (Yes-moment proofs are not read here, so they are not signed.)
    let _ = prompt;
    let m = unb64u(&message)?;
    if m.is_empty() || m.len() > 64 * 1024 { return Err("That is not a message to sign.".into()); }
    let said = vyre_capsule_win::identity::chain_summary(&m).ok_or_else(|| "Vyre cannot tell what this would sign, so it did not.".to_string())?;
    if !confirm_native(&said) { return Err("Not approved. Nothing was changed.".into()); }
    Ok(b64u(&logged("enclave_sign", ncrypt::sign(&m))?))
}

/// The agreement key (ECDH, no prompt per use): its public point, and the shared secret with a peer's point. The key stays in the TPM or the user's key store.
#[tauri::command]
fn agree_public(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>, create: bool) -> Result<String, String> {
    from_pinned(&app, &webview, &request)?;
    Ok(b64u(&logged("agree_public", ncrypt::agree_public(create))?))
}

#[tauri::command]
fn agree_secret(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>, epk: String) -> Result<String, String> {
    from_pinned(&app, &webview, &request)?;
    let p = unb64u(&epk)?;
    Ok(b64u(&logged("agree_secret", ncrypt::agree_secret(&p))?))
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
fn protect(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    // Never let Windows raise its own dialog from here.
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 1;
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if encrypt { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        else { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
    };
    if ok == 0 { return Err("Windows would not open the device key.".into()); }
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe { LocalFree(out.pbData as _) };
    Ok(v)
}

// Off Windows this only exists so the crate builds for local checks; it is never shipped.
#[cfg(not(windows))]
fn protect(data: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> { Ok(data.to_vec()) }

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
    // The TPM key, as a real PC does it: what the provider says at each step is the proof of what this machine can do. A hosted runner has no TPM, so the honest result there is the refusal and its status.
    check("tpm-key", match ncrypt::public_point(true) { Ok(p) => Ok(format!("a TPM key was made ({} bytes)", p.len())), Err(e) => Ok(format!("no TPM key: {e}")) });
    check("agreement-key", match ncrypt::agree_public(true) { Ok(p) => Ok(format!("an agreement key was made ({} bytes)", p.len())), Err(e) => Err(e) });
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
    // A panic or an early exit must leave a line, not a silent window that never opened.
    std::panic::set_hook(Box::new(|i| log("panic", "main", &i.to_string())));
    log("note", "start", option_env!("VYRE_APP_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")));
    let args: Vec<String> = std::env::args().collect();
    if std::env::var("VYRE_SELFTEST").as_deref() == Ok("1") {
        if let Some(i) = args.iter().position(|a| a == "--selftest") {
            if let Some(out) = args.get(i + 1) { selftest(out); return; }
        }
    }
    tauri::Builder::default()
        // The app's web build, served to its own window (bundled.rs). A file outside the build, or a build that is not there, is a 404 and a line in the log.
        .register_uri_scheme_protocol(bundled::SCHEME, |ctx, request| {
            let reply = |status: u16, mime: &str, body: Vec<u8>| {
                tauri::http::Response::builder().status(status).header("Content-Type", mime).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store").body(body).expect("response")
            };
            let Some(dir) = bundled_dir(ctx.app_handle()) else {
                log("fail", "bundled", "this app was built without the app's web build");
                return reply(404, "text/plain", b"not here".to_vec());
            };
            match bundled::resolve(request.uri().path(), &dir) {
                bundled::Answer::File { path, mime } => match std::fs::read(&path) {
                    Ok(body) => reply(200, mime, body),
                    Err(e) => { log("fail", "bundled", &format!("could not read {}: {e}", path.display())); reply(500, "text/plain", b"error".to_vec()) }
                },
                bundled::Answer::Missing => reply(404, "text/plain", b"not here".to_vec()),
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch (a vyre:// link) arrives through the deep-link plugin below.
            show_panel(app, "/quick");
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_state, save_pairing, set_autostart, notify, mount_drive, unmount_drive, finish_typed_pair, identity_public, identity_sign, identity_has, identity_forget, setup_finished, enclave_public, enclave_sign, agree_public, agree_secret, device_key_pub, device_key_dh, get_link])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Live { hotkey: Mutex::new(bind_hotkey(&handle)) });

            let open = MenuItem::with_id(app, "open", "Open Vyre", true, None::<&str>)?;
            let drive = MenuItem::with_id(app, "drive", "Open Vyre Drive", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &drive, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_panel(app, "/quick"),
                    "drive" => { use tauri::Emitter; let _ = app.emit_to("link", "vyre-drive", ()); }
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
            log("note", "setup", "tray built");
            // Follow the taskbar theme; once a minute is plenty.
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                if let Some(icon) = tray_icon() { let _ = tray.set_icon(Some(icon)); }
            });

            // Start in the tray; show the panel only when first-run is needed.
            // Not paired yet: the first run (the bundled app when this build has it: reserve, become yourself, Join or Add a server). Paired: the tray.
            // A computer that has finished setup starts hidden in the tray; one that has not opens the app. The page says when setup is finished (`setup_finished`), and that is the one signal.
            if !setup_done(&handle) { show_first_run(&handle); }
            ensure_link_window(&handle);
            spawn_update_loop(handle.clone());
            log("note", "setup", "done");

            use tauri_plugin_deep_link::DeepLinkExt;
            let link_app = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for u in event.urls() { handle_link(&link_app, u.as_str()); }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("vyre app")
        .run(|_app, event| {
            { // every event but the idle ones, so a window that closes or an exit that nobody asked for has a line
                let name = format!("{event:?}");
                if !name.starts_with("MainEventsCleared") && !name.starts_with("Resumed") { log("event", "run", &name.chars().take(160).collect::<String>()); }
            }
            // A tray app keeps running with no window open: closing the last window (finishing pairing closes
            // the first-run page before the panel exists) asks to exit with no code, and that is refused.
            // Quit from the tray exits with a code and goes through.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                log("note", "exit-requested", &format!("code {code:?}"));
                if code.is_none() { api.prevent_exit(); }
            }
            if let tauri::RunEvent::Exit = &event { log("note", "exit", "the event loop ended"); }
        });
}
