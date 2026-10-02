//! Putting the local core on this PC (#26, v0.2.3): unpack the signed vyre package and the one file taken
//! from the pinned Node zip into a staging folder, write core.lock, and move the folder to its version
//! name. Downloading and the signed-sums check are the app's (it uses `update::verify_sums` and
//! `update::check_file`); this file only takes bytes that were already checked, and treats them as
//! hostile anyway: no path leaves its folder, no link is ever created, and size and count are capped.

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use crate::core_pkg;

/// The release asset that holds the package (the npm tarball every box installs).
pub const PACKAGE_ASSET: &str = "vyre.tgz";
/// The tarball's own top folder, dropped on unpack.
const TOP: &str = "package";
const MAX_ENTRIES: usize = 60_000;
const MAX_TOTAL: u64 = 400 << 20;
const MAX_FILE: u64 = 120 << 20;

/// One tar or zip member name as a safe relative path, or why not. Refuses an absolute path, a drive,
/// a stream (`:`), `..`, backslashes, empty parts and the names Windows reserves, so what lands on disk
/// is only ever under the target folder.
pub fn safe_rel(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('\\') || name.contains('\0') || name.starts_with('/') { return Err(format!("{name:?} is not a path inside the package")); }
    let mut out = PathBuf::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." { continue; }
        if part == ".." || part.contains(':') || part.ends_with('.') || part.ends_with(' ') || part.bytes().any(|b| b < 0x20) || reserved(part) {
            return Err(format!("{name:?} is not a path inside the package"));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() { return Err(format!("{name:?} is not a path inside the package")); }
    if out.components().any(|c| !matches!(c, Component::Normal(_))) { return Err(format!("{name:?} is not a path inside the package")); }
    Ok(out)
}

fn reserved(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0')
}

/// Unpack the package tarball into `dest` (which must be empty or missing). Only plain files and folders;
/// a link, device or any other member refuses the whole package. Names that differ only in case are
/// refused too (Windows would merge them).
pub fn extract_tgz(bytes: &[u8], dest: &Path) -> Result<usize, String> {
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut ar = tar::Archive::new(gz);
    fs::create_dir_all(dest).map_err(|e| format!("cannot make {}: {e}", dest.display()))?;
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    let mut files = 0usize;
    for (i, entry) in ar.entries().map_err(|_| "the package is not a readable archive".to_string())?.enumerate() {
        if i >= MAX_ENTRIES { return Err("the package holds too many files".into()); }
        let mut entry = entry.map_err(|_| "the package is damaged".to_string())?;
        let kind = entry.header().entry_type();
        let raw = entry.path().map_err(|_| "the package holds a name that is not text".to_string())?.to_string_lossy().replace('\\', "\u{1}");
        if raw.contains('\u{1}') { return Err(format!("{raw:?} is not a path inside the package")); }
        // Pax and global headers carry no file.
        if kind.is_pax_global_extensions() || kind.is_pax_local_extensions() || kind.is_gnu_longname() || kind.is_gnu_longlink() { continue; }
        let rest = match raw.strip_prefix(&format!("{TOP}/")) { Some(r) => r.to_string(), None if raw == TOP || raw == format!("{TOP}/") => continue, None => return Err(format!("{raw:?} is outside the package folder")) };
        if rest.is_empty() { continue; }
        let rel = safe_rel(&rest)?;
        if !seen.insert(rel.to_string_lossy().to_ascii_lowercase()) && !kind.is_dir() { return Err(format!("{rest:?} appears twice")); }
        let target = dest.join(&rel);
        if kind.is_dir() { fs::create_dir_all(&target).map_err(|e| e.to_string())?; continue; }
        if !kind.is_file() { return Err(format!("{rest:?} is a link or special file, which the package never holds")); }
        let size = entry.header().size().map_err(|_| "the package is damaged".to_string())?;
        if size > MAX_FILE { return Err(format!("{rest:?} is too large")); }
        total += size;
        if total > MAX_TOTAL { return Err("the package is larger than expected".into()); }
        if let Some(p) = target.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| format!("cannot write {}: {e}", target.display()))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut left = size;
        loop {
            let n = entry.read(&mut buf).map_err(|_| "the package is damaged".to_string())?;
            if n == 0 { break; }
            if n as u64 > left { return Err("the package is damaged".into()); }
            left -= n as u64;
            f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        }
        files += 1;
    }
    if files == 0 { return Err("the package is empty".into()); }
    Ok(files)
}

/// Take node.exe, and only that, out of the pinned zip (already checked against its pinned hash).
pub fn extract_node(zip_bytes: &[u8], dest_exe: &Path) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|_| "the Node download is not a readable archive".to_string())?;
    let mut member = z.by_name(core_pkg::NODE_EXE_IN_ZIP).map_err(|_| "the Node download has no node.exe".to_string())?;
    if member.is_dir() || member.size() > MAX_FILE { return Err("the Node download holds an unexpected node.exe".into()); }
    if let Some(p) = dest_exe.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(dest_exe).map_err(|e| format!("cannot write {}: {e}", dest_exe.display()))?;
    let n = std::io::copy(&mut (&mut member).take(MAX_FILE + 1), &mut f).map_err(|_| "the Node download is damaged".to_string())?;
    if n > MAX_FILE { return Err("the Node download holds an unexpected node.exe".into()); }
    Ok(())
}

/// The version folder for `version` under `core_root`, or why not (the version must parse).
pub fn version_dir(core_root: &Path, version: &str) -> Result<PathBuf, String> {
    crate::update::Version::parse(version).ok_or_else(|| "the core version is not a version".to_string())?;
    Ok(core_root.join(version))
}

/// The newest installed version folder name under `core_root` (that parses and has a core.lock), if any.
pub fn installed_version(core_root: &Path) -> Option<String> {
    let mut best: Option<(crate::update::Version, String)> = None;
    for e in fs::read_dir(core_root).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(v) = crate::update::Version::parse(&name) else { continue };
        if !e.path().join("core.lock").is_file() { continue; }
        if best.as_ref().map(|(b, _)| v > *b).unwrap_or(true) { best = Some((v, name)); }
    }
    best.map(|(_, n)| n)
}

/// Install a version: stage next to the final folder, unpack, write the lock, then rename into place.
/// An older or equal version never replaces an install. Bytes must already have passed their checks
/// (`core_pkg::check_node_zip` and the signed hash of the package). Returns the version folder.
pub fn install(core_root: &Path, version: &str, package_tgz: &[u8], node_zip: &[u8]) -> Result<PathBuf, String> {
    core_pkg::check_node_zip(node_zip)?;
    install_checked(core_root, version, package_tgz, node_zip)
}

fn install_checked(core_root: &Path, version: &str, package_tgz: &[u8], node_zip: &[u8]) -> Result<PathBuf, String> {
    let final_dir = version_dir(core_root, version)?;
    if final_dir.join("core.lock").is_file() { return Ok(final_dir); }
    core_pkg::refuse_older(installed_version(core_root).as_deref(), version)?;
    fs::create_dir_all(core_root).map_err(|e| format!("cannot make {}: {e}", core_root.display()))?;
    let staging = core_root.join(format!(".staging-{}-{}", std::process::id(), version));
    let _ = fs::remove_dir_all(&staging);
    let run = || -> Result<(), String> {
        extract_tgz(package_tgz, &staging.join("vyre"))?;
        extract_node(node_zip, &staging.join("node").join("node.exe"))?;
        core_pkg::write_lock(&staging, version)?;
        let _ = fs::remove_dir_all(&final_dir);
        fs::rename(&staging, &final_dir).map_err(|e| format!("cannot finish the install: {e}"))
    };
    let r = run();
    if r.is_err() { let _ = fs::remove_dir_all(&staging); }
    r.map(|_| final_dir)
}

/// Remove version folders other than `keep` (and stale staging folders), after a newer one is in place.
pub fn prune(core_root: &Path, keep: &str) {
    let Ok(rd) = fs::read_dir(core_root) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name != keep { let _ = fs::remove_dir_all(e.path()); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);
    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vyre-coreinst-{}-{}-{}", std::process::id(), tag, N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A tarball with the given (name, kind, content) members; kind 0 file, 5 dir, 2 symlink.
    fn tgz(members: &[(&str, u8, &[u8])]) -> Vec<u8> {
        let mut raw = Vec::new();
        for (name, kind, data) in members {
            let mut h = [0u8; 512];
            h[..name.len()].copy_from_slice(name.as_bytes());
            h[100..108].copy_from_slice(b"0000644\0");
            h[108..116].copy_from_slice(b"0000000\0");
            h[116..124].copy_from_slice(b"0000000\0");
            h[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
            h[136..148].copy_from_slice(b"00000000000\0");
            h[156] = match kind { 0 => b'0', 5 => b'5', 2 => b'2', _ => b'0' };
            if *kind == 2 { h[157..157 + 4].copy_from_slice(b"/etc"); }
            h[257..263].copy_from_slice(b"ustar\0");
            h[263..265].copy_from_slice(b"00");
            h[148..156].copy_from_slice(b"        ");
            let sum: u32 = h.iter().map(|b| *b as u32).sum();
            h[148..156].copy_from_slice(format!("{:06o}\0 ", sum).as_bytes());
            raw.extend_from_slice(&h);
            raw.extend_from_slice(data);
            raw.extend(std::iter::repeat(0u8).take((512 - data.len() % 512) % 512));
        }
        raw.extend(std::iter::repeat(0u8).take(1024));
        let mut out = Vec::new();
        let mut enc = flate2::write::GzEncoder::new(&mut out, flate2::Compression::fast());
        enc.write_all(&raw).unwrap();
        enc.finish().unwrap();
        out
    }

    #[test]
    fn names_that_leave_the_folder_are_refused() {
        for bad in ["../x", "a/../../x", "/etc/passwd", "C:/x", "a/b:stream", "a\\b", "a/CON", "a/nul.txt", "a/COM1", "a/x.", "", "a/\u{1}b"] {
            assert!(safe_rel(bad).is_err(), "{bad:?}");
        }
        assert_eq!(safe_rel("core/./a.js").unwrap(), PathBuf::from("core").join("a.js"));
        assert!(safe_rel("COM0").is_ok());
    }

    #[test]
    fn a_package_unpacks_without_its_top_folder() {
        let d = dir("ok");
        let t = tgz(&[("package/", 5, b""), ("package/package.json", 0, b"{}"), ("package/core/", 5, b""), ("package/core/a.js", 0, b"export {}")]);
        assert_eq!(extract_tgz(&t, &d).unwrap(), 2);
        assert_eq!(fs::read(d.join("core").join("a.js")).unwrap(), b"export {}");
        assert!(d.join("package.json").is_file());
    }

    #[test]
    fn a_link_an_escape_or_a_foreign_top_folder_refuses_the_whole_package() {
        let d = dir("link");
        assert!(extract_tgz(&tgz(&[("package/a", 0, b"1"), ("package/l", 2, b"")]), &d).unwrap_err().contains("link"));
        assert!(extract_tgz(&tgz(&[("package/../evil", 0, b"1")]), &dir("esc")).is_err());
        assert!(extract_tgz(&tgz(&[("other/a", 0, b"1")]), &dir("top")).unwrap_err().contains("outside"));
        assert!(extract_tgz(&tgz(&[("package/A", 0, b"1"), ("package/a", 0, b"2")]), &dir("case")).unwrap_err().contains("twice"));
        assert!(extract_tgz(b"not a tarball", &dir("junk")).is_err());
        assert!(extract_tgz(&tgz(&[("package/", 5, b"")]), &dir("empty")).unwrap_err().contains("empty"));
    }

    #[test]
    fn a_wrong_node_zip_is_refused_before_anything_is_written() {
        let root = dir("badnode");
        let t = tgz(&[("package/package.json", 0, b"{}")]);
        assert!(install(&root, "0.2.3", &t, b"not node").unwrap_err().contains("pinned checksum"));
        assert!(fs::read_dir(&root).unwrap().next().is_none());
    }

    fn node_zip() -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
            z.start_file(core_pkg::NODE_EXE_IN_ZIP, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"pretend node").unwrap();
            z.start_file("node-v22.23.3-win-x64/other.txt", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"not taken").unwrap();
            z.finish().unwrap();
        }
        out
    }

    #[test]
    fn an_install_passes_the_start_check_and_only_a_newer_one_replaces_it() {
        let root = dir("inst");
        let t = tgz(&[("package/package.json", 0, b"{}"), ("package/core/a.js", 0, b"export {}")]);
        let d = install_checked(&root, "0.2.3", &t, &node_zip()).unwrap();
        core_pkg::check_start(&d).unwrap();
        assert!(!d.join("node").join("other.txt").exists());
        assert_eq!(install_checked(&root, "0.2.3", &t, &node_zip()).unwrap(), d, "the same version is already there");
        assert!(install_checked(&root, "0.2.2", &t, &node_zip()).unwrap_err().contains("not newer"));
        let d2 = install_checked(&root, "0.2.4", &t, &node_zip()).unwrap();
        prune(&root, "0.2.4");
        assert!(d2.is_dir() && !d.exists());
        assert!(fs::read_dir(&root).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".staging")));
    }

    #[test]
    fn a_bad_package_leaves_no_staging_folder() {
        let root = dir("fail");
        let bad = tgz(&[("package/l", 2, b"")]);
        assert!(install_checked(&root, "0.2.3", &bad, &node_zip()).is_err());
        assert!(fs::read_dir(&root).unwrap().next().is_none());
    }

    #[test]
    fn the_newest_installed_version_is_found_and_old_ones_pruned() {
        let root = dir("ver");
        for v in ["0.2.2", "0.2.3", "0.2.10"] {
            fs::create_dir_all(root.join(v)).unwrap();
            fs::write(root.join(v).join("core.lock"), b"{}").unwrap();
        }
        fs::create_dir_all(root.join("0.9.9")).unwrap(); // no lock: a half install
        fs::create_dir_all(root.join(".staging-1-0.3.0")).unwrap();
        assert_eq!(installed_version(&root).as_deref(), Some("0.2.10"));
        prune(&root, "0.2.10");
        let left: Vec<_> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(left, vec!["0.2.10".to_string()]);
        assert!(version_dir(&root, "latest").is_err());
        assert!(version_dir(&root, "../x").is_err());
    }
}
