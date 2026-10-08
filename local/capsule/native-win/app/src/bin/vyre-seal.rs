//! vyre-seal.exe: the Windows sealing service's helper (spec part 5, ruled 8 Oct). It runs as the virtual service account NT SERVICE\VyreSealer, so the sealing key and the sealed data belong to an account
//! the person's own programs do not run as (a same-user program can open and read another same-user process and its files). It does four things:
//!   install      (elevated, once) make the service and its folder, write its config, start it
//!   uninstall    (elevated) stop and remove the service (--purge also deletes what it sealed)
//!   service      the service's own entry point (started by Windows)
//!   serve        the same loop in the foreground, as the current user, for a test (no service, no account change)
//!   status       is the service installed and running
//! The loop: a named pipe with an access list of the service, the one installing user and SYSTEM; each client that connects is checked to be the installed Node; a sealing process (kernel/seal/process.js) is started
//! for it under this account with the master key (opened from its DPAPI blob) in its environment; bytes are relayed both ways; the process ends with the connection. Pure rules: vyre_capsule_win::sealsvc.

#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(not(windows))]
fn main() { eprintln!("vyre-seal runs on Windows only"); std::process::exit(2); }

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

    use sha2::{Digest, Sha256};
    use vyre_capsule_win::sealsvc::{self, Config};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId};
    use windows_sys::Win32::System::Services::{RegisterServiceCtrlHandlerExW, SetServiceStatus, StartServiceCtrlDispatcherW, SERVICE_STATUS, SERVICE_TABLE_ENTRYW};
    use windows_sys::Win32::System::Threading::{CreateEventW, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const PIPE_ACCESS_DUPLEX: u32 = 3;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const PIPE_TYPE_BYTE: u32 = 0;
    const PIPE_READMODE_BYTE: u32 = 0;
    const PIPE_WAIT: u32 = 0;
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 8;
    const ERROR_IO_PENDING: u32 = 997;
    const ERROR_PIPE_CONNECTED: u32 = 535;
    const ERROR_BROKEN_PIPE: u32 = 109;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const SERVICE_WIN32_OWN_PROCESS: u32 = 0x10;
    const SERVICE_START_PENDING: u32 = 2;
    const SERVICE_RUNNING: u32 = 4;
    const SERVICE_STOPPED: u32 = 1;
    const SERVICE_ACCEPT_STOP: u32 = 1;
    const SERVICE_CONTROL_STOP: u32 = 1;
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 1;

    fn w(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
    fn sys(rel: &str) -> String { format!("{}\\{rel}", std::env::var("SystemRoot").ok().filter(|r| r.len() >= 3 && r.as_bytes()[1] == b':').unwrap_or_else(|| "C:\\Windows".into())) }
    fn program_data() -> String { std::env::var("ProgramData").ok().filter(|r| r.len() >= 3 && r.as_bytes()[1] == b':').unwrap_or_else(|| "C:\\ProgramData".into()) }
    pub fn default_seal_dir() -> String { format!("{}\\Vyre\\seal", program_data()) }
    fn config_path(seal_dir: &str) -> String { format!("{seal_dir}\\config.json") }
    fn log_path() -> String { format!("{}\\Vyre\\logs\\vyre-seal.log", program_data()) }

    fn log(line: &str) {
        let p = log_path();
        if let Some(d) = std::path::Path::new(&p).parent() { let _ = std::fs::create_dir_all(d); }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = writeln!(f, "{t} {}", line.chars().filter(|c| !c.is_control()).take(300).collect::<String>());
        }
    }

    // ---- DPAPI: the master is sealed under THIS account (the service's), so another account's DPAPI cannot open it ----
    fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        let ok = unsafe {
            if protect { CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
            else { CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        };
        if ok == 0 { return Err(format!("Windows data protection refused (error {})", unsafe { GetLastError() })); }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as _) };
        Ok(v)
    }

    /// The 32-byte master: opened from master.dpapi in the seal folder, made on the first start.
    fn master(seal_dir: &str) -> Result<[u8; 32], String> {
        let f = format!("{seal_dir}\\master.dpapi");
        if let Ok(blob) = std::fs::read(&f) {
            let raw = dpapi(&blob, false)?;
            return raw.try_into().map_err(|_| "the sealed master is not 32 bytes".to_string());
        }
        use rand::RngCore;
        let mut k = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut k);
        let tmp = format!("{f}.{}.tmp", std::process::id());
        std::fs::write(&tmp, dpapi(&k, true)?).map_err(|e| format!("could not save the sealed master: {e}"))?;
        std::fs::rename(&tmp, &f).map_err(|e| format!("could not save the sealed master: {e}"))?;
        Ok(k)
    }

    // ---- the pipe, in overlapped mode so one handle can read and write at the same time ----
    #[derive(Clone, Copy)]
    struct Pipe(isize);
    unsafe impl Send for Pipe {}
    impl Pipe { fn h(&self) -> *mut c_void { self.0 as *mut c_void } }

    fn ev() -> *mut c_void { unsafe { CreateEventW(null(), 1, 0, null()) } }

    /// One overlapped transfer on the pipe: waits for it, answers the bytes moved (0 at the end of the pipe).
    fn io(p: Pipe, buf: *mut u8, len: u32, read: bool, event: *mut c_void) -> std::io::Result<usize> {
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = event;
        let mut n: u32 = 0;
        let ok = unsafe { if read { ReadFile(p.h(), buf as _, len, &mut n, &mut ov) } else { WriteFile(p.h(), buf as _, len, &mut n, &mut ov) } };
        if ok == 0 {
            let e = unsafe { GetLastError() };
            if e == ERROR_IO_PENDING {
                if unsafe { GetOverlappedResult(p.h(), &ov, &mut n, 1) } == 0 {
                    let e2 = unsafe { GetLastError() };
                    if e2 == ERROR_BROKEN_PIPE { return Ok(0); }
                    return Err(std::io::Error::from_raw_os_error(e2 as i32));
                }
            } else if e == ERROR_BROKEN_PIPE { return Ok(0); }
            else { return Err(std::io::Error::from_raw_os_error(e as i32)); }
        }
        Ok(n as usize)
    }

    fn make_pipe(sddl: &str, first: bool) -> Result<Pipe, String> {
        let mut psd: *mut c_void = null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(w(sddl).as_ptr(), 1, &mut psd, null_mut()) } == 0 { return Err(format!("the pipe's access list was refused (error {})", unsafe { GetLastError() })); }
        let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: psd, bInheritHandle: 0 };
        let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
        let open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
        let h = unsafe { CreateNamedPipeW(w(sealsvc::PIPE).as_ptr(), open, mode, 1, 64 * 1024, 64 * 1024, 0, &sa) };
        unsafe { LocalFree(psd) };
        if h as isize == -1 { return Err(format!("could not create the pipe (error {}); another program may hold the name", unsafe { GetLastError() })); }
        Ok(Pipe(h as isize))
    }

    /// Wait for a client on this instance (overlapped). Already-connected is success.
    fn wait_client(p: Pipe) -> Result<(), String> {
        let event = ev();
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = event;
        let ok = unsafe { ConnectNamedPipe(p.h(), &mut ov) };
        let r = if ok != 0 { Ok(()) } else {
            let e = unsafe { GetLastError() };
            if e == ERROR_PIPE_CONNECTED { Ok(()) }
            else if e == ERROR_IO_PENDING { unsafe { WaitForSingleObject(event, INFINITE) }; Ok(()) }
            else { Err(format!("waiting for a client failed (error {e})")) }
        };
        unsafe { CloseHandle(event) };
        r
    }

    fn client_image(p: Pipe) -> String {
        let mut pid: u32 = 0;
        if unsafe { GetNamedPipeClientProcessId(p.h(), &mut pid) } == 0 { return String::new(); }
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() { return String::new(); }
        let mut buf = vec![0u16; 1024];
        let mut n = buf.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut n) };
        unsafe { CloseHandle(h) };
        if ok == 0 { String::new() } else { String::from_utf16_lossy(&buf[..n as usize]) }
    }

    fn sha256_file(path: &str) -> Result<String, String> {
        let b = std::fs::read(path).map_err(|e| format!("could not read {path}: {e}"))?;
        Ok(Sha256::digest(&b).iter().map(|x| format!("{x:02x}")).collect())
    }

    /// One client: relay between the pipe and a fresh sealing process; it ends with the connection.
    fn session(p: Pipe, cfg: &Config, master_b64: &str) {
        let image = client_image(p);
        if !sealsvc::same_image(&image, &cfg.node) { log(&format!("refused a client that is not the installed Node: {image}")); return; }
        match sha256_file(&cfg.node) { Ok(h) if h.eq_ignore_ascii_case(&cfg.node_sha256) => {}, Ok(_) => { log("refused: the installed Node's hash is not the pinned one"); return; }, Err(e) => { log(&e); return; } }
        let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let mut cmd = Command::new(&cfg.node);
        cmd.arg(&cfg.process_js).env_clear().creation_flags(CREATE_NO_WINDOW).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        for (k, v) in sealsvc::child_env(master_b64, &cfg.seal_dir, &sys_root) { cmd.env(k, v); }
        let mut child = match cmd.spawn() { Ok(c) => c, Err(e) => { log(&format!("could not start the sealing process: {e}")); return; } };
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        // child output -> pipe
        let writer = std::thread::spawn(move || {
            let event = ev();
            let mut buf = [0u8; 16 * 1024];
            loop {
                match stdout.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => { let mut off = 0; while off < n { match io(p, buf[off..].as_mut_ptr(), (n - off) as u32, false, event) { Ok(0) | Err(_) => { unsafe { CloseHandle(event) }; return; }, Ok(m) => off += m } } } }
            }
            unsafe { CloseHandle(event) };
        });
        // pipe -> child input
        let event = ev();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match io(p, buf.as_mut_ptr(), buf.len() as u32, true, event) { Ok(0) | Err(_) => break, Ok(n) => { if stdin.write_all(&buf[..n]).and_then(|_| stdin.flush()).is_err() { break; } } }
        }
        unsafe { CloseHandle(event) };
        drop(stdin); // the sealing process ends when its input does
        let t0 = std::time::Instant::now();
        loop { match child.try_wait() { Ok(Some(_)) => break, _ if t0.elapsed().as_secs() > 3 => { let _ = child.kill(); break; } _ => std::thread::sleep(std::time::Duration::from_millis(50)) } }
        let _ = writer.join();
    }

    static STOP: AtomicBool = AtomicBool::new(false);

    /// The serve loop. `cfg` is trusted only after validation; the master is opened once.
    pub fn serve(cfg: &Config) -> Result<(), String> {
        cfg.validate().map_err(|e| format!("the config is not valid ({e})"))?;
        std::fs::create_dir_all(&cfg.seal_dir).map_err(|e| format!("seal folder: {e}"))?;
        let m = master(&cfg.seal_dir)?;
        use base64::Engine;
        let master_b64 = base64::engine::general_purpose::STANDARD.encode(m);
        let sddl = sealsvc::pipe_sddl(&cfg.service_sid, &cfg.user_sid).map_err(|e| format!("pipe access list ({e})"))?;
        let mut first = true;
        while !STOP.load(Ordering::SeqCst) {
            let p = make_pipe(&sddl, first)?;
            first = false;
            if wait_client(p).is_ok() { session(p, cfg, &master_b64); }
            unsafe { DisconnectNamedPipe(p.h()); CloseHandle(p.h()) };
            // The next instance is made by name again; there is a moment with no instance at all, in which another program could take the name: it could not have been made first (FIRST_PIPE_INSTANCE
            // was set for the service's own first), and the client refuses a server that is not the installed service (the walk's check). The gap is a known limit, written in docs.
        }
        Ok(())
    }

    // ---- the Windows service entry ----
    static STATUS_HANDLE: AtomicIsize = AtomicIsize::new(0);

    fn set_state(state: u32, accepts: u32) {
        let st = SERVICE_STATUS { dwServiceType: SERVICE_WIN32_OWN_PROCESS, dwCurrentState: state, dwControlsAccepted: accepts, dwWin32ExitCode: 0, dwServiceSpecificExitCode: 0, dwCheckPoint: 0, dwWaitHint: 0 };
        unsafe { SetServiceStatus(STATUS_HANDLE.load(Ordering::SeqCst) as _, &st) };
    }

    unsafe extern "system" fn handler(control: u32, _t: u32, _d: *mut c_void, _c: *mut c_void) -> u32 {
        if control == SERVICE_CONTROL_STOP {
            STOP.store(true, Ordering::SeqCst);
            set_state(SERVICE_STOPPED, 0);
            // The loop is blocked waiting for a client; ending the process closes the pipe and the sealing process's input.
            std::process::exit(0);
        }
        0
    }

    unsafe extern "system" fn service_main(_argc: u32, _argv: *mut *mut u16) {
        let h = RegisterServiceCtrlHandlerExW(w(sealsvc::SERVICE).as_ptr(), Some(handler), null());
        STATUS_HANDLE.store(h as isize, Ordering::SeqCst);
        set_state(SERVICE_START_PENDING, 0);
        let dir = default_seal_dir();
        let cfg = std::fs::read_to_string(config_path(&dir)).map_err(|e| format!("no config: {e}")).and_then(|t| Config::parse(&t).map_err(|e| format!("bad config ({e})")));
        match cfg {
            Ok(cfg) => { set_state(SERVICE_RUNNING, SERVICE_ACCEPT_STOP); log("service running"); if let Err(e) = serve(&cfg) { log(&format!("service stopped: {e}")); } }
            Err(e) => log(&format!("service could not start: {e}")),
        }
        set_state(SERVICE_STOPPED, 0);
    }

    pub fn run_service() -> i32 {
        let mut name = w(sealsvc::SERVICE);
        let table = [SERVICE_TABLE_ENTRYW { lpServiceName: name.as_mut_ptr(), lpServiceProc: Some(service_main) }, SERVICE_TABLE_ENTRYW { lpServiceName: null_mut(), lpServiceProc: None }];
        if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 { log(&format!("not started by Windows (error {})", unsafe { GetLastError() })); return 1; }
        0
    }

    // ---- install, uninstall, status: the elevated, once-only part ----
    fn run(program: &str, args: &[&str]) -> Result<String, String> {
        let out = Command::new(program).args(args).creation_flags(CREATE_NO_WINDOW).output().map_err(|e| format!("{program}: {e}"))?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        if out.status.success() { Ok(text) } else { Err(format!("{program} {} failed: {}", args.join(" "), text.trim())) }
    }
    fn sc(args: &[&str]) -> Result<String, String> { run(&sys("System32\\sc.exe"), args) }

    fn service_sid() -> Result<String, String> {
        let out = sc(&["showsid", sealsvc::SERVICE])?;
        out.split_whitespace().find(|t| sealsvc::valid_sid(t)).map(|s| s.to_string()).ok_or_else(|| format!("no service SID in: {}", out.trim()))
    }

    pub fn install(args: &[String]) -> Result<(), String> {
        let user_sid = sealsvc::install_args(args).map_err(|e| format!("install needs --user-sid <SID> ({e})"))?;
        let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
        let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().to_string();
        let node = arg("--node").ok_or("install needs --node <path to node.exe>")?;
        let process_js = arg("--process-js").ok_or("install needs --process-js <path to kernel\\seal\\process.js>")?;
        let seal_dir = arg("--seal-dir").unwrap_or_else(default_seal_dir);
        let bin = sealsvc::service_bin_path(&exe).map_err(|e| format!("helper path ({e})"))?;
        // the service (its virtual account is made by Windows when the service is created)
        let _ = sc(&["stop", sealsvc::SERVICE]);
        let _ = sc(&["delete", sealsvc::SERVICE]);
        sc(&["create", sealsvc::SERVICE, "binPath=", &bin, "obj=", sealsvc::SERVICE_ACCOUNT, "start=", "auto", "type=", "own", "DisplayName=", "Vyre sealing service"])?;
        let _ = sc(&["description", sealsvc::SERVICE, "Holds the key to what Vyre seals, under an account of its own"]);
        let _ = sc(&["failure", sealsvc::SERVICE, "reset=", "86400", "actions=", "restart/5000/restart/5000/restart/5000"]);
        let svc_sid = service_sid()?;
        let cfg = Config { node_sha256: sha256_file(&node)?, node, process_js, seal_dir: seal_dir.clone(), service_sid: svc_sid, user_sid };
        cfg.validate().map_err(|e| format!("install settings ({e})"))?;
        std::fs::create_dir_all(&seal_dir).map_err(|e| e.to_string())?;
        std::fs::write(config_path(&seal_dir), cfg.to_json()).map_err(|e| e.to_string())?;
        // the folder is the service's alone, set after the config is in it
        for a in sealsvc::seal_dir_icacls(&seal_dir, sealsvc::SERVICE_ACCOUNT) { let refs: Vec<&str> = a.iter().map(|s| s.as_str()).collect(); run(&sys("System32\\icacls.exe"), &refs)?; }
        sc(&["start", sealsvc::SERVICE])?;
        Ok(())
    }

    pub fn uninstall(purge: bool) -> Result<(), String> {
        let _ = sc(&["stop", sealsvc::SERVICE]);
        std::thread::sleep(std::time::Duration::from_secs(2));
        sc(&["delete", sealsvc::SERVICE])?;
        if purge { let _ = std::fs::remove_dir_all(default_seal_dir()); }
        Ok(())
    }

    pub fn status() -> String { sc(&["query", sealsvc::SERVICE]).unwrap_or_else(|e| e) }

    pub fn main_inner() -> i32 {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let cmd = args.first().map(|s| s.as_str()).unwrap_or("");
        let r: Result<(), String> = match cmd {
            "service" => return run_service(),
            "install" => install(&args),
            "uninstall" => uninstall(args.iter().any(|a| a == "--purge")),
            "status" => { println!("{}", status()); Ok(()) }
            // serve --config <file>: the loop in the foreground as the current user (a test)
            "serve" => match args.iter().position(|a| a == "--config").and_then(|i| args.get(i + 1)) {
                Some(f) => std::fs::read_to_string(f).map_err(|e| e.to_string()).and_then(|t| Config::parse(&t).map_err(|e| format!("bad config ({e})"))).and_then(|c| serve(&c)),
                None => Err("serve needs --config <file>".into()),
            },
            _ => Err("usage: vyre-seal install --user-sid <SID> --node <node.exe> --process-js <process.js> | uninstall [--purge] | status | service | serve --config <file>".into()),
        };
        match r { Ok(()) => 0, Err(e) => { log(&e); eprintln!("vyre-seal: {e}"); 1 } }
    }
}

#[cfg(windows)]
fn main() { std::process::exit(win::main_inner()); }
