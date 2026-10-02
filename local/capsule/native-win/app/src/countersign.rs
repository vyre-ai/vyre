//! The app-owned pipe the local core uses to ask the app to vouch for it (#26, v0.2.3), and the app's
//! P-256 key (DPAPI) that does the vouching.
//!
//! The channel (platform's six points and reviewer-2's three details, both binding):
//! - the app creates the pipe, per launch, with a random name that goes to the core on its stdin, never on
//!   a command line; first instance only (`FILE_FLAG_FIRST_PIPE_INSTANCE`, so another process of the
//!   person cannot have created the name first), remote clients rejected, and a DACL for this account only;
//! - a connection counts only if `GetNamedPipeClientProcessId` equals `GetProcessId` of a handle to the child
//!   the app started, held open for as long as the pipe lives (never a stored pid number, so a reused pid cannot
//!   match). Any other client is disconnected and the app keeps listening, so a process that guesses the name
//!   cannot take the instance and stop pairing;
//! - at most two instances exist (the one being served and the one waiting), and a second client waits its turn;
//! - one request per connection, one line each way, 4 KB at most, five seconds at most;
//! - the app builds what it signs itself (`presence_proof`), never bytes the core hands it.

use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use vyre_capsule_win::presence_proof::ProofKey;

static KEY_LOCK: Mutex<()> = Mutex::new(());

/// The app's presence key, under DPAPI beside the device key. Made once (two first calls cannot both make one),
/// written to a side file then renamed, and one that exists but will not open is an error, never replaced.
pub fn proof_key(app: &AppHandle) -> Result<ProofKey, String> {
    let _guard = KEY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("presence.key");
    if path.exists() {
        let raw = crate::protect(&std::fs::read(&path).map_err(|e| e.to_string())?, false)?;
        let scalar: [u8; 32] = raw.try_into().map_err(|_| "The presence key file is damaged.".to_string())?;
        return ProofKey::from_scalar(&scalar);
    }
    use rand::RngCore;
    let scalar = loop {
        let mut k = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut k);
        if ProofKey::from_scalar(&k).is_ok() { break k; }
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("presence.key.{}.tmp", std::process::id()));
    std::fs::write(&tmp, crate::protect(&scalar, true)?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    ProofKey::from_scalar(&scalar)
}

/// One request line from the core, or why it is refused. Only the fields the app will use.
pub struct Request { pub core: String, pub nonce: String, pub name: String }

pub fn parse_request(line: &str) -> Result<Request, String> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| "not a request".to_string())?;
    let o = v.as_object().ok_or("not a request")?;
    if o.keys().any(|k| !["v", "op", "core", "nonce", "name"].contains(&k.as_str())) { return Err("not a request".into()); }
    if v["v"] != 1 || v["op"] != "companion" { return Err("not a request".into()); }
    let s = |k: &str| v[k].as_str().map(String::from);
    Ok(Request { core: s("core").ok_or("not a request")?, nonce: s("nonce").ok_or("not a request")?, name: s("name").unwrap_or_default() })
}

/// What the serve loop does with a vetted request; the answer is one JSON line.
pub type Handler = Box<dyn Fn(Request) -> serde_json::Value + Send + Sync>;

pub struct Served { stop: std::sync::Arc<std::sync::atomic::AtomicBool>, pipe: String, thread: Option<std::thread::JoinHandle<()>> }

impl Served {
    /// Stop listening and wait for the loop to end. The loop is woken by the app's own connection to its pipe, which it refuses as not-the-child.
    pub fn stop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = imp::wake(&self.pipe);
        if let Some(t) = self.thread.take() { let _ = t.join(); }
    }
}

impl Drop for Served { fn drop(&mut self) { self.stop(); } }

/// A fresh pipe name for one launch: 128 random bits.
pub fn new_pipe_name() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!("\\\\.\\pipe\\vyre-app-{}", vyre_capsule_win::core_launch::token_from(&b))
}

/// Whether a first instance of `pipe` can be made now (it cannot while the app's own is up): the squatting check.
pub fn name_is_free(pipe: &str) -> bool { imp::create(pipe, true).is_ok() }

/// Start serving `pipe` for `child`; the pipe exists (first instance created) when this returns.
pub fn serve(pipe: String, child: &std::process::Child, handler: Handler) -> Result<Served, String> {
    let owned = imp::own_child(child)?;
    let first = imp::create(&pipe, true)?;
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (s2, p2) = (stop.clone(), pipe.clone());
    let thread = std::thread::spawn(move || imp::run(p2, first, owned, s2, handler));
    Ok(Served { stop, pipe, thread: Some(thread) })
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, DuplicateHandle, LocalFree, DUPLICATE_SAME_ACCESS, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::Storage::FileSystem::{FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessId, OpenProcessToken};

    const MAX_LINE: usize = 4096;
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

    /// An owned handle that closes with it.
    pub struct Owned(HANDLE);
    unsafe impl Send for Owned {}
    impl Drop for Owned { fn drop(&mut self) { if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE { unsafe { CloseHandle(self.0) }; } } }

    /// A second handle to the child process, ours to keep open for as long as the pipe lives.
    pub fn own_child(child: &std::process::Child) -> Result<Owned, String> {
        let mut dup: HANDLE = std::ptr::null_mut();
        let ok = unsafe { DuplicateHandle(GetCurrentProcess(), child.as_raw_handle() as HANDLE, GetCurrentProcess(), &mut dup, 0, 0, DUPLICATE_SAME_ACCESS) };
        if ok == 0 { return Err("Windows would not let the app keep a handle to the local helper.".into()); }
        Ok(Owned(dup))
    }

    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

    /// "D:P(A;;GA;;;<this account's SID>)": nobody else, not even other accounts' administrators by default.
    fn sddl() -> Result<Vec<u16>, String> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err("Windows would not say which account this is.".into()); }
            let token = Owned(token);
            let mut len = 0u32;
            GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buf = vec![0u8; len as usize];
            if GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr() as *mut _, len, &mut len) == 0 { return Err("Windows would not say which account this is.".into()); }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut sid: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 { return Err("Windows would not say which account this is.".into()); }
            let mut n = 0; while *sid.add(n) != 0 { n += 1; }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(sid, n));
            LocalFree(sid as _);
            Ok(wide(&format!("D:P(A;;GA;;;{s})")))
        }
    }

    /// One instance of the pipe: first (the name must be new) or a later one (the name is ours).
    pub fn create(name: &str, first: bool) -> Result<Owned, String> {
        unsafe {
            let sd_text = sddl()?;
            let mut sd: *mut core::ffi::c_void = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sd_text.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 { return Err("Windows would not make the pipe's access list.".into()); }
            let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
            let open = PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
            let h = CreateNamedPipeW(wide(name).as_ptr(), open, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 2, 4096, 4096, 0, &sa);
            LocalFree(sd as _);
            if h == INVALID_HANDLE_VALUE { return Err(if first { "The app's pipe name is already taken, so the local helper was not started.".into() } else { "Windows would not open the app's pipe again.".into() }); }
            Ok(Owned(h))
        }
    }

    /// Connect once as a client, to wake a listener that is waiting.
    pub fn wake(name: &str) -> std::io::Result<()> { std::fs::OpenOptions::new().read(true).write(true).open(name).map(|_| ()) }

    fn read_line(h: HANDLE) -> Option<String> {
        let mut out = Vec::new();
        let mut b = [0u8; 512];
        loop {
            let mut n = 0u32;
            if unsafe { ReadFile(h, b.as_mut_ptr() as *mut _, b.len() as u32, &mut n, std::ptr::null_mut()) } == 0 || n == 0 { return None; }
            out.extend_from_slice(&b[..n as usize]);
            if out.len() > MAX_LINE { return None; }
            if let Some(i) = out.iter().position(|c| *c == b'\n') { out.truncate(i); return String::from_utf8(out).ok(); }
        }
    }

    fn write_line(h: HANDLE, s: &str) {
        let data = format!("{s}\n");
        let mut n = 0u32;
        unsafe { WriteFile(h, data.as_ptr(), data.len() as u32, &mut n, std::ptr::null_mut()); FlushFileBuffers(h); }
    }

    pub fn run(pipe: String, first: Owned, child: Owned, stop: std::sync::Arc<std::sync::atomic::AtomicBool>, handler: Handler) {
        let ours = unsafe { GetProcessId(child.0) };
        let mut current = first;
        loop {
            let connected = unsafe { ConnectNamedPipe(current.0, std::ptr::null_mut()) } != 0 || std::io::Error::last_os_error().raw_os_error() == Some(535); // ERROR_PIPE_CONNECTED
            if stop.load(std::sync::atomic::Ordering::SeqCst) { return; }
            // Keep the name held by a waiting instance before this client is looked at.
            let next = match create(&pipe, false) { Ok(n) => n, Err(_) => return };
            if connected {
                let mut pid = 0u32;
                let from_child = unsafe { GetNamedPipeClientProcessId(current.0, &mut pid) } != 0 && ours != 0 && pid == ours;
                if from_child {
                    // A watchdog ends a stuck read or write by disconnecting from another thread. The handler's own time is not counted.
                    let h = current.0 as usize;
                    let watch = |f: &mut dyn FnMut() -> bool| {
                        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                        let d2 = done.clone();
                        let dog = std::thread::spawn(move || {
                            let t0 = std::time::Instant::now();
                            while t0.elapsed() < DEADLINE { if d2.load(std::sync::atomic::Ordering::SeqCst) { return; } std::thread::sleep(std::time::Duration::from_millis(50)); }
                            unsafe { DisconnectNamedPipe(h as HANDLE) };
                        });
                        let r = f();
                        done.store(true, std::sync::atomic::Ordering::SeqCst);
                        let _ = dog.join();
                        r
                    };
                    let mut line = None;
                    watch(&mut || { line = read_line(current.0); line.is_some() });
                        let reply = match line.map(|l| parse_request(&l)) {
                        Some(Ok(r)) => handler(r),
                        Some(Err(e)) => serde_json::json!({ "ok": false, "error": e }),
                        None => serde_json::json!({ "ok": false, "error": "no request" }),
                    };
                    // Write the answer, then let the client close first (a read that ends when it does), so it has read it all before the instance is taken away.
                    watch(&mut || { write_line(current.0, &reply.to_string()); let mut sink = [0u8; 64]; let mut n = 0u32; unsafe { ReadFile(current.0, sink.as_mut_ptr() as *mut _, 64, &mut n, std::ptr::null_mut()) }; true });
                    }
                unsafe { DisconnectNamedPipe(current.0) };
            }
            current = next;
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub struct Owned;
    pub fn own_child(_: &std::process::Child) -> Result<Owned, String> { Err("The app's pipe is for Windows.".into()) }
    pub fn create(_: &str, _: bool) -> Result<Owned, String> { Err("The app's pipe is for Windows.".into()) }
    pub fn wake(_: &str) -> std::io::Result<()> { Ok(()) }
    pub fn run(_: String, _: Owned, _: Owned, _: std::sync::Arc<std::sync::atomic::AtomicBool>, _: Handler) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_has_exactly_the_known_fields() {
        let r = parse_request(r#"{"v":1,"op":"companion","core":"K","nonce":"N","name":"PC"}"#).unwrap();
        assert_eq!((r.core.as_str(), r.nonce.as_str(), r.name.as_str()), ("K", "N", "PC"));
        for bad in [r#"{"v":2,"op":"companion","core":"K","nonce":"N"}"#, r#"{"v":1,"op":"sign","core":"K","nonce":"N"}"#, r#"{"v":1,"op":"companion","core":"K"}"#,
            r#"{"v":1,"op":"companion","core":"K","nonce":"N","extra":1}"#, "nope", "[]"] {
            assert!(parse_request(bad).is_err(), "{bad}");
        }
    }
}
