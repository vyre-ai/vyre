//! The local core on this PC (#26, v0.2.3): fetch and unpack it once, start it as a per-user process
//! the app owns, ask it things over its named pipe, and stop it when the app quits. Trust decisions
//! are the library's (`core_pkg`, `core_install`, `core_launch`, `core_calls`); this file is the
//! process and pipe plumbing that needs Windows.
//!
//! - never a service and never elevated: a child of this app in a job object, so it dies with the app;
//! - node and the package are pinned and hash-checked at every start (`core_pkg::check_start`);
//! - before a byte goes to the pipe, the app asks Windows which process serves it and compares that
//!   with the handle of the child it started (never a stored pid number, so a reused pid cannot match).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use vyre_capsule_win::{core_calls, core_install, core_launch, core_pkg, history, update};

/// What the person can be told about the core.
#[derive(serde::Serialize, Clone, PartialEq, Debug)]
#[serde(tag = "state", content = "message", rename_all = "lowercase")]
pub enum CoreState { Off, Installing(String), Starting, Up, Failed(String) }

struct Running {
    child: std::process::Child,
    pipe: String,
    #[allow(dead_code)]
    job: imp::Job,
}

pub struct CoreHost {
    /// "Keep them in sync" is on: the core stays up until the person stops it. Remembered across app starts in `sync-core`.
    keep: std::sync::atomic::AtomicBool,
    state: Mutex<CoreState>,
    running: Mutex<Option<Running>>,
    /// One start or install at a time.
    busy: Mutex<()>,
}

impl CoreHost {
    pub fn new() -> CoreHost { CoreHost { keep: std::sync::atomic::AtomicBool::new(false), state: Mutex::new(CoreState::Off), running: Mutex::new(None), busy: Mutex::new(()) } }
    pub fn state(&self) -> CoreState { self.state.lock().unwrap().clone() }
    fn set(&self, s: CoreState) { *self.state.lock().unwrap() = s; }

    /// Stop the core (the app is quitting, or the person asked). Killing the child ends its job too.
    pub fn stop(&self) {
        if let Some(mut r) = self.running.lock().unwrap().take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
        self.set(CoreState::Off);
    }

    /// Make sure the core is installed and running, and say how it went in plain words.
    pub fn ensure(&self, app: &AppHandle) -> Result<(), String> {
        let _one = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = self.running.lock().unwrap().as_mut() {
            if matches!(r.child.try_wait(), Ok(None)) { return Ok(()); }
        }
        self.stop();
        let run = || -> Result<(), String> {
            let paths = Paths::new(app)?;
            self.set(CoreState::Installing("Getting Vyre's local helper".into()));
            let dir = ensure_installed(&paths)?;
            self.set(CoreState::Starting);
            let running = start(&paths, &dir)?;
            *self.running.lock().unwrap() = Some(running);
            Ok(())
        };
        match run() {
            Ok(()) => { self.set(CoreState::Up); Ok(()) }
            Err(e) => { self.set(CoreState::Failed(e.clone())); Err(e) }
        }
    }

    /// One call to one allowed tool, on the core's pipe.
    pub fn call(&self, tool: &str, input: &serde_json::Value) -> Result<serde_json::Value, String> {
        let req = core_calls::request(tool, input)?;
        let out = {
            let guard = self.running.lock().unwrap();
            let r = guard.as_ref().ok_or("Vyre's local helper is not running.")?;
            core_calls::parse_response(&imp::exchange(&r.child, &r.pipe, &req)?)?
        };
        Ok(out)
    }

    /// Note a sync import started or stopped, so the core is kept up (or let go) accordingly.
    pub fn note_sync(&self, app: &AppHandle, on: bool) {
        self.keep.store(on, std::sync::atomic::Ordering::SeqCst);
        if let Ok(dir) = app.path().app_local_data_dir() {
            let marker = dir.join("sync-core");
            if on { let _ = std::fs::create_dir_all(&dir); let _ = std::fs::write(&marker, b"1"); } else { let _ = std::fs::remove_file(&marker); }
        }
    }

    /// At app start: a sync import the person asked for before gets its core back.
    pub fn restore_sync(&self, app: &AppHandle) -> bool {
        let on = app.path().app_local_data_dir().map(|d| d.join("sync-core").is_file()).unwrap_or(false);
        self.keep.store(on, std::sync::atomic::Ordering::SeqCst);
        on
    }

    /// The import screen closed: stop the core unless a send is running or sync is kept on, because it holds about 90 MB.
    pub fn let_go_if_idle(&self) {
        if self.keep.load(std::sync::atomic::Ordering::SeqCst) { return; }
        let sending = self.call("import.status", &serde_json::json!({})).ok().and_then(|s| s["upload"]["state"].as_str().map(|x| x == "sending")).unwrap_or(false);
        if !sending { self.stop(); }
    }
}

struct Paths {
    /// %LOCALAPPDATA%\Vyre\core (versions live under it)
    core_root: PathBuf,
    /// The core's data: the person's own .vyre, so a `vyre` typed in WSL-less Windows and the app agree.
    home: PathBuf,
    user: PathBuf,
}

impl Paths {
    fn new(app: &AppHandle) -> Result<Paths, String> {
        let user = app.path().home_dir().map_err(|e| e.to_string())?;
        let core_root = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("core");
        Ok(Paths { core_root, home: user.join(".vyre"), user })
    }
}

/// What `Vyre.exe --core-selftest` reports.
pub struct SelfTest { pub lines: Vec<String> }

/// `Vyre.exe --core-selftest <work folder> <vyre.tgz> <node zip> <out>` with VYRE_SELFTEST=1: installs a
/// package and a Node zip from files (the pinned Node hash is still checked; the package's signed hash is
/// the release's, so a local package is only ever taken here), starts the core under a throwaway user
/// folder with synthetic Claude Code sessions, asks it for its status and a scan, and stops it. It touches
/// no real home, pairing or key.
pub fn selftest(work: &Path, pkg: &Path, node_zip: &Path) -> SelfTest {
    let mut lines = vec![];
    let mut note = |name: &str, r: Result<String, String>| lines.push(match r { Ok(d) => format!("pass {name} {d}"), Err(e) => format!("FAIL {name} {e}") });
    let user = work.join("user");
    let paths = Paths { core_root: work.join("core"), home: user.join(".vyre"), user: user.clone() };
    let fixture = (|| -> Result<(), String> {
        let proj = user.join(".claude").join("projects").join("C--Work-demo");
        std::fs::create_dir_all(&proj).map_err(|e| e.to_string())?;
        std::fs::write(proj.join("11111111-1111-4111-8111-111111111111.jsonl"), "{\"type\":\"user\",\"cwd\":\"C:\\\\Work\\\\demo\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n").map_err(|e| e.to_string())
    })();
    note("fixture", fixture.map(|_| "one synthetic session".into()));
    let (Ok(pkg_bytes), Ok(zip_bytes)) = (std::fs::read(pkg), std::fs::read(node_zip)) else { note("inputs", Err("cannot read the package or the Node zip".into())); return SelfTest { lines } };
    let host = CoreHost::new();
    let dir = core_install::install(&paths.core_root, "0.0.1-selftest.1", &pkg_bytes, &zip_bytes);
    note("install", dir.as_ref().map(|d| d.display().to_string()).map_err(|e| e.clone()));
    let Ok(dir) = dir else { return SelfTest { lines } };
    note("start-check", core_pkg::check_start(&dir).map(|_| "ok".into()));
    let started = start_with(&paths, &dir, &|k| match k {
        "USERPROFILE" => Some(user.to_string_lossy().to_string()),
        // The core treats only the account's own ~/.vyre as the person's, and a throwaway folder is not, so it is told where Claude Code's folder is.
        "VYRE_CLAUDE_HOME" => Some(user.join(".claude").to_string_lossy().to_string()),
        _ => std::env::var(k).ok(),
    });
    note("start", started.as_ref().map(|_| "up".into()).map_err(|e| e.clone()));
    if let Ok(r) = started {
        *host.running.lock().unwrap() = Some(r);
        note("health", {
            let g = host.running.lock().unwrap();
            let r = g.as_ref().unwrap();
            imp::exchange(&r.child, &r.pipe, &core_calls::health_request()).and_then(|raw| core_calls::parse_response(&raw)).map(|v| format!("rss {} MB, {} modules running, role {}", v["memory"]["rss"], v["modules"]["running"], v["role"]))
        });
        note("status", host.call("import.status", &serde_json::json!({})).map(|v| v.to_string().chars().take(120).collect()));
        note("scan", host.call("import.scan", &serde_json::json!({})).and_then(|v| {
            let n = v["sources"].as_array().map(|a| a.iter().map(|s| s["sessions"].as_u64().unwrap_or(0)).sum::<u64>()).unwrap_or(0);
            if n >= 1 { Ok(format!("{n} session(s) found")) } else { Err(format!("found none: {}", v.to_string().chars().take(700).collect::<String>())) }
        }));
        // The calls the import screen makes, in its order. There is no server here, so Send must come back refused in plain words.
        let plan = host.call("import.plan", &serde_json::json!({ "include": ["C:\\Work\\demo"] }));
        note("plan", plan.as_ref().map_err(|e| e.clone()).and_then(|p| if p["sessions"] == 1 { Ok(format!("{} session, pace {}", p["sessions"], p["pace"])) } else { Err(p.to_string()) }));
        if let Ok(p) = plan {
            let id = p["plan"].as_str().unwrap_or("").to_string();
            note("send-without-a-server", host.call("import.start", &serde_json::json!({ "plan": id, "mode": "once", "pace": "gentle" })).map(|v| format!("UNEXPECTED success {v}")).or_else(|e| Ok::<String, String>(format!("refused: {e}"))));
        }
        note("stop", host.call("import.stop", &serde_json::json!({})).map(|v| v.to_string()));
        note("refused-tool", host.call("vault.get", &serde_json::json!({})).map(|_| "UNEXPECTED success".to_string()).or_else(|e| if e.contains("not a call") { Ok("refused".into()) } else { Err(e) }));
        host.stop();
        note("stopped", if host.running.lock().unwrap().is_none() { Ok("child ended".into()) } else { Err("still running".into()) });
    }
    SelfTest { lines }
}

fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    ureq::get(url).set("User-Agent", "vyre-app").call().map_err(|e| format!("could not download {url}: {e}"))?
        .into_reader().take(limit + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > limit { return Err("a download was larger than expected".into()); }
    Ok(buf)
}

/// The version this app belongs to. A build without a release version has no core to fetch.
fn app_version() -> Result<&'static str, String> {
    option_env!("VYRE_APP_VERSION").ok_or_else(|| "This build of Vyre is not a release, so it has no local helper to download.".to_string())
}

/// The installed folder for this app's version, downloading and checking what is missing.
fn ensure_installed(paths: &Paths) -> Result<PathBuf, String> {
    let version = app_version()?;
    let dir = core_install::version_dir(&paths.core_root, version)?;
    if dir.join("core.lock").is_file() { return Ok(dir); }
    let base = update::release_base(&format!("v{version}"));
    let sums = fetch(&format!("{base}/SHA256SUMS"), 1 << 20)?;
    let sig = String::from_utf8(fetch(&format!("{base}/SHA256SUMS.sig"), 4096)?).map_err(|_| "the release signature is not text")?;
    let listed = update::verify_sums(&sums, &sig, update::RELEASE_KEY)?;
    let pkg = fetch(&format!("{base}/{}", core_install::PACKAGE_ASSET), 150 << 20)?;
    update::check_file(&listed, core_install::PACKAGE_ASSET, &pkg)?;
    let node = fetch(&core_pkg::node_zip_url(), 120 << 20)?;
    let dir = core_install::install(&paths.core_root, version, &pkg, &node)?;
    core_install::prune(&paths.core_root, version);
    Ok(dir)
}

fn start(paths: &Paths, dir: &Path) -> Result<Running, String> { start_with(paths, dir, &|k| std::env::var(k).ok()) }

fn start_with(paths: &Paths, dir: &Path, get: &dyn Fn(&str) -> Option<String>) -> Result<Running, String> {
    core_pkg::check_start(dir)?;
    std::fs::create_dir_all(&paths.home).map_err(|e| format!("cannot make {}: {e}", paths.home.display()))?;
    let real_home = std::fs::canonicalize(&paths.home).map_err(|e| e.to_string())?;
    let real_home_plain = PathBuf::from(core_pkg::plain_path(&real_home));
    // A fresh token for this launch; the core reads it from the same file when it builds its pipe name.
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    let token = core_launch::token_from(&b);
    std::fs::write(real_home_plain.join("pipe-token"), &token).map_err(|e| format!("cannot write the pipe token: {e}"))?;
    let pipe = core_pkg::pipe_name(&real_home_plain.to_string_lossy(), &token);
    let roots: Vec<PathBuf> = history::agent_roots(get, &paths.user).into_iter().map(|r| r.path).collect();
    let args = core_launch::node_args(dir, &real_home_plain, &roots, &pipe)?;
    let env = core_launch::env(get, &real_home_plain);
    let log = std::fs::OpenOptions::new().create(true).append(true).open(real_home_plain.join("core.log")).map_err(|e| e.to_string())?;
    let (child, job) = imp::spawn(&dir.join("node").join("node.exe"), &args, &env, log)?;
    let mut running = Running { child, pipe, job };
    wait_ready(&mut running, &real_home_plain)?;
    Ok(running)
}

/// The core is ready when it answers its health check on its own pipe, served by our child.
fn wait_ready(r: &mut Running, home: &Path) -> Result<(), String> {
    let started = std::time::Instant::now();
    let ask = core_calls::health_request();
    loop {
        if let Ok(Some(status)) = r.child.try_wait() {
            return Err(format!("Vyre's local helper stopped as it started ({status}). {}", log_tail(home)));
        }
        if let Ok(raw) = imp::exchange(&r.child, &r.pipe, &ask) {
            if core_calls::parse_response(&raw).is_ok() { return Ok(()); }
        }
        if started.elapsed() > std::time::Duration::from_secs(45) {
            let _ = r.child.kill();
            return Err(format!("Vyre's local helper did not start in time. {}", log_tail(home)));
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

fn log_tail(home: &Path) -> String {
    let text = std::fs::read_to_string(home.join("core.log")).unwrap_or_default();
    let last: Vec<&str> = text.lines().rev().take(3).collect();
    last.into_iter().rev().collect::<Vec<_>>().join(" ").chars().filter(|c| !c.is_control() || *c == ' ').take(300).collect()
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::GetProcessId;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// A job whose last handle closing ends every process in it: the core cannot outlive the app.
    pub struct Job(HANDLE);
    unsafe impl Send for Job {}
    impl Drop for Job { fn drop(&mut self) { unsafe { CloseHandle(self.0) }; } }

    fn job_for(child: &std::process::Child) -> Result<Job, String> {
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() { return Err("Windows would not make a job for the local helper.".into()); }
            let job = Job(h);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32) == 0
                || AssignProcessToJobObject(h, child.as_raw_handle() as HANDLE) == 0 {
                return Err("Windows would not tie the local helper to Vyre.".into());
            }
            Ok(job)
        }
    }

    pub fn spawn(node: &Path, args: &[String], env: &[(String, String)], log: std::fs::File) -> Result<(std::process::Child, Job), String> {
        let log2 = log.try_clone().map_err(|e| e.to_string())?;
        let mut cmd = std::process::Command::new(node);
        cmd.args(args).env_clear().envs(env.iter().map(|(k, v)| (k, v))).stdin(std::process::Stdio::piped())
            .stdout(log).stderr(log2).creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| format!("Vyre's local helper would not start: {e}"))?;
        match job_for(&child) {
            Ok(job) => Ok((child, job)),
            Err(e) => { let _ = child.kill(); Err(e) }
        }
    }

    fn open_pipe(name: &str) -> Result<std::fs::File, String> {
        let mut last = String::new();
        for _ in 0..40 {
            match std::fs::OpenOptions::new().read(true).write(true).open(name) {
                Ok(f) => return Ok(f),
                Err(e) => { last = e.to_string(); std::thread::sleep(std::time::Duration::from_millis(100)); }
            }
        }
        Err(format!("could not reach Vyre's local helper ({last})"))
    }

    /// Open the pipe, check that our child serves it, send one request and read the whole answer.
    pub fn exchange(child: &std::process::Child, pipe: &str, request: &[u8]) -> Result<Vec<u8>, String> {
        let mut f = open_pipe(pipe)?;
        let mut server = 0u32;
        let ok = unsafe { GetNamedPipeServerProcessId(f.as_raw_handle() as HANDLE, &mut server) };
        let ours = unsafe { GetProcessId(child.as_raw_handle() as HANDLE) };
        if ok == 0 || ours == 0 || server != ours {
            return Err("Something other than Vyre's local helper answered, so nothing was sent to it.".into());
        }
        f.write_all(request).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        f.take(core_calls::MAX_RESPONSE as u64 + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
        if out.len() > core_calls::MAX_RESPONSE { return Err("the local helper's answer was larger than expected".into()); }
        Ok(out)
    }
}

// Off Windows this exists so the crate type-checks for local runs; the core is never started there.
#[cfg(not(windows))]
mod imp {
    use super::*;
    pub struct Job;
    pub fn spawn(_: &Path, _: &[String], _: &[(String, String)], _: std::fs::File) -> Result<(std::process::Child, Job), String> { Err("The local helper runs only on Windows.".into()) }
    pub fn exchange(_: &std::process::Child, _: &str, _: &[u8]) -> Result<Vec<u8>, String> { Err("The local helper runs only on Windows.".into()) }
}
