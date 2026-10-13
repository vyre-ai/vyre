//! Vyre in File Explorer, as the app drives it: the switch (Settings and the tray), the way server calls reach this computer's own device channel, and the start-up.
//!
//! The mount (vyre_capsule_win::mount_win) never holds a key. Each server call becomes an event to the hidden link page, which already holds this computer's device channel and makes the call
//! as the person's device; the answer comes back through `mount_reply`, a command only that page may call.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use vyre_capsule_win::mount::{CallError, VyreCall};

use super::{from_pinned, get_link, log};

/// How long one server call may take before the mount gives up on it (a big range over a slow link).
const CALL_TIMEOUT: Duration = Duration::from_secs(90);

/// Server calls for the mount, made by the link page.
pub struct Broker {
    app: AppHandle,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, CallError>>>>,
    next: AtomicU64,
}

impl Broker {
    pub fn new(app: AppHandle) -> Broker { Broker { app, pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) } }
}

impl VyreCall for Broker {
    fn call(&self, tool: &str, input: Value) -> Result<Value, CallError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if self.app.emit_to("link", "vyre-mount-call", json!({ "id": id, "tool": tool, "input": input })).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(CallError { code: "no_link".into(), message: "the link page is not running".into() });
        }
        let got = rx.recv_timeout(CALL_TIMEOUT);
        self.pending.lock().unwrap().remove(&id);
        match got {
            Ok(r) => r,
            Err(_) => Err(CallError { code: "timeout".into(), message: "the server did not answer".into() }),
        }
    }
}

#[cfg(windows)]
type Running = vyre_capsule_win::mount_win::Mount;
#[cfg(not(windows))]
type Running = ();

pub struct Mounting {
    pub broker: Arc<Broker>,
    running: Mutex<Option<Running>>,
}

impl Mounting {
    pub fn new(app: AppHandle) -> Mounting { Mounting { broker: Arc::new(Broker::new(app)), running: Mutex::new(None) } }
}

fn flag_path(app: &AppHandle) -> Option<std::path::PathBuf> { app.path().app_data_dir().ok().map(|d| d.join("mount.json")) }

fn wanted(app: &AppHandle) -> bool {
    flag_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("on").and_then(Value::as_bool)).unwrap_or(false)
}

fn remember(app: &AppHandle, on: bool) {
    if let Some(p) = flag_path(app) {
        if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
        let _ = std::fs::write(p, json!({ "on": on }).to_string());
    }
}

/// Start or stop the mount, as a computer that is paired.
pub fn set(app: &AppHandle, on: bool) -> Result<(), String> {
    let state = app.state::<Mounting>();
    let mut running = state.running.lock().unwrap();
    if on {
        if running.is_some() { return Ok(()); }
        if get_link(app.clone()).is_none() { return Err("Pair this computer with your Vyre first.".into()); }
        #[cfg(windows)]
        {
            let root = vyre_capsule_win::mount_win::default_root().ok_or("No user folder.")?;
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let icon = format!("{},0", exe.display());
            let server: Arc<dyn VyreCall + Send + Sync> = state.broker.clone();
            let m = vyre_capsule_win::mount_win::start(root, &icon, server, Box::new(|what| log("note", "mount", what)))?;
            *running = Some(m);
        }
        #[cfg(not(windows))]
        { return Err("Vyre in File Explorer is for Windows.".into()); }
    } else if let Some(m) = running.take() {
        #[cfg(windows)]
        { m.stop(); let _ = vyre_capsule_win::mount_win::unregister(); }
        #[cfg(not(windows))]
        { let _ = m; }
    }
    remember(app, on);
    log("note", "mount", if on { "on" } else { "off" });
    Ok(())
}

/// At start-up: bring the mount back if the person left it on.
pub fn restore(app: &AppHandle) {
    if wanted(app) {
        if let Err(e) = set(app, true) { log("fail", "mount", &e); }
    }
}

/// The tray's switch.
pub fn toggle(app: &AppHandle) {
    let on = app.state::<Mounting>().running.lock().unwrap().is_some();
    if let Err(e) = set(app, !on) { log("fail", "mount", &e); }
}

/// The link page's answer to a `vyre-mount-call`. Only that page.
#[tauri::command]
pub fn mount_reply(state: State<Mounting>, webview: tauri::Webview, id: u64, data: Option<Value>, error: Option<Value>) -> Result<(), String> {
    if webview.label() != "link" { log("refuse", "mount_reply", "a window other than link answered"); return Err("Not allowed here.".into()); }
    let tx = state.broker.pending.lock().unwrap().remove(&id);
    if let Some(tx) = tx {
        let r = match error {
            Some(e) => Err(CallError { code: e.get("code").and_then(Value::as_str).unwrap_or("failed").to_string(), message: e.get("message").and_then(Value::as_str).unwrap_or("").to_string() }),
            None => Ok(data.unwrap_or(Value::Null)),
        };
        let _ = tx.send(r);
    }
    Ok(())
}

/// For Settings: whether this computer can show Vyre in File Explorer, and whether it does now.
#[tauri::command]
pub fn mount_state(app: AppHandle, state: State<Mounting>, webview: tauri::Webview, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    from_pinned(&app, &webview, &request)?;
    let on = state.running.lock().unwrap().is_some();
    Ok(json!({ "supported": cfg!(windows), "on": on, "paired": get_link(app.clone()).is_some() }))
}

/// Settings, "Show Vyre in File Explorer".
#[tauri::command]
pub fn mount_set(app: AppHandle, webview: tauri::Webview, request: tauri::ipc::Request<'_>, on: bool) -> Result<(), String> {
    from_pinned(&app, &webview, &request)?;
    set(&app, on)
}
