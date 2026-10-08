//! The Windows sealing service's rules, as pure functions (spec part 5; ruled 8 Oct): the sealing process runs under its own Windows account (the virtual service account NT SERVICE\VyreSealer), not the person's,
//! because a same-user program can open and read another same-user process and its files. This file holds what can be tested on any host: the pipe's access list, the exact environment the sealing process is given
//! (a client can add nothing to it), the config the elevated installer writes, and the check that a pipe client is the installed Node. The Win32 calls are in app/src/bin/vyre-seal.rs.

pub const SERVICE: &str = "VyreSealer";
/// The one pipe the service creates (first instance only, so nothing else can hold the name while the service runs).
pub const PIPE: &str = r"\\.\pipe\vyre-seal";
pub const SERVICE_ACCOUNT: &str = r"NT SERVICE\VyreSealer";

/// A Windows SID in string form: S-1-<authority>-<subauthorities>, digits only.
pub fn valid_sid(s: &str) -> bool {
    let mut parts = s.split('-');
    if parts.next() != Some("S") || parts.next() != Some("1") { return false; }
    let rest: Vec<&str> = parts.collect();
    rest.len() >= 2 && rest.len() <= 15 && rest.iter().all(|p| !p.is_empty() && p.len() <= 12 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The pipe's security descriptor (SDDL): protected from inheritance, the service full control, the installing user read and write (enough to connect and talk), SYSTEM full control, nobody else.
/// Another local user, a guest and a network caller (also refused by PIPE_REJECT_REMOTE_CLIENTS) get no access; Administrators are not listed (an administrator can take what they need, but is not handed it).
pub fn pipe_sddl(service_sid: &str, user_sid: &str) -> Result<String, &'static str> {
    if !valid_sid(service_sid) || !valid_sid(user_sid) { return Err("bad_sid"); }
    if service_sid == user_sid { return Err("service_is_user"); }
    Ok(format!("D:P(A;;GA;;;{service_sid})(A;;GRGW;;;{user_sid})(A;;GA;;;SY)"))
}

/// The seal folder's access list for icacls: only the service and SYSTEM, inheritance cut. The installing user is deliberately absent: the files are the service's.
pub fn seal_dir_icacls(dir: &str, service_account: &str) -> Vec<Vec<String>> {
    vec![
        vec![dir.into(), "/inheritance:r".into()],
        vec![dir.into(), "/grant:r".into(), format!("{service_account}:(OI)(CI)F"), "/grant:r".into(), "*S-1-5-18:(OI)(CI)F".into()],
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// The Node that runs the sealing process, and the folder it is installed in (Program Files: only an administrator can change it).
    pub node: String,
    pub node_sha256: String,
    pub process_js: String,
    /// Where the service keeps what it seals and its DPAPI-wrapped master (owned by the service account alone).
    pub seal_dir: String,
    pub service_sid: String,
    /// The one person's account whose vyred may use the pipe.
    pub user_sid: String,
}

fn abs_drive_path(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() > 3 && b[0].is_ascii_alphabetic() && &p[1..3] == ":\\" && !p.contains("..") && !p.contains('"') && !p.contains('\0') && !p.contains('/')
}

impl Config {
    /// A config is trusted only if every path is an absolute drive path with no parent step, the hash is 64 hex, and both SIDs are SIDs.
    pub fn validate(&self) -> Result<(), &'static str> {
        for p in [&self.node, &self.process_js, &self.seal_dir] { if !abs_drive_path(p) { return Err("bad_path"); } }
        if self.node_sha256.len() != 64 || !self.node_sha256.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("bad_hash"); }
        if !valid_sid(&self.service_sid) || !valid_sid(&self.user_sid) { return Err("bad_sid"); }
        Ok(())
    }
    pub fn parse(text: &str) -> Result<Config, &'static str> {
        let v: serde_json::Value = serde_json::from_str(text).map_err(|_| "bad_config")?;
        let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string()).ok_or("bad_config");
        let c = Config { node: get("node")?, node_sha256: get("node_sha256")?, process_js: get("process_js")?, seal_dir: get("seal_dir")?, service_sid: get("service_sid")?, user_sid: get("user_sid")? };
        c.validate()?;
        Ok(c)
    }
    pub fn to_json(&self) -> String {
        serde_json::json!({ "node": self.node, "node_sha256": self.node_sha256, "process_js": self.process_js, "seal_dir": self.seal_dir, "service_sid": self.service_sid, "user_sid": self.user_sid }).to_string()
    }
}

/// The sealing process's whole environment. Nothing of a client's, nothing of a developer switch (VYRE_SEAL_DEV, VYRE_SEAL_UNATTESTED, VYRE_SEAL_SOFTWARE): a release sealing service never accepts a software key.
pub fn child_env(master_b64: &str, seal_dir: &str, system_root: &str) -> Vec<(String, String)> {
    vec![
        ("VYRE_SEAL_DIR".into(), seal_dir.into()),
        ("VYRE_SEAL_SINKS".into(), "{}".into()),
        ("VYRE_SEAL_PROFILE".into(), "windows-service".into()),
        ("VYRE_SEAL_MASTER_B64".into(), master_b64.into()),
        ("SystemRoot".into(), system_root.into()),
        ("PATH".into(), format!("{system_root}\\System32")),
    ]
}

/// Is this process image the installed Node? Compared case-insensitively on the normalised path (Windows paths are case-insensitive; a short or `\\?\` form is not accepted: the image name Windows reports is the long one).
pub fn same_image(client_image: &str, node: &str) -> bool {
    let norm = |p: &str| p.trim().trim_start_matches(r"\\?\").replace('/', "\\").to_ascii_lowercase();
    !client_image.is_empty() && norm(client_image) == norm(node)
}

/// The command line the service is created with: the helper's own path, quoted, then the one word `service`.
pub fn service_bin_path(exe: &str) -> Result<String, &'static str> {
    if !abs_drive_path(exe) { return Err("bad_path"); }
    Ok(format!("\"{exe}\" service"))
}

/// What the elevated install is allowed to be told by its caller: the user SID, and nothing else of the caller's reaches the config.
pub fn install_args(args: &[String]) -> Result<String, &'static str> {
    let i = args.iter().position(|a| a == "--user-sid").ok_or("no_user_sid")?;
    let sid = args.get(i + 1).ok_or("no_user_sid")?;
    if !valid_sid(sid) { return Err("bad_sid"); }
    Ok(sid.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    const SVC: &str = "S-1-5-80-1234567890-1234567890-1234567890-1234567890-1234567890";
    const USER: &str = "S-1-5-21-111111111-222222222-333333333-1001";

    #[test]
    fn sids_are_s_1_and_digits_only() {
        assert!(valid_sid(SVC) && valid_sid(USER) && valid_sid("S-1-5-18"));
        for bad in ["", "S-1", "S-2-5-18", "S-1-5-", "S-1-5-18)(A;;GA;;;WD", "s-1-5-18", "S-1-5-18 ", "S-1-5-1x8", "S-1-5-18-", "S-1-5--18"] { assert!(!valid_sid(bad), "{bad}"); }
    }

    #[test]
    fn the_pipe_admits_the_service_the_one_user_and_system_and_nobody_else() {
        let d = pipe_sddl(SVC, USER).unwrap();
        assert_eq!(d, format!("D:P(A;;GA;;;{SVC})(A;;GRGW;;;{USER})(A;;GA;;;SY)"));
        // no Everyone, no Authenticated Users, no Users, no Administrators, no Anonymous
        for who in [";;;WD)", ";;;AU)", ";;;BU)", ";;;BA)", ";;;AN)", ";;;IU)", ";;;NU)"] { assert!(!d.contains(who), "{who}"); }
        assert_eq!(pipe_sddl(SVC, "S-1-5-21-1)(A;;GA;;;WD"), Err("bad_sid"), "a crafted SID cannot add an entry");
        assert_eq!(pipe_sddl(SVC, SVC), Err("service_is_user"));
    }

    #[test]
    fn the_seal_folder_belongs_to_the_service_alone() {
        let cmds = seal_dir_icacls(r"C:\ProgramData\Vyre\seal", SERVICE_ACCOUNT);
        let all = cmds.concat().join(" ");
        assert!(all.contains("/inheritance:r") && all.contains(r"NT SERVICE\VyreSealer:(OI)(CI)F") && all.contains("*S-1-5-18"));
        assert!(!all.contains("Users") && !all.contains("Everyone") && !all.contains("Administrators"));
    }

    #[test]
    fn a_config_is_refused_unless_every_part_is_exact() {
        let ok = Config { node: r"C:\Program Files\Vyre\node\node.exe".into(), node_sha256: "a".repeat(64), process_js: r"C:\Program Files\Vyre\kernel\seal\process.js".into(), seal_dir: r"C:\ProgramData\Vyre\seal".into(), service_sid: SVC.into(), user_sid: USER.into() };
        assert_eq!(ok.validate(), Ok(()));
        assert_eq!(Config::parse(&ok.to_json()), Ok(ok.clone()));
        let mut c = ok.clone(); c.node = r"node.exe".into(); assert_eq!(c.validate(), Err("bad_path"));
        c = ok.clone(); c.process_js = r"C:\Program Files\Vyre\..\evil.js".into(); assert_eq!(c.validate(), Err("bad_path"));
        c = ok.clone(); c.seal_dir = "C:/ProgramData/Vyre".into(); assert_eq!(c.validate(), Err("bad_path"));
        c = ok.clone(); c.node_sha256 = "abc".into(); assert_eq!(c.validate(), Err("bad_hash"));
        c = ok.clone(); c.user_sid = "everyone".into(); assert_eq!(c.validate(), Err("bad_sid"));
        assert_eq!(Config::parse("{not json"), Err("bad_config"));
    }

    #[test]
    fn the_sealing_process_is_given_nothing_of_a_clients_and_no_development_switch() {
        let env = child_env("QUJD", r"C:\ProgramData\Vyre\seal", r"C:\Windows");
        let names: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["VYRE_SEAL_DIR", "VYRE_SEAL_SINKS", "VYRE_SEAL_PROFILE", "VYRE_SEAL_MASTER_B64", "SystemRoot", "PATH"]);
        for dev in ["VYRE_SEAL_DEV", "VYRE_SEAL_UNATTESTED", "VYRE_SEAL_SOFTWARE", "VYRE_SEAL_VERIFIERS", "NODE_OPTIONS"] { assert!(!names.contains(&dev), "{dev}"); }
        assert!(env.iter().any(|(k, v)| k == "VYRE_SEAL_PROFILE" && v == "windows-service"));
    }

    #[test]
    fn only_the_installed_node_is_a_pipe_client() {
        let node = r"C:\Program Files\Vyre\node\node.exe";
        assert!(same_image(r"c:\program files\vyre\NODE\node.exe", node));
        assert!(same_image(r"\\?\C:\Program Files\Vyre\node\node.exe", node));
        for other in ["", r"C:\Users\a\node.exe", r"C:\Program Files\nodejs\node.exe", r"C:\Program Files\Vyre\node\node.exe.evil", r"C:\Windows\System32\cmd.exe"] { assert!(!same_image(other, node), "{other}"); }
    }

    #[test]
    fn the_service_command_line_is_the_quoted_helper_and_one_word() {
        assert_eq!(service_bin_path(r"C:\Program Files\Vyre\vyre-seal.exe").unwrap(), r#""C:\Program Files\Vyre\vyre-seal.exe" service"#);
        assert!(service_bin_path(r#"C:\x" & calc.exe & ""#).is_err());
        assert!(service_bin_path("vyre-seal.exe").is_err());
    }

    #[test]
    fn install_takes_the_users_sid_and_only_that() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(install_args(&a(&["install", "--user-sid", USER])), Ok(USER.to_string()));
        assert_eq!(install_args(&a(&["install"])), Err("no_user_sid"));
        assert_eq!(install_args(&a(&["install", "--user-sid"])), Err("no_user_sid"));
        assert_eq!(install_args(&a(&["install", "--user-sid", "S-1-5-21-1)(A;;GA;;;WD"])), Err("bad_sid"));
    }
}
