//! `vyre-pipe-verify <pipe-path>`: before the CLI/Capsule sends anything over vyred's named pipe,
//! confirm the pipe's owning process is running as the current user. Exit 0 only on a proven
//! match (`vyre_pipe_verify::Verdict::exit_code`); every other case, including a Win32 call
//! failing partway through, exits non-zero. See docs/design/windows-plan.md section 7a point 2c.
//!
//! Real testing happens on `windows-latest` CI (.github/workflows/windows-pipe-verify.yml), the
//! same discipline as every other Windows-only piece in this plan: nothing here runs for real
//! off Windows. `lib.rs`'s verdict logic is unit-tested on any platform; this file is only the
//! Win32 plumbing around it.

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
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Opens `pipe_path` (a client connection, same as Node's `net.connect` would establish),
    /// asks Windows who owns the *server* end, then asks `EqualSid` whether that process's token
    /// SID is the same as this process's own. Never trusts a partial read: any Win32 call failing
    /// returns an error, which `main` turns into `Verdict::Unreadable`, never `Ok`.
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
            let server_token = token_of(ProcessRef::Pid(server_pid))?;
            let mine_token = token_of(ProcessRef::Handle(unsafe { GetCurrentProcess() }))?;
            let server_user = user_sid(server_token.1)?;
            let mine_user = user_sid(mine_token.1)?;
            // EqualSid is a BOOL-returning API, and this crate maps that uniformly to
            // Result<()>: Ok(()) when the SIDs are equal, Err(_) otherwise (a real system error
            // and "simply not equal" are not distinguished, which is fine here - both refuse).
            let equal = unsafe { EqualSid(server_user, mine_user) }.is_ok();
            let (server_owned, server_h) = server_token;
            let (mine_owned, mine_h) = mine_token;
            unsafe { let _ = CloseHandle(server_h); }
            unsafe { let _ = CloseHandle(mine_h); }
            if let Some(h) = server_owned { unsafe { let _ = CloseHandle(h); } }
            if let Some(h) = mine_owned { unsafe { let _ = CloseHandle(h); } }
            Ok(verdict(Some(equal)))
        })();
        unsafe { let _ = CloseHandle(handle); }
        result
    }

    enum ProcessRef { Pid(u32), Handle(HANDLE) }

    /// Opens (query-only) the given process's token, keeping the buffer that owns its
    /// `TOKEN_USER` alive for the caller (returned as the second element, read by `user_sid`).
    /// The first element of the outer pair is the process handle to close afterward, only when
    /// this function opened it itself (a pid, not an already-open handle like
    /// `GetCurrentProcess()`'s pseudo-handle, which needs no closing).
    fn token_of(process: ProcessRef) -> windows::core::Result<(Option<HANDLE>, HANDLE)> {
        let (owned, handle) = match process {
            ProcessRef::Pid(pid) => {
                let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)? };
                (Some(h), h)
            }
            ProcessRef::Handle(h) => (None, h),
        };
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(handle, TOKEN_QUERY, &mut token)? };
        Ok((owned, token))
    }

    /// The `PSID` from a token's `TOKEN_USER`, as a leaked (deliberately: it points inside a
    /// buffer sized exactly for this one call and this process exits right after using it)
    /// pointer good for the process's remaining lifetime.
    fn user_sid(token: HANDLE) -> windows::core::Result<windows::Win32::Security::PSID> {
        let mut len = 0u32;
        unsafe { let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len); }
        let buf: &'static mut [u8] = vec![0u8; len as usize].leak();
        unsafe {
            GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr() as *mut _), len, &mut len)?;
        }
        let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
        Ok(user.User.Sid)
    }
}
