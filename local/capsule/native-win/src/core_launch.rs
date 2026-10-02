//! How the app starts the local core (#26, v0.2.3): the arguments, the environment and the per-launch
//! pipe token. Pure, so the exact command line is checked without a Windows machine.
//!
//! The core runs as the person, not elevated, under Node's permission model: it may read its own
//! folder, its home and the agent session folders it imports from, and write only its home. That is
//! a seatbelt against a bug in the core reaching other files, not a boundary against another process
//! of the same person (core_pkg.rs says the same of the start check).

use std::path::{Path, PathBuf};

/// The environment variables the core is given. Nothing else of the app's environment reaches it.
/// The last seven are where each agent keeps its sessions (the same ones `history::agent_roots` reads), so the
/// core looks in the folders the app granted it.
pub const ENV_KEEP: [&str; 15] = ["SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERNAME",
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "VYRE_CLAUDE_HOME", "VYRE_CODEX_HOME", "VYRE_GROK_HOME", "VYRE_GEMINI_HOME"];

/// A fresh random pipe token: 32 lowercase hex characters, the form core/config's `pipeToken` writes.
pub fn token_from(bytes: &[u8; 16]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

/// Is this a token the core would accept as written by the app.
pub fn valid_token(t: &str) -> bool { t.len() == 32 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }

/// A path as Node's flags take it: plain, no `\\?\` prefix, no comma (a comma would split the flag).
fn flag_path(p: &Path) -> Result<String, String> {
    let s = crate::core_pkg::plain_path(p);
    if s.contains(',') || s.contains('\n') || s.contains('\0') { return Err(format!("{s} has a character the core's permissions cannot take")); }
    Ok(s)
}

/// The command line after node.exe: permissions first, then the daemon's entry file.
/// `pipe` is the core's own pipe (the daemon checks for a stale one with a file call, which the permission model counts as a read and a remove).
pub fn node_args(version_dir: &Path, home: &Path, read_roots: &[PathBuf], pipe: &str) -> Result<Vec<String>, String> {
    let mut a = vec!["--permission".to_string()];
    let mut read = vec![version_dir.to_path_buf(), home.to_path_buf()];
    read.extend(read_roots.iter().cloned());
    let mut seen = std::collections::HashSet::new();
    for p in read {
        let s = flag_path(&p)?;
        if seen.insert(s.to_ascii_lowercase()) { a.push(format!("--allow-fs-read={s}")); }
    }
    a.push(format!("--allow-fs-read={}", flag_path(Path::new(pipe))?));
    a.push(format!("--allow-fs-write={}", flag_path(home)?));
    a.push(format!("--allow-fs-write={}", flag_path(Path::new(pipe))?));
    // The core asks Tailscale who is on the other end of a link, which is a program it starts.
    a.push("--allow-child-process".into());
    a.push(flag_path(&version_dir.join("vyre").join("core").join("daemon").join("main.js"))?);
    Ok(a)
}

/// The environment for the core: the kept variables that are set, plus its home.
pub fn env(get: &dyn Fn(&str) -> Option<String>, home: &Path) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = ENV_KEEP.iter().filter_map(|k| get(k).filter(|v| !v.is_empty()).map(|v| (k.to_string(), v))).collect();
    out.push(("VYRE_HOME".into(), crate::core_pkg::plain_path(home)));
    out.push(("VYRE_SUPERVISOR".into(), "app".into()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_the_form_the_core_writes() {
        let t = token_from(&[0xab; 16]);
        assert_eq!(t, "abababababababababababababababab");
        assert!(valid_token(&t));
        for bad in ["", "ABAB", "zz", &"a".repeat(31), &"a".repeat(33)] { assert!(!valid_token(bad), "{bad}"); }
    }

    #[test]
    fn the_core_reads_its_folders_and_writes_only_its_home_and_pipe() {
        let a = node_args(Path::new("C:\\Users\\a\\AppData\\Local\\Vyre\\core\\0.2.3"), Path::new("C:\\Users\\a\\.vyre"),
            &[PathBuf::from("C:\\Users\\a\\.claude\\projects"), PathBuf::from("c:\\users\\a\\.vyre")], "\\\\.\\pipe\\vyre-1-2").unwrap();
        assert!(a.contains(&"--allow-fs-read=\\\\.\\pipe\\vyre-1-2".to_string()) && a.contains(&"--allow-fs-write=\\\\.\\pipe\\vyre-1-2".to_string()));
        assert_eq!(a[0], "--permission");
        assert!(a.contains(&"--allow-fs-read=C:\\Users\\a\\AppData\\Local\\Vyre\\core\\0.2.3".to_string()));
        assert!(a.contains(&"--allow-fs-read=C:\\Users\\a\\.claude\\projects".to_string()));
        assert_eq!(a.iter().filter(|x| x.to_ascii_lowercase() == "--allow-fs-read=c:\\users\\a\\.vyre").count(), 1, "a folder named twice is named once");
        assert_eq!(a.iter().filter(|x| x.starts_with("--allow-fs-write=")).collect::<Vec<_>>(), vec!["--allow-fs-write=C:\\Users\\a\\.vyre", "--allow-fs-write=\\\\.\\pipe\\vyre-1-2"]);
        assert!(a.last().unwrap().ends_with("vyre\\core\\daemon\\main.js") || a.last().unwrap().ends_with("vyre/core/daemon/main.js"));
    }

    #[test]
    fn a_path_that_would_split_a_flag_is_refused() {
        assert!(node_args(Path::new("C:\\a,b"), Path::new("C:\\h"), &[], "p").is_err());
        assert!(node_args(Path::new("C:\\a"), Path::new("C:\\h,x"), &[], "p").is_err());
    }

    #[test]
    fn only_the_kept_variables_reach_the_core() {
        let get = |k: &str| match k { "USERPROFILE" => Some("C:\\Users\\a".to_string()), "ANTHROPIC_API_KEY" => Some("secret".into()), "TEMP" => Some("".into()), _ => None };
        let e = env(&get, Path::new("\\\\?\\C:\\Users\\a\\.vyre"));
        assert!(e.contains(&("USERPROFILE".into(), "C:\\Users\\a".into())));
        assert!(e.contains(&("VYRE_HOME".into(), "C:\\Users\\a\\.vyre".into())));
        assert!(!e.iter().any(|(k, _)| k == "ANTHROPIC_API_KEY" || k == "TEMP"));
    }
}
