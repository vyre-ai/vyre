//! Vyre in File Explorer, the Windows half: a Cloud Files sync root (the API OneDrive uses). Placeholders show every file the person may read, a file's bytes come when it is opened, and what the
//! person does in Explorer (save, rename, delete) goes back to the server. All of the deciding is in `mount.rs`; this file only talks to Windows.
//!
//! Who it acts as: every server call goes through a `VyreCall`, which the app wires to the hidden link page that holds THIS computer's own device channel. So it is the person's device and
//! session, never a shared key, and the server's grants decide what shows. Nothing here holds a key.
//!
//! Not yet run on a Windows machine (this Mac has none): it is type-checked against the Windows target and driven by `app/` once the proof run on a real PC exists.

use std::collections::HashSet;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde_json::Value;
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::CloudFilters::*;
use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_BASIC_INFO};

use crate::mount::{self, Call, CallError, Mirror, Op, UploadPlan, VyreCall};

/// ERROR_ALREADY_EXISTS as an HRESULT.
const E_EXISTS: i32 = 0x800700B7u32 as i32;
const STATUS_UNSUCCESSFUL: i32 = 0xC0000001u32 as i32;
const PAGE: i64 = 4096;
/// A file touched in the last seconds is left alone: a program may still be writing it.
const SETTLE: Duration = Duration::from_secs(3);
const EVERY: Duration = Duration::from_secs(10);

fn wide(s: &str) -> Vec<u16> { std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect() }
fn wide_path(p: &Path) -> Vec<u16> { p.as_os_str().encode_wide().chain(std::iter::once(0)).collect() }
fn ok(hr: i32) -> Result<(), String> { if hr >= 0 { Ok(()) } else { Err(format!("0x{:08X}", hr as u32)) } }

/// The folder shown in Explorer: C:\Users\<name>\Vyre.
pub fn default_root() -> Option<PathBuf> { std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("Vyre")) }

struct State {
    root: PathBuf,
    /// The root without its drive letter, lowercase, `/`-separated: what Windows hands a callback as the normalized path.
    root_norm: String,
    server: Arc<dyn VyreCall + Send + Sync>,
    mirror: Mutex<Mirror>,
    /// Paths this provider is removing itself (lowercase, relative): their delete notices are not the person's.
    quiet: Mutex<HashSet<String>>,
    key: Mutex<CF_CONNECTION_KEY>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// A running mount. Dropping it does not stop it; call `stop`.
pub struct Mount {
    state: Arc<State>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

fn user_sid() -> Result<String, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut tok: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) == 0 { return Err("no token".into()); }
        let mut need = 0u32;
        GetTokenInformation(tok, TokenUser, std::ptr::null_mut(), 0, &mut need);
        let mut buf = vec![0u8; need as usize];
        let got = GetTokenInformation(tok, TokenUser, buf.as_mut_ptr() as *mut c_void, need, &mut need);
        CloseHandle(tok);
        if got == 0 { return Err("no user".into()); }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut out: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut out) == 0 { return Err("no sid".into()); }
        let mut n = 0;
        while *out.add(n) != 0 { n += 1; }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(out, n));
        LocalFree(out as *mut c_void);
        Ok(s)
    }
}

/// The sync root id Windows keeps: provider, user, account (docs: `Provider!SID!Account`).
fn sync_root_id() -> Result<String, String> { Ok(format!("Vyre!{}!Files", user_sid()?)) }

/// Show "Vyre" in File Explorer's navigation pane and register the folder as a sync root. `icon` is a resource such as `C:\\Program Files\\Vyre\\Vyre.exe,0`.
pub fn register(root: &Path, icon: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Storage::Provider::*;
    use windows::Storage::StorageFolder;
    use windows::Security::Cryptography::CryptographicBuffer;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let folder = StorageFolder::GetFolderFromPathAsync(&HSTRING::from(root.as_os_str())).map_err(|e| e.message())?.get().map_err(|e| e.message())?;
    let info = StorageProviderSyncRootInfo::new().map_err(|e| e.message())?;
    let id = sync_root_id()?;
    let e = |x: windows::core::Error| x.message();
    info.SetId(&HSTRING::from(id.as_str())).map_err(e)?;
    info.SetPath(&folder).map_err(e)?;
    info.SetDisplayNameResource(&HSTRING::from("Vyre")).map_err(e)?;
    info.SetIconResource(&HSTRING::from(icon)).map_err(e)?;
    info.SetHydrationPolicy(StorageProviderHydrationPolicy::Partial).map_err(e)?;
    info.SetHydrationPolicyModifier(StorageProviderHydrationPolicyModifier::None).map_err(e)?;
    info.SetPopulationPolicy(StorageProviderPopulationPolicy::AlwaysFull).map_err(e)?;
    info.SetInSyncPolicy(StorageProviderInSyncPolicy::Default).map_err(e)?;
    info.SetHardlinkPolicy(StorageProviderHardlinkPolicy::None).map_err(e)?;
    info.SetVersion(&HSTRING::from("1")).map_err(e)?;
    info.SetShowSiblingsAsGroup(false).map_err(e)?;
    info.SetAllowPinning(true).map_err(e)?;
    info.SetContext(&CryptographicBuffer::ConvertStringToBinary(&HSTRING::from("vyre"), windows::Security::Cryptography::BinaryStringEncoding::Utf8).map_err(e)?).map_err(e)?;
    StorageProviderSyncRootManager::Register(&info).map_err(|x| x.message())
}

/// Take "Vyre" out of the navigation pane. The folder and its files stay where they are.
pub fn unregister() -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Storage::Provider::StorageProviderSyncRootManager;
    StorageProviderSyncRootManager::Unregister(&HSTRING::from(sync_root_id()?.as_str())).map_err(|x| x.message())
}

/// Register, connect and start keeping the folder and the server in step.
pub fn start(root: PathBuf, icon: &str, server: Arc<dyn VyreCall + Send + Sync>, log: Box<dyn Fn(&str) + Send + Sync>) -> Result<Mount, String> {
    register(&root, icon)?;
    let norm = {
        let s = root.to_string_lossy().replace('\\', "/");
        let s = if s.len() > 1 && s.as_bytes()[1] == b':' { s[2..].to_string() } else { s };
        s.trim_end_matches('/').to_lowercase()
    };
    let state = Arc::new(State { root: root.clone(), root_norm: norm, server, mirror: Mutex::new(Mirror::new()), quiet: Mutex::new(HashSet::new()), key: Mutex::new(0), log });
    let table = [
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_FETCH_DATA, Callback: Some(on_fetch) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NOTIFY_DELETE_COMPLETION, Callback: Some(on_delete_completion) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NOTIFY_RENAME_COMPLETION, Callback: Some(on_rename_completion) },
        CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NONE, Callback: None },
    ];
    let mut key: CF_CONNECTION_KEY = 0;
    // The context is the State's address, which the Arc keeps alive until `stop` has disconnected.
    let ctx = Arc::as_ptr(&state) as *const c_void;
    ok(unsafe { CfConnectSyncRoot(wide_path(&root).as_ptr(), table.as_ptr(), ctx, CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO | CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH, &mut key) })?;
    *state.key.lock().unwrap() = key;
    let stop = Arc::new(AtomicBool::new(false));
    let (s2, stop2) = (state.clone(), stop.clone());
    let thread = std::thread::spawn(move || {
        while !stop2.load(Ordering::Relaxed) {
            if let Err(e) = s2.pass() { (s2.log)(&format!("sync pass: {e}")); }
            let mut waited = Duration::ZERO;
            while waited < EVERY && !stop2.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(250)); waited += Duration::from_millis(250); }
        }
    });
    Ok(Mount { state, stop, thread: Some(thread) })
}

impl Mount {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() { let _ = t.join(); }
        let key = *self.state.key.lock().unwrap();
        unsafe { CfDisconnectSyncRoot(key); }
    }
}

impl State {
    fn say(&self, what: &str) { (self.log)(what); }

    /// A path under the root as Windows' normalized form hands it (`\Users\x\Vyre\a\b.txt`) -> `a/b.txt`.
    fn rel(&self, normalized: *const u16) -> Option<String> {
        if normalized.is_null() { return None; }
        let s = unsafe {
            let mut n = 0;
            while *normalized.add(n) != 0 { n += 1; }
            String::from_utf16_lossy(std::slice::from_raw_parts(normalized, n))
        };
        let s = s.replace('\\', "/");
        let s = if s.len() > 1 && s.as_bytes()[1] == b':' { s[2..].to_string() } else { s };
        let l = s.to_lowercase();
        if l == self.root_norm || !l.starts_with(&format!("{}/", self.root_norm)) { return None; }
        Some(s[self.root_norm.len() + 1..].to_string())
    }

    fn call(&self, c: &Call) -> Result<Value, CallError> { self.server.call(c.tool, c.input.clone()) }

    /// One round: what the server changed, then what the person changed.
    fn pass(&self) -> Result<(), String> {
        let ops = { let mut m = self.mirror.lock().unwrap(); mount::pull(&mut m, &*self.server).map_err(|e| format!("{}: {}", e.code, e.message))? };
        for op in ops { self.show(&op); }
        self.scan(&self.root.clone(), "");
        Ok(())
    }

    fn show(&self, op: &Op) {
        match op {
            Op::Dir { local } => { if let Err(e) = self.create_placeholder(local, "", 0, true) { self.say(&format!("folder {local}: {e}")); } }
            Op::File { local, drive, size, .. } => {
                match self.create_placeholder(local, drive, *size, false) {
                    Ok(()) => {}
                    Err(e) if e == format!("0x{:08X}", E_EXISTS as u32) => { if let Err(e) = self.update_placeholder(local, drive, *size) { self.say(&format!("update {local}: {e}")); } }
                    Err(e) => self.say(&format!("file {local}: {e}")),
                }
            }
            Op::RemoveFile { local } | Op::RemoveDir { local } => {
                let path = self.root.join(local.replace('/', "\\"));
                // a file the person has changed here and not yet sent is theirs to keep; the next scan sends it as a new file
                if self.in_sync(&path) == Some(false) { return; }
                self.quiet.lock().unwrap().insert(local.to_lowercase());
                let _ = if matches!(op, Op::RemoveDir { .. }) { std::fs::remove_dir(&path) } else { std::fs::remove_file(&path) };
            }
        }
    }

    fn create_placeholder(&self, local: &str, drive: &str, size: u64, dir: bool) -> Result<(), String> {
        let (parent, name) = match local.rfind('/') { Some(i) => (&local[..i], &local[i + 1..]), None => ("", local) };
        let base = if parent.is_empty() { self.root.clone() } else { self.root.join(parent.replace('/', "\\")) };
        let name_w = wide(name);
        let id = drive.as_bytes().to_vec();
        let mut info: CF_PLACEHOLDER_CREATE_INFO = unsafe { std::mem::zeroed() };
        info.RelativeFileName = name_w.as_ptr();
        info.FsMetadata = CF_FS_METADATA { BasicInfo: FILE_BASIC_INFO { CreationTime: 0, LastAccessTime: 0, LastWriteTime: 0, ChangeTime: 0, FileAttributes: if dir { FILE_ATTRIBUTE_DIRECTORY } else { FILE_ATTRIBUTE_NORMAL } }, FileSize: if dir { 0 } else { size as i64 } };
        info.FileIdentity = id.as_ptr() as *const c_void;
        info.FileIdentityLength = id.len() as u32;
        // a folder is filled by us, so Windows never asks it to populate (CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION = 1)
        info.Flags = CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC | if dir { 1 } else { 0 };
        let mut done = 0u32;
        let hr = unsafe { CfCreatePlaceholders(wide_path(&base).as_ptr(), &mut info, 1, CF_CREATE_FLAG_NONE, &mut done) };
        if hr < 0 && info.Result == E_EXISTS { return Err(format!("0x{:08X}", E_EXISTS as u32)); }
        ok(hr)?;
        ok(info.Result)
    }

    /// A newer version of a file already here: if it was never opened or is unchanged, make it a cloud-only placeholder of the new size again.
    fn update_placeholder(&self, local: &str, drive: &str, size: u64) -> Result<(), String> {
        let path = self.root.join(local.replace('/', "\\"));
        if self.in_sync(&path) == Some(false) { return Ok(()); }
        let mut h: HANDLE = INVALID_HANDLE_VALUE;
        ok(unsafe { CfOpenFileWithOplock(wide_path(&path).as_ptr(), CF_OPEN_FILE_FLAG_WRITE_ACCESS, &mut h) })?;
        let meta = CF_FS_METADATA { BasicInfo: FILE_BASIC_INFO { CreationTime: 0, LastAccessTime: 0, LastWriteTime: 0, ChangeTime: 0, FileAttributes: FILE_ATTRIBUTE_NORMAL }, FileSize: size as i64 };
        let id = drive.as_bytes();
        let hr = unsafe { CfUpdatePlaceholder(h, &meta, id.as_ptr() as *const c_void, id.len() as u32, std::ptr::null(), 0, CF_UPDATE_FLAG_DEHYDRATE | CF_UPDATE_FLAG_MARK_IN_SYNC, std::ptr::null_mut(), std::ptr::null_mut()) };
        unsafe { CfCloseHandle(h); }
        ok(hr)
    }

    /// Some(true) a placeholder with nothing unsent, Some(false) a placeholder with changes not sent, None not a placeholder (or not there).
    fn in_sync(&self, path: &Path) -> Option<bool> {
        let mut h: HANDLE = INVALID_HANDLE_VALUE;
        if unsafe { CfOpenFileWithOplock(wide_path(path).as_ptr(), CF_OPEN_FILE_FLAG_NONE, &mut h) } < 0 { return None; }
        let mut buf = [0u64; 64];
        let mut got = 0u32;
        let hr = unsafe { CfGetPlaceholderInfo(h, CF_PLACEHOLDER_INFO_BASIC, buf.as_mut_ptr() as *mut c_void, std::mem::size_of_val(&buf) as u32, &mut got) };
        unsafe { CfCloseHandle(h); }
        if hr < 0 { return None; }
        let info = unsafe { &*(buf.as_ptr() as *const CF_PLACEHOLDER_BASIC_INFO) };
        Some(info.InSyncState == CF_IN_SYNC_STATE_IN_SYNC)
    }

    fn mark_in_sync(&self, path: &Path) {
        let mut h: HANDLE = INVALID_HANDLE_VALUE;
        if unsafe { CfOpenFileWithOplock(wide_path(path).as_ptr(), CF_OPEN_FILE_FLAG_WRITE_ACCESS, &mut h) } < 0 { return; }
        unsafe { CfSetInSyncState(h, CF_IN_SYNC_STATE_IN_SYNC, CF_SET_IN_SYNC_FLAG_NONE, std::ptr::null_mut()); CfCloseHandle(h); }
    }

    /// Send what the person made or changed here. Files that are already placeholders and in step are left alone, and a file touched a moment ago waits for the next round.
    fn scan(&self, dir: &Path, rel: &str) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() { self.scan(&entry.path(), &r); continue; }
            if mount::is_transient(&name) { continue; }
            if meta.modified().ok().and_then(|m| m.elapsed().ok()).map_or(true, |e| e < SETTLE) { continue; }
            let state = self.in_sync(&entry.path());
            if state == Some(true) { continue; }
            if let Err(e) = self.send(&entry.path(), &r, state.is_none(), meta.file_size()) { self.say(&format!("send {r}: {e}")); }
        }
    }

    fn send(&self, path: &Path, rel: &str, new: bool, size: u64) -> Result<(), String> {
        let drive = if new { mount::drive_path(rel).map_err(|e| e.to_string())? } else { self.mirror.lock().unwrap().drive_of(rel).ok_or("not known to the server")? };
        let base = if new { None } else { self.mirror.lock().unwrap().version_of(&drive) };
        let fail = |e: CallError| format!("{}: {}", e.code, e.message);
        let out = match mount::upload_plan(size) {
            UploadPlan::One => {
                let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
                self.call(&mount::upload_call(&drive, &bytes, base)).map_err(fail)?
            }
            UploadPlan::Parts(parts) => {
                use std::io::{Read, Seek, SeekFrom};
                let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
                let begun = self.call(&mount::begin_call(&drive, base)).map_err(fail)?;
                let id = begun.get("upload").and_then(Value::as_str).ok_or("no upload id")?.to_string();
                for (i, (off, len)) in parts.iter().enumerate() {
                    let mut buf = vec![0u8; *len];
                    f.seek(SeekFrom::Start(*off)).map_err(|e| e.to_string())?;
                    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
                    if let Err(e) = self.call(&mount::part_call(&id, i, &buf)) {
                        let _ = self.server.call("files.drive.space.upload.abort", serde_json::json!({ "upload": id }));
                        return Err(fail(e));
                    }
                }
                self.call(&mount::commit_call(&id, parts.len())).map_err(fail)?
            }
        };
        let version = out.get("version").and_then(Value::as_u64).ok_or("the server gave no version")?;
        // the file becomes (or stays) a placeholder in step with that version
        if new {
            let f = std::fs::OpenOptions::new().read(true).write(true).share_mode(7).open(path).map_err(|e| e.to_string())?;
            let id = drive.as_bytes();
            ok(unsafe { CfConvertToPlaceholder(f.as_raw_handle() as HANDLE, id.as_ptr() as *const c_void, id.len() as u32, CF_CONVERT_FLAG_MARK_IN_SYNC, std::ptr::null_mut(), std::ptr::null_mut()) })?;
        } else {
            self.mark_in_sync(path);
        }
        let dirs = self.mirror.lock().unwrap().note_written(&drive, version, size);
        let _ = dirs;
        Ok(())
    }

    /// Hydrate: send the bytes Windows asked for, in aligned pieces, read from the server one range at a time.
    fn hydrate(&self, info: &CF_CALLBACK_INFO, offset: i64, length: i64) {
        let drive = unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(info.FileIdentity as *const u8, info.FileIdentityLength as usize)).to_string() };
        let version = self.mirror.lock().unwrap().version_of(&drive);
        let total = info.FileSize;
        let start = offset / PAGE * PAGE;
        let end = std::cmp::min(((offset + length + PAGE - 1) / PAGE) * PAGE, total);
        let transfer = |off: i64, bytes: Option<&[u8]>, len: i64, status: i32| {
            let op = CF_OPERATION_INFO { StructSize: std::mem::size_of::<CF_OPERATION_INFO>() as u32, Type: CF_OPERATION_TYPE_TRANSFER_DATA, ConnectionKey: info.ConnectionKey, TransferKey: info.TransferKey, CorrelationVector: info.CorrelationVector, SyncStatus: std::ptr::null(), RequestKey: info.RequestKey };
            let mut p: CF_OPERATION_PARAMETERS = unsafe { std::mem::zeroed() };
            p.ParamSize = std::mem::size_of::<CF_OPERATION_PARAMETERS>() as u32;
            p.Anonymous.TransferData = CF_OPERATION_PARAMETERS_0_6 { Flags: 0, CompletionStatus: status, Buffer: bytes.map_or(std::ptr::null(), |b| b.as_ptr() as *const c_void), Offset: off, Length: len };
            unsafe { CfExecute(&op, &mut p) }
        };
        let Some(version) = version else { transfer(offset, None, length, STATUS_UNSUCCESSFUL); return };
        let mut at = start;
        while at < end {
            let len = std::cmp::min(mount::PART as i64, end - at);
            let got = self.call(&mount::read_call(&drive, version, at as u64, len as usize)).ok()
                .and_then(|v| v.get("base64").and_then(Value::as_str).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok()));
            match got {
                Some(bytes) if !bytes.is_empty() => {
                    let n = bytes.len() as i64;
                    // a piece that is not the file's last must be a whole number of pages
                    let n = if at + n < total { n / PAGE * PAGE } else { n };
                    if n == 0 { transfer(offset, None, length, STATUS_UNSUCCESSFUL); return; }
                    if transfer(at, Some(&bytes[..n as usize]), n, 0) < 0 { return; }
                    at += n;
                }
                _ => { transfer(offset, None, length, STATUS_UNSUCCESSFUL); return; }
            }
        }
    }

    /// The person deleted something in Explorer: it goes to the server's trash.
    fn deleted(&self, rel: &str) {
        if self.quiet.lock().unwrap().remove(&rel.to_lowercase()) { return; }
        let targets: Vec<String> = {
            let m = self.mirror.lock().unwrap();
            match m.drive_of(rel) { Some(d) => vec![d], None => m.files_under(rel).into_iter().map(|(d, _)| d).collect() }
        };
        for drive in targets {
            match self.server.call("files.drive.space.trash", serde_json::json!({ "path": drive })) {
                Ok(_) => self.mirror.lock().unwrap().note_gone(&drive),
                Err(e) => self.say(&format!("trash {drive}: {}", e.code)),
            }
        }
    }

    /// The person renamed or moved something in Explorer.
    fn renamed(&self, from_rel: Option<String>, to_rel: Option<String>) {
        let (Some(from), Some(to)) = (from_rel, to_rel) else { return };
        let pairs: Vec<(String, String)> = {
            let m = self.mirror.lock().unwrap();
            if m.drive_of(&from).is_some() { vec![(from.clone(), to.clone())] }
            else { m.files_under(&from).into_iter().map(|(_, local)| { let tail = &local[from.len()..]; (local.clone(), format!("{to}{tail}")) }).collect() }
        };
        for (f, t) in pairs {
            let call = { let m = self.mirror.lock().unwrap(); mount::move_call(&m, &f, &t) };
            match call {
                Ok(Some(c)) => match self.call(&c) {
                    Ok(v) => {
                        let (old, new_drive) = { let m = self.mirror.lock().unwrap(); (m.drive_of(&f), c.input.get("to").and_then(Value::as_str).map(String::from)) };
                        if let (Some(old), Some(nd)) = (old, new_drive) {
                            let mut m = self.mirror.lock().unwrap();
                            let size = m.size_of(&old).unwrap_or(0);
                            m.note_gone(&old);
                            m.note_written(&nd, v.get("version").and_then(Value::as_u64).unwrap_or(1), size);
                        }
                    }
                    Err(e) => self.say(&format!("move {f}: {}", e.code)),
                },
                Ok(None) => {}
                Err(e) => self.say(&format!("move {f}: {e}")),
            }
        }
    }
}

unsafe fn state_of<'a>(info: *const CF_CALLBACK_INFO) -> &'a State { &*((*info).CallbackContext as *const State) }

unsafe extern "system" fn on_fetch(info: *const CF_CALLBACK_INFO, params: *const CF_CALLBACK_PARAMETERS) {
    let fd = (*params).Anonymous.FetchData;
    state_of(info).hydrate(&*info, fd.RequiredFileOffset, fd.RequiredLength);
}

unsafe extern "system" fn on_delete_completion(info: *const CF_CALLBACK_INFO, _params: *const CF_CALLBACK_PARAMETERS) {
    let s = state_of(info);
    if let Some(rel) = s.rel((*info).NormalizedPath) { s.deleted(&rel); }
}

unsafe extern "system" fn on_rename_completion(info: *const CF_CALLBACK_INFO, params: *const CF_CALLBACK_PARAMETERS) {
    let s = state_of(info);
    let from = s.rel((*params).Anonymous.RenameCompletion.SourcePath);
    let to = s.rel((*info).NormalizedPath);
    match (&from, &to) {
        (Some(_), Some(_)) => s.renamed(from, to),
        // moved out of the folder: the server's copy goes to the trash
        (Some(f), None) => s.deleted(f),
        // moved in from elsewhere: the next scan sends it as a new file
        _ => {}
    }
}
