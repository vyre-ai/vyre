//! The local core's files on this PC (#26, v0.2.3): what is pinned, how a versioned folder is
//! checked at every start, and the name of the pipe the app talks to it on. Pure pieces and file
//! reads only; downloading, extracting and starting the process are the app's.
//!
//! Layout, per version, under %LOCALAPPDATA%\Vyre\core\<version>\ :
//!   node\node.exe   the one file taken from the pinned Node zip
//!   vyre\           the signed vyre package, unpacked
//!   core.lock       sha256 of node.exe and of the vyre tree, written when the install finished
//!
//! The start check is an integrity check (corruption, a half-finished update, a partial change),
//! not a trust boundary: the checker lives in the app, which the same user can replace. Only an
//! installer signature or an admin-written location would anchor trust (reviewer-2).

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::update::Version;

/// The pinned Node (the Mac installer pins the same version). The zip is checked against this hash
/// before any file is taken from it.
pub const NODE_VERSION: &str = "v22.23.3";
pub const NODE_ZIP: &str = "node-v22.23.3-win-x64.zip";
pub const NODE_ZIP_SHA256: &str = "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71";
/// The one member taken from the zip.
pub const NODE_EXE_IN_ZIP: &str = "node-v22.23.3-win-x64/node.exe";

pub fn node_zip_url() -> String { format!("https://nodejs.org/dist/{NODE_VERSION}/{NODE_ZIP}") }

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
pub fn sha256_hex(bytes: &[u8]) -> String { hex(&Sha256::digest(bytes)) }

pub fn file_sha256(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

/// The downloaded Node zip must be the pinned one.
pub fn check_node_zip(bytes: &[u8]) -> Result<(), String> {
    if sha256_hex(bytes) == NODE_ZIP_SHA256 { Ok(()) } else { Err("the Node download does not match its pinned checksum".into()) }
}

/// A folder as Node's fs.realpathSync gives it: no `\\?\` prefix. `canonicalize` on Windows returns the
/// verbatim form, and the pipe name is a hash of the plain one.
pub fn plain_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") { return format!("\\\\{rest}"); }
    s.strip_prefix("\\\\?\\").map(String::from).unwrap_or(s)
}

/// The pipe vyred listens on for this home: core/config/index.js `socketPath` on win32, which is
/// `\\.\pipe\vyre-<first 16 hex of sha256(real folder)>-<token from <home>\pipe-token>`. The app writes a
/// fresh random token before each start, so the name is not known until that launch.
pub fn pipe_name(real_root: &str, token: &str) -> String {
    format!("\\\\.\\pipe\\vyre-{}-{}", &sha256_hex(real_root.as_bytes())[..16], token)
}

/// One hash for a folder: every file's relative path (forward slashes, sorted) and content. Links and
/// anything that is not a plain file or folder are refused, so the tree is only what it looks like.
pub fn tree_hash(dir: &Path) -> Result<String, String> {
    let mut files = vec![];
    walk(dir, dir, &mut files)?;
    files.sort();
    let mut h = Sha256::new();
    for (rel, path) in files {
        h.update(rel.as_bytes());
        h.update([0]);
        h.update(file_sha256(&path)?.as_bytes());
        h.update([b'\n']);
    }
    Ok(hex(&h.finalize()))
}

#[cfg(windows)]
fn is_reparse(md: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    md.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_reparse(_: &fs::Metadata) -> bool { false }

fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for e in rd {
        let e = e.map_err(|e| e.to_string())?;
        let p = e.path();
        let md = fs::symlink_metadata(&p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
        if md.file_type().is_symlink() || is_reparse(&md) { return Err(format!("{} is a link, which a core folder never holds", p.display())); }
        if md.is_dir() { walk(base, &p, out)?; }
        else if md.is_file() {
            let rel = p.strip_prefix(base).map_err(|_| "a file outside its folder".to_string())?;
            out.push((rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/"), p));
        } else { return Err(format!("{} is neither a file nor a folder", p.display())); }
    }
    Ok(())
}

/// Written when an install finishes: what the folder must hold from then on.
pub fn write_lock(version_dir: &Path, version: &str) -> Result<(), String> {
    let lock = json!({
        "version": version,
        "node": file_sha256(&version_dir.join("node").join("node.exe"))?,
        "package": tree_hash(&version_dir.join("vyre"))?,
    });
    fs::write(version_dir.join("core.lock"), serde_json::to_vec_pretty(&lock).unwrap()).map_err(|e| format!("cannot write core.lock: {e}"))
}

/// Run before every start. Says in plain words what is wrong, and the core is not started.
pub fn check_start(version_dir: &Path) -> Result<(), String> {
    let raw = fs::read(version_dir.join("core.lock")).map_err(|_| "Vyre's local files are not fully installed (no core.lock). Repair or reinstall Vyre.".to_string())?;
    let lock: Value = serde_json::from_slice(&raw).map_err(|_| "Vyre's local files have a damaged core.lock. Repair or reinstall Vyre.".to_string())?;
    let want = |k: &str| lock.get(k).and_then(|v| v.as_str()).map(String::from).ok_or_else(|| "Vyre's local files have a damaged core.lock. Repair or reinstall Vyre.".to_string());
    let node = file_sha256(&version_dir.join("node").join("node.exe")).map_err(|_| "Vyre's local runtime (node.exe) is missing. Repair or reinstall Vyre.".to_string())?;
    if node != want("node")? { return Err("Vyre's local runtime (node.exe) is not the one that was installed, so the local core was not started. Repair or reinstall Vyre.".into()); }
    let pkg = tree_hash(&version_dir.join("vyre")).map_err(|_| "Vyre's local package could not be checked, so the local core was not started. Repair or reinstall Vyre.".to_string())?;
    if pkg != want("package")? { return Err("Vyre's local package is not the one that was installed, so the local core was not started. Repair or reinstall Vyre.".into()); }
    Ok(())
}

/// A version folder is only ever replaced by a newer one; an older or equal install is refused.
pub fn refuse_older(installed: Option<&str>, candidate: &str) -> Result<(), String> {
    let c = Version::parse(candidate).ok_or("the package version is not a version")?;
    if let Some(i) = installed {
        let i = Version::parse(i).ok_or("the installed version is not a version")?;
        if c <= i { return Err(format!("{candidate} is not newer than the installed {}", installed.unwrap_or(""))); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);
    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vyre-corepkg-{}-{}-{}", std::process::id(), tag, N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn install(tag: &str) -> PathBuf {
        let d = dir(tag);
        fs::create_dir_all(d.join("node")).unwrap();
        fs::write(d.join("node").join("node.exe"), b"pretend node").unwrap();
        fs::create_dir_all(d.join("vyre").join("core")).unwrap();
        fs::write(d.join("vyre").join("package.json"), b"{}").unwrap();
        fs::write(d.join("vyre").join("core").join("a.js"), b"export {}").unwrap();
        write_lock(&d, "0.2.3").unwrap();
        d
    }

    #[test]
    fn the_pin_is_the_zip_name_and_a_wrong_zip_is_refused() {
        assert!(NODE_ZIP.contains(NODE_VERSION.trim_start_matches('v')) && NODE_EXE_IN_ZIP.starts_with(&NODE_ZIP[..NODE_ZIP.len() - 4]));
        assert_eq!(NODE_ZIP_SHA256.len(), 64);
        assert!(check_node_zip(b"not node").is_err());
        assert_eq!(node_zip_url(), "https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip");
    }

    #[test]
    fn the_pipe_name_matches_the_core_vector() {
        // tests/pipe-vector.json is also checked against core/config/index.js's formula in test/windows-core-pipe.test.js.
        let v: Value = serde_json::from_str(include_str!("../tests/pipe-vector.json")).unwrap();
        for c in v["cases"].as_array().unwrap() {
            assert_eq!(pipe_name(c["root"].as_str().unwrap(), c["token"].as_str().unwrap()), c["pipe"].as_str().unwrap());
        }
        assert_eq!(plain_path(Path::new("\\\\?\\C:\\Users\\a\\.vyre")), "C:\\Users\\a\\.vyre");
        assert_eq!(plain_path(Path::new("\\\\?\\UNC\\host\\share\\x")), "\\\\host\\share\\x");
        assert_eq!(plain_path(Path::new("C:\\plain")), "C:\\plain");
    }

    #[test]
    fn a_finished_install_passes_and_every_kind_of_change_is_refused_in_plain_words() {
        let d = install("ok");
        check_start(&d).unwrap();
        fs::write(d.join("vyre").join("core").join("a.js"), b"export { evil }").unwrap();
        assert!(check_start(&d).unwrap_err().contains("package is not the one that was installed"));
        let d = install("added");
        fs::write(d.join("vyre").join("extra.js"), b"x").unwrap();
        assert!(check_start(&d).unwrap_err().contains("package"));
        let d = install("node");
        fs::write(d.join("node").join("node.exe"), b"another node").unwrap();
        assert!(check_start(&d).unwrap_err().contains("node.exe"));
        let d = install("gone");
        fs::remove_file(d.join("node").join("node.exe")).unwrap();
        assert!(check_start(&d).unwrap_err().contains("missing"));
        let d = install("nolock");
        fs::remove_file(d.join("core.lock")).unwrap();
        assert!(check_start(&d).unwrap_err().contains("core.lock"));
        let d = install("badlock");
        fs::write(d.join("core.lock"), b"{").unwrap();
        assert!(check_start(&d).unwrap_err().contains("damaged"));
    }

    #[test]
    fn the_tree_hash_depends_on_names_and_content_not_on_the_order_of_creation() {
        let a = dir("ta"); let b = dir("tb");
        fs::write(a.join("x"), b"1").unwrap(); fs::write(a.join("y"), b"2").unwrap();
        fs::write(b.join("y"), b"2").unwrap(); fs::write(b.join("x"), b"1").unwrap();
        assert_eq!(tree_hash(&a).unwrap(), tree_hash(&b).unwrap());
        fs::rename(b.join("x"), b.join("z")).unwrap();
        assert_ne!(tree_hash(&a).unwrap(), tree_hash(&b).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_tree_is_refused() {
        let d = dir("link");
        fs::write(d.join("real"), b"1").unwrap();
        std::os::unix::fs::symlink(d.join("real"), d.join("l")).unwrap();
        assert!(tree_hash(&d).unwrap_err().contains("link"));
    }

    #[test]
    fn only_a_newer_version_replaces_an_install() {
        assert!(refuse_older(None, "0.2.3").is_ok());
        assert!(refuse_older(Some("0.2.3"), "0.2.4").is_ok());
        assert!(refuse_older(Some("0.2.3"), "0.2.3-rc.1").is_err());
        assert!(refuse_older(Some("0.2.3"), "0.2.3").is_err());
        assert!(refuse_older(Some("0.2.3"), "0.2.2").is_err());
        assert!(refuse_older(Some("0.2.3"), "latest").is_err());
    }
}
