//! `vyre-pipe-verify <pipe-path>`: before the CLI/Capsule sends anything over vyred's named pipe,
//! confirm the pipe's owning process is running as the current user. Exit 0 only on a proven
//! match (`vyre_pipe_verify::Verdict::exit_code`); every other case, including a Win32 call
//! failing partway through, exits non-zero. See docs/design/windows-plan.md section 7a point 2c.
//!
//! Real testing happens on `windows-latest` CI (.github/workflows/windows-pipe-verify.yml), the
//! same discipline as every other Windows-only piece in this plan: nothing here runs for real
//! off Windows. `lib.rs`'s comparison/verdict logic is unit-tested on any platform; this file is
//! only the Win32 plumbing around it.

#[cfg(windows)]
fn main() {
    use std::process::exit;
    match win::check(&std::env::args().nth(1).unwrap_or_default()) {
        Ok(v) => {
            if v != vyre_pipe_verify::Verdict::Ok {
                eprintln!("vyre-pipe-verify: {v:?}");
            }
            exit(v.exit_code());
        }
        Err(e) => {
            eprintln!("vyre-pipe-verify: {e}");
            exit(vyre_pipe_verify::Verdict::Unreadable.exit_code());
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("vyre-pipe-verify only runs on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
mod win {
    use vyre_pipe_verify::{verdict, Verdict};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Opens `pipe_path` (a client connection, same as Node's `net.connect` would establish),
    /// asks Windows who owns the *server* end, then compares that process's token SID against
    /// this process's own. Never trusts a partial read: any Win32 call failing returns an error,
    /// which `main` turns into `Verdict::Unreadable`, never `Ok`.
    pub fn check(pipe_path: &str) -> windows::core::Result<Verdict> {
        let wide: Vec<u16> = pipe_path.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                FILE_GENERIC_READ.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                Default::default(),
                None,
            )?
        };
        let result = (|| -> windows::core::Result<Verdict> {
            let mut server_pid: u32 = 0;
            unsafe { GetNamedPipeServerProcessId(handle, &mut server_pid)? };
            let server_sid = sid_of_process(server_pid)?;
            let mine_sid = sid_of_process(unsafe { GetCurrentProcess() })?;
            Ok(verdict(Some(&mine_sid), Some(&server_sid)))
        })();
        unsafe { let _ = CloseHandle(handle); }
        result
    }

    /// The string SID of a process's token owner, given either a pid (opens it, limited-query
    /// only, never anything that could act on it) or an already-open handle (`GetCurrentProcess`
    /// never needs closing, so this path skips that step).
    fn sid_of_process(process: impl Into<ProcessRef>) -> windows::core::Result<String> {
        let owned;
        let handle = match process.into() {
            ProcessRef::Pid(pid) => {
                owned = Some(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)? });
                owned.unwrap()
            }
            ProcessRef::Handle(h) => h,
        };
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(handle, TOKEN_QUERY, &mut token)? };
        let result = (|| -> windows::core::Result<String> {
            let mut len = 0u32;
            unsafe { let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len); }
            let mut buf = vec![0u8; len as usize];
            unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    Some(buf.as_mut_ptr() as *mut _),
                    len,
                    &mut len,
                )?;
            }
            let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
            let mut sid_str = PCWSTR::null().as_ptr() as *mut u16;
            unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid_str)? };
            let s = unsafe { sid_str.as_ref().map(|_| widestring(sid_str)) }.unwrap_or_default();
            unsafe { let _ = LocalFree(Some(std::mem::transmute(sid_str))); }
            Ok(s)
        })();
        unsafe { let _ = CloseHandle(token); }
        if let Some(h) = owned { unsafe { let _ = CloseHandle(h); } }
        result
    }

    enum ProcessRef { Pid(u32), Handle(HANDLE) }
    impl From<u32> for ProcessRef { fn from(p: u32) -> Self { ProcessRef::Pid(p) } }
    impl From<HANDLE> for ProcessRef { fn from(h: HANDLE) -> Self { ProcessRef::Handle(h) } }

    /// Read a null-terminated wide string Windows handed back (`ConvertSidToStringSidW`'s output).
    unsafe fn widestring(p: *const u16) -> String {
        let mut len = 0usize;
        while *p.add(len) != 0 { len += 1; }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }
}
