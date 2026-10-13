//! Vyre in File Explorer: the host-independent half of the Cloud Files sync root (team decision of 2 Oct: native mounting of Vyre Files, the way OneDrive shows).
//!
//! The Windows side (`app/src/mount_win.rs`) registers the sync root and answers Windows' callbacks; everything that is only a decision lives here so it runs under `cargo test` on any
//! machine: how a Drive path becomes a Windows name and back, what Explorer should show after the server says what changed, and which server tool a local act becomes.
//!
//! The server side is the Space Drive's mount tools (core/files/space-drive.js): `files.drive.space.changes|stat|move|trash|read|upload.*`. Every one runs as the person, through the
//! hidden link page that holds this computer's own device channel (`VyreCall`); nothing here holds a key or a token.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

/// Top-level Drive folders that are the server's own bookkeeping, never shown: the trash and an upload's waiting parts.
pub const HIDDEN_TOP: [&str; 2] = [".trash", ".upload"];
/// The most one call carries (core/files/space-drive.js MAX_UPLOAD).
pub const ONE_CALL: usize = 8 * 1024 * 1024;
/// The size of one part of a big upload, and of one ranged read. Base64 grows it by a third, so this stays well under ONE_CALL.
pub const PART: usize = 4 * 1024 * 1024;
/// Windows allows 255 UTF-16 units in one name.
const NAME_MAX: usize = 255;

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// A name part Windows cannot hold, or one that would read back as an escape.
fn must_escape(ch: char) -> bool {
    matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\') || (ch as u32) < 0x20 || ch as u32 == 0x7f
}

/// One Drive segment as a Windows name. The characters Windows refuses (and a trailing dot or space) become `%XX`; a `%` that is followed by two hex digits becomes `%25` so reading back is
/// exact, and any other `%` stays as it is. None for a name longer than Windows allows.
pub fn local_segment(seg: &str) -> Option<String> {
    if seg.is_empty() || seg.encode_utf16().count() > NAME_MAX { return None; }
    let chars: Vec<char> = seg.chars().collect();
    let mut out = String::new();
    for (i, &ch) in chars.iter().enumerate() {
        let last = i + 1 == chars.len();
        let bad_pct = ch == '%' && chars.get(i + 1).map_or(false, |c| c.is_ascii_hexdigit()) && chars.get(i + 2).map_or(false, |c| c.is_ascii_hexdigit());
        if must_escape(ch) || bad_pct || (last && (ch == '.' || ch == ' ')) {
            out.push_str(&format!("%{:02X}", ch as u32));
        } else {
            out.push(ch);
        }
    }
    // escaping can lengthen a name past the limit
    if out.encode_utf16().count() > NAME_MAX { return None; }
    Some(out)
}

/// The Drive segment a Windows name stands for: `%XX` of an ASCII character is that character.
pub fn drive_segment(seg: &str) -> String {
    let b = seg.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    let mut start = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && hex(b[i + 1]).is_some() && hex(b[i + 2]).is_some() {
            let v = hex(b[i + 1]).unwrap() * 16 + hex(b[i + 2]).unwrap();
            if v < 0x80 {
                out.push_str(&seg[start..i]);
                out.push(v as char);
                i += 3;
                start = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&seg[start..]);
    out
}

/// A Drive path as a path under the sync root, `/`-separated. None for what Explorer never shows (the server's own folders) or a name Windows cannot hold.
pub fn local_path(drive_path: &str) -> Option<String> {
    let segs: Vec<&str> = drive_path.split('/').collect();
    if segs.iter().any(|s| s.is_empty()) { return None; }
    if HIDDEN_TOP.contains(&segs[0]) { return None; }
    let mut out = Vec::new();
    for s in segs { out.push(local_segment(s)?); }
    Some(out.join("/"))
}

/// A path under the sync root (either slash) as a Drive path. The Drive's rules are kept here too: no empty, dot or dot-dot segment, nothing in the server's own folders.
pub fn drive_path(local: &str) -> Result<String, &'static str> {
    let norm = local.replace('\\', "/");
    let segs: Vec<&str> = norm.split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == "..") { return Err("not a path in the Drive"); }
    let out: Vec<String> = segs.iter().map(|s| drive_segment(s)).collect();
    if out.iter().any(|s| s.is_empty() || s == "." || s == ".." || s.contains('/') || s.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)) { return Err("not a path in the Drive"); }
    if HIDDEN_TOP.contains(&out[0].as_str()) { return Err("that folder is the server's own"); }
    Ok(out.join("/"))
}

/// Files Windows and its programs make beside a person's own: lock files, temporary saves, folder settings. They stay on this computer.
pub fn is_transient(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with("~$") || n.starts_with(".~lock.") || n.ends_with(".tmp") || n.ends_with(".crdownload") || n.ends_with(".partial") || n == "desktop.ini" || n == "thumbs.db" || n == ".ds_store"
}

fn lower(s: &str) -> String { s.to_lowercase() }

/// One change the server reported (`files.drive.space.changes` items).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub path: String,
    pub size: u64,
    pub version: u64,
    pub seq: u64,
    pub deleted: bool,
}

impl Change {
    pub fn from_json(v: &Value) -> Option<Change> {
        Some(Change {
            path: v.get("path")?.as_str()?.to_string(),
            size: v.get("size").and_then(Value::as_u64).unwrap_or(0),
            version: v.get("version")?.as_u64()?,
            seq: v.get("seq").and_then(Value::as_u64).unwrap_or(0),
            deleted: v.get("deleted").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

/// What Explorer's placeholders should do, in the order to do it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    /// Make a folder (parents come first).
    Dir { local: String },
    /// Make or update a placeholder for a file: its bytes are fetched when it is opened.
    File { local: String, drive: String, size: u64, version: u64 },
    RemoveFile { local: String },
    /// A folder left with nothing in it.
    RemoveDir { local: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    version: u64,
    size: u64,
    local: String,
}

/// What this computer knows of the Drive: every file with its version, the name it has here, and the anchor to ask the server from. Windows is case-insensitive and the Drive is not, so two paths
/// that differ only in case are kept apart here by a " (2)" in the later one's name, and a folder keeps the spelling it was first seen with.
#[derive(Debug, Default, Clone)]
pub struct Mirror {
    files: BTreeMap<String, Entry>,
    /// lowercase local path -> Drive path, for every file
    taken: BTreeMap<String, String>,
    /// lowercase local folder -> its spelling
    dirs: BTreeMap<String, String>,
    pub anchor: Option<u64>,
}

impl Mirror {
    pub fn new() -> Mirror { Mirror::default() }

    pub fn version_of(&self, drive: &str) -> Option<u64> { self.files.get(drive).map(|e| e.version) }
    pub fn local_of(&self, drive: &str) -> Option<&str> { self.files.get(drive).map(|e| e.local.as_str()) }
    pub fn size_of(&self, drive: &str) -> Option<u64> { self.files.get(drive).map(|e| e.size) }
    pub fn len(&self) -> usize { self.files.len() }
    pub fn is_empty(&self) -> bool { self.files.is_empty() }

    /// The Drive path of a known local file (a path under the sync root, either slash).
    pub fn drive_of(&self, local: &str) -> Option<String> {
        self.taken.get(&lower(&local.replace('\\', "/"))).cloned()
    }

    /// The folder part spelled as first seen, and the file name made unique among its folder's files.
    fn place(&mut self, drive: &str, local: &str) -> (String, Vec<String>) {
        let segs: Vec<&str> = local.split('/').collect();
        let mut out: Vec<String> = Vec::new();
        let mut new_dirs: Vec<String> = Vec::new();
        for (i, s) in segs.iter().enumerate() {
            if i + 1 == segs.len() { break; }
            let mut path = out.clone();
            path.push((*s).to_string());
            let key = lower(&path.join("/"));
            match self.dirs.get(&key) {
                Some(spelt) => out = spelt.split('/').map(String::from).collect(),
                None => {
                    let spelt = path.join("/");
                    self.dirs.insert(key, spelt.clone());
                    new_dirs.push(spelt);
                    out = path;
                }
            }
        }
        let name = segs[segs.len() - 1];
        let mut candidate = out.iter().cloned().chain(std::iter::once(name.to_string())).collect::<Vec<_>>().join("/");
        let mut n = 2;
        while self.taken.get(&lower(&candidate)).map_or(false, |d| d != drive) {
            let (stem, ext) = match name.rfind('.') { Some(i) if i > 0 => (&name[..i], &name[i..]), _ => (name, "") };
            let alt = format!("{stem} ({n}){ext}");
            candidate = out.iter().cloned().chain(std::iter::once(alt)).collect::<Vec<_>>().join("/");
            n += 1;
        }
        (candidate, new_dirs)
    }

    fn has_children(&self, dir_lower: &str) -> bool {
        let pre = format!("{dir_lower}/");
        self.taken.range(pre.clone()..).next().map_or(false, |(k, _)| k.starts_with(&pre))
    }

    /// Apply a page of the server's changes, oldest first. Idempotent: a change at or below the version already known is skipped, so asking again from an old anchor is safe.
    pub fn apply(&mut self, items: &[Change], anchor: u64) -> Vec<Op> {
        let mut ops = Vec::new();
        for c in items {
            let Some(local) = local_path(&c.path) else { continue };
            if c.path.rsplit('/').next().map_or(false, is_transient) { continue; }
            if c.deleted {
                let Some(e) = self.files.remove(&c.path) else { continue };
                self.taken.remove(&lower(&e.local));
                ops.push(Op::RemoveFile { local: e.local.clone() });
                // empty folders go, innermost first
                let mut parts: Vec<&str> = e.local.split('/').collect();
                parts.pop();
                while !parts.is_empty() {
                    let dir = parts.join("/");
                    let key = lower(&dir);
                    if self.has_children(&key) { break; }
                    if let Some(spelt) = self.dirs.remove(&key) { ops.push(Op::RemoveDir { local: spelt }); }
                    parts.pop();
                }
                continue;
            }
            if self.files.get(&c.path).map_or(false, |e| e.version >= c.version) { continue; }
            let (placed, new_dirs) = match self.files.get(&c.path) {
                Some(e) => (e.local.clone(), Vec::new()),
                None => self.place(&c.path, &local),
            };
            for d in new_dirs { ops.push(Op::Dir { local: d }); }
            self.taken.insert(lower(&placed), c.path.clone());
            self.files.insert(c.path.clone(), Entry { version: c.version, size: c.size, local: placed.clone() });
            ops.push(Op::File { local: placed, drive: c.path.clone(), size: c.size, version: c.version });
        }
        self.anchor = Some(anchor);
        ops
    }

    /// This computer wrote a new version itself (an upload finished): remember it, so the same change coming back from the server is not shown twice.
    pub fn note_written(&mut self, drive: &str, version: u64, size: u64) -> Option<Vec<Op>> {
        let local = local_path(drive)?;
        let (placed, new_dirs) = match self.files.get(drive) {
            Some(e) => (e.local.clone(), Vec::new()),
            None => self.place(drive, &local),
        };
        self.taken.insert(lower(&placed), drive.to_string());
        self.files.insert(drive.to_string(), Entry { version, size, local: placed });
        Some(new_dirs.into_iter().map(|d| Op::Dir { local: d }).collect())
    }

    /// This computer moved or trashed a file itself: forget it here (the server's change will not undo it).
    pub fn note_gone(&mut self, drive: &str) {
        if let Some(e) = self.files.remove(drive) { self.taken.remove(&lower(&e.local)); }
    }

    /// Every known file under a local folder (either slash, any case): (Drive path, local path). A rename or delete of a folder acts on each of them.
    pub fn files_under(&self, local_dir: &str) -> Vec<(String, String)> {
        let pre = format!("{}/", lower(local_dir.replace('\\', "/").trim_end_matches('/')));
        self.taken.range(pre.clone()..).take_while(|(k, _)| k.starts_with(&pre)).map(|(_, d)| (d.clone(), self.files[d].local.clone())).collect()
    }

    pub fn dir_names(&self) -> BTreeSet<String> { self.dirs.values().cloned().collect() }
}

/// One server tool call.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub tool: &'static str,
    pub input: Value,
}

/// The server's refusal or absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallError {
    pub code: String,
    pub message: String,
}

/// The way the mount reaches the server: as the person, through the link page's device channel. A fake in tests.
pub trait VyreCall {
    fn call(&self, tool: &str, input: Value) -> Result<Value, CallError>;
}

/// Ask the server for what changed since the mirror's anchor, page by page, and apply it. A restart with no anchor lists everything.
pub fn pull(mirror: &mut Mirror, server: &dyn VyreCall) -> Result<Vec<Op>, CallError> {
    let mut all = Vec::new();
    loop {
        let mut input = json!({ "limit": 500 });
        if let Some(a) = mirror.anchor { input["since"] = json!(a); }
        let r = server.call("files.drive.space.changes", input)?;
        let items: Vec<Change> = r.get("items").and_then(Value::as_array).map(|a| a.iter().filter_map(Change::from_json).collect()).unwrap_or_default();
        let anchor = r.get("anchor").and_then(Value::as_u64).ok_or(CallError { code: "bad_answer".into(), message: "the server gave no anchor".into() })?;
        let more = r.get("more").and_then(Value::as_bool).unwrap_or(false);
        all.extend(mirror.apply(&items, anchor));
        if !more { return Ok(all); }
    }
}

/// How a local file's bytes go up: one call when they fit, else parts of PART bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadPlan {
    One,
    Parts(Vec<(u64, usize)>),
}

pub fn upload_plan(size: u64) -> UploadPlan {
    if size <= ONE_CALL as u64 { return UploadPlan::One; }
    UploadPlan::Parts(ranges(size))
}

/// (offset, length) pieces of PART bytes covering `size`. Also how a big file is read.
pub fn ranges(size: u64) -> Vec<(u64, usize)> {
    let mut out = Vec::new();
    let mut at = 0u64;
    while at < size {
        let len = std::cmp::min(PART as u64, size - at) as usize;
        out.push((at, len));
        at += len as u64;
    }
    out
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn upload_call(drive: &str, bytes: &[u8], base: Option<u64>) -> Call {
    let mut input = json!({ "path": drive, "base64": b64(bytes) });
    if let Some(b) = base { input["base"] = json!(b); }
    Call { tool: "files.drive.upload", input }
}
pub fn begin_call(drive: &str, base: Option<u64>) -> Call {
    let mut input = json!({ "path": drive });
    if let Some(b) = base { input["base"] = json!(b); }
    Call { tool: "files.drive.space.upload.begin", input }
}
pub fn part_call(upload: &str, index: usize, bytes: &[u8]) -> Call {
    Call { tool: "files.drive.space.upload.part", input: json!({ "upload": upload, "index": index, "base64": b64(bytes) }) }
}
pub fn commit_call(upload: &str, parts: usize) -> Call {
    Call { tool: "files.drive.space.upload.commit", input: json!({ "upload": upload, "parts": parts }) }
}
pub fn read_call(drive: &str, version: u64, offset: u64, length: usize) -> Call {
    Call { tool: "files.drive.space.read", input: json!({ "path": drive, "version": version, "offset": offset, "length": length }) }
}

/// What Explorer's delete becomes: the file goes to the server's trash (nothing is lost, an owner or admin can bring it back). None for a file this computer does not know.
pub fn delete_call(mirror: &Mirror, local: &str) -> Option<Call> {
    let drive = mirror.drive_of(local)?;
    Some(Call { tool: "files.drive.space.trash", input: json!({ "path": drive }) })
}

/// What a rename or move in Explorer becomes. Err for a target the Drive would not take.
pub fn move_call(mirror: &Mirror, from_local: &str, to_local: &str) -> Result<Option<Call>, &'static str> {
    let to = drive_path(to_local)?;
    let Some(from) = mirror.drive_of(from_local) else { return Ok(None) };
    Ok(Some(Call { tool: "files.drive.space.move", input: json!({ "from": from, "to": to }) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn ch(path: &str, version: u64, seq: u64, deleted: bool) -> Change { Change { path: path.into(), size: if deleted { 0 } else { 10 }, version, seq, deleted } }

    #[test]
    fn names_round_trip_and_hide_the_server_folders() {
        for p in ["Clients/A/retainer.pdf", "a:b/c?d.txt", "100%/x", "50%off.txt", "100%25.txt", "x/ends.", "x/ends ", "emoji/\u{1F600}.txt", "q\"uote|pipe<>*"] {
            let l = local_path(p).unwrap_or_else(|| panic!("{p}"));
            assert!(!l.contains(['<', '>', ':', '"', '|', '?', '*', '\\']), "{l}");
            assert!(!l.ends_with('.') && !l.ends_with(' '), "{l}");
            assert_eq!(drive_path(&l).unwrap(), p, "{p} -> {l}");
        }
        assert_eq!(local_path("a:b").unwrap(), "a%3Ab");
        assert_eq!(local_path("100%25.txt").unwrap(), "100%2525.txt");
        assert_eq!(local_path("50%off").unwrap(), "50%off", "a lone percent stays");
        assert_eq!(local_path(".trash/a.txt"), None);
        assert_eq!(local_path(".upload/x/0"), None);
        assert_eq!(local_path(".trashy/a.txt").unwrap(), ".trashy/a.txt");
        assert_eq!(local_path("a//b"), None);
        assert!(drive_path("tab%01char").is_err(), "a control character is not a Drive name, escaped or not");
        assert_eq!(local_path(&format!("{}.txt", "x".repeat(300))), None, "longer than Windows allows");
    }

    #[test]
    fn a_local_path_that_is_not_a_drive_path_is_refused() {
        for bad in ["", "..\\x", "a/../b", "a//b", "./a", ".trash/a", ".upload\\x", "a/%2e%2e/b"] {
            assert!(drive_path(bad).is_err(), "{bad}");
        }
        assert_eq!(drive_path("a\\b\\c.txt").unwrap(), "a/b/c.txt");
        assert!(drive_path(".trash/a").is_err());
        assert!(drive_path("a/%2e%2e/b").is_err(), "an escaped dot-dot is still dot-dot");
        assert!(drive_path("a/%2fb").is_err(), "an escaped slash is not a name");
        assert!(drive_path("a/%00b").is_err());
    }

    #[test]
    fn transient_files_stay_local() {
        for n in ["~$report.docx", ".~lock.a.odt#", "x.tmp", "Desktop.ini", "THUMBS.DB", "a.crdownload"] { assert!(is_transient(n), "{n}"); }
        for n in ["report.docx", "tmp", "a.tmpl", "notes.txt"] { assert!(!is_transient(n), "{n}"); }
    }

    #[test]
    fn the_first_listing_makes_folders_then_files_and_skips_hidden_and_transient() {
        let mut m = Mirror::new();
        let ops = m.apply(&[ch("a/b/one.txt", 1, 1, false), ch("a/two.txt", 1, 2, false), ch(".trash/old.txt", 1, 3, false), ch("a/~$lock.docx", 1, 4, false)], 4);
        assert_eq!(ops, vec![
            Op::Dir { local: "a".into() }, Op::Dir { local: "a/b".into() },
            Op::File { local: "a/b/one.txt".into(), drive: "a/b/one.txt".into(), size: 10, version: 1 },
            Op::File { local: "a/two.txt".into(), drive: "a/two.txt".into(), size: 10, version: 1 },
        ]);
        assert_eq!(m.anchor, Some(4));
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn a_change_at_a_known_version_is_skipped_and_a_newer_one_updates_in_place() {
        let mut m = Mirror::new();
        m.apply(&[ch("a.txt", 2, 1, false)], 1);
        assert!(m.apply(&[ch("a.txt", 2, 1, false)], 1).is_empty(), "asking again from an old anchor is safe");
        assert!(m.apply(&[ch("a.txt", 1, 1, false)], 1).is_empty());
        let ops = m.apply(&[ch("a.txt", 3, 5, false)], 5);
        assert_eq!(ops, vec![Op::File { local: "a.txt".into(), drive: "a.txt".into(), size: 10, version: 3 }]);
    }

    #[test]
    fn a_delete_removes_the_file_and_the_folders_it_leaves_empty_but_not_the_ones_still_in_use() {
        let mut m = Mirror::new();
        m.apply(&[ch("a/b/one.txt", 1, 1, false), ch("a/two.txt", 1, 2, false)], 2);
        let ops = m.apply(&[ch("a/b/one.txt", 2, 3, true)], 3);
        assert_eq!(ops, vec![Op::RemoveFile { local: "a/b/one.txt".into() }, Op::RemoveDir { local: "a/b".into() }]);
        let ops = m.apply(&[ch("a/two.txt", 2, 4, true)], 4);
        assert_eq!(ops, vec![Op::RemoveFile { local: "a/two.txt".into() }, Op::RemoveDir { local: "a".into() }]);
        assert!(m.is_empty());
        assert!(m.apply(&[ch("never.txt", 2, 5, true)], 5).is_empty(), "a delete of an unknown file does nothing");
    }

    #[test]
    fn paths_that_differ_only_in_case_are_kept_apart_and_folders_keep_their_first_spelling() {
        let mut m = Mirror::new();
        let ops = m.apply(&[ch("Docs/Report.txt", 1, 1, false), ch("docs/report.txt", 1, 2, false), ch("DOCS/other.txt", 1, 3, false)], 3);
        assert_eq!(m.local_of("Docs/Report.txt"), Some("Docs/Report.txt"));
        assert_eq!(m.local_of("docs/report.txt"), Some("Docs/report (2).txt"));
        assert_eq!(m.local_of("DOCS/other.txt"), Some("Docs/other.txt"));
        assert_eq!(ops.iter().filter(|o| matches!(o, Op::Dir { .. })).count(), 1, "one folder, not three");
        // removing the first frees its name; the second keeps the name it has
        m.apply(&[ch("Docs/Report.txt", 2, 4, true)], 4);
        assert_eq!(m.local_of("docs/report.txt"), Some("Docs/report (2).txt"));
        assert_eq!(m.drive_of("docs/report (2).txt").as_deref(), Some("docs/report.txt"), "found by its local name in any case");
    }

    #[test]
    fn a_folder_names_every_file_under_it_in_any_case_and_either_slash() {
        let mut m = Mirror::new();
        m.apply(&[ch("Docs/a.txt", 1, 1, false), ch("Docs/sub/b.txt", 1, 2, false), ch("Docsx/c.txt", 1, 3, false), ch("other/d.txt", 1, 4, false)], 4);
        let under = m.files_under("docs\\");
        assert_eq!(under, vec![("Docs/a.txt".to_string(), "Docs/a.txt".to_string()), ("Docs/sub/b.txt".to_string(), "Docs/sub/b.txt".to_string())]);
        assert!(m.files_under("nothing").is_empty());
    }

    #[test]
    fn a_write_made_here_is_remembered_so_the_same_change_coming_back_shows_nothing() {
        let mut m = Mirror::new();
        let dirs = m.note_written("x/new.txt", 1, 5).unwrap();
        assert_eq!(dirs, vec![Op::Dir { local: "x".into() }]);
        assert!(m.apply(&[ch("x/new.txt", 1, 7, false)], 7).is_empty());
        m.note_gone("x/new.txt");
        assert_eq!(m.drive_of("x/new.txt"), None);
    }

    struct Fake { pages: RefCell<Vec<Value>>, seen: RefCell<Vec<Value>> }
    impl VyreCall for Fake {
        fn call(&self, tool: &str, input: Value) -> Result<Value, CallError> {
            assert_eq!(tool, "files.drive.space.changes");
            self.seen.borrow_mut().push(input);
            let mut p = self.pages.borrow_mut();
            if p.is_empty() { return Err(CallError { code: "unavailable".into(), message: "x".into() }); }
            Ok(p.remove(0))
        }
    }

    #[test]
    fn pull_follows_the_pages_and_asks_again_from_the_anchor_it_was_given() {
        let page = |items: Vec<Value>, anchor: u64, more: bool| json!({ "items": items, "anchor": anchor, "more": more });
        let item = |p: &str, v: u64, s: u64| json!({ "path": p, "size": 3, "version": v, "seq": s, "deleted": false });
        let f = Fake { pages: RefCell::new(vec![page(vec![item("a.txt", 1, 1), item("b.txt", 1, 2)], 2, true), page(vec![item("c.txt", 1, 3)], 3, false), page(vec![], 3, false)]), seen: RefCell::new(vec![]) };
        let mut m = Mirror::new();
        let ops = pull(&mut m, &f).unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!(f.seen.borrow()[0], json!({ "limit": 500 }), "the first listing has no anchor");
        assert_eq!(f.seen.borrow()[1], json!({ "limit": 500, "since": 2 }));
        assert_eq!(m.anchor, Some(3));
        assert!(pull(&mut m, &f).unwrap().is_empty());
        assert_eq!(f.seen.borrow()[2], json!({ "limit": 500, "since": 3 }));
        assert_eq!(pull(&mut m, &f).unwrap_err().code, "unavailable", "a refusal comes back as it is");
    }

    #[test]
    fn a_page_without_an_anchor_is_refused() {
        let f = Fake { pages: RefCell::new(vec![json!({ "items": [] })]), seen: RefCell::new(vec![]) };
        assert_eq!(pull(&mut Mirror::new(), &f).unwrap_err().code, "bad_answer");
    }

    #[test]
    fn big_files_go_up_in_parts_and_small_ones_in_one_call() {
        assert_eq!(upload_plan(0), UploadPlan::One);
        assert_eq!(upload_plan(ONE_CALL as u64), UploadPlan::One);
        let UploadPlan::Parts(p) = upload_plan(ONE_CALL as u64 + 1) else { panic!() };
        assert_eq!(p.len(), 3);
        assert_eq!(p[0], (0, PART));
        assert_eq!(p.iter().map(|x| x.1 as u64).sum::<u64>(), ONE_CALL as u64 + 1);
        assert!(p.windows(2).all(|w| w[0].0 + w[0].1 as u64 == w[1].0), "no gap and no overlap");
        assert!(PART * 4 / 3 + 8 < ONE_CALL, "a part's base64 stays under the one-call cap");
    }

    #[test]
    fn local_acts_become_the_right_server_calls() {
        let mut m = Mirror::new();
        m.apply(&[ch("a/b.txt", 3, 1, false)], 1);
        assert_eq!(delete_call(&m, "a\\b.txt").unwrap(), Call { tool: "files.drive.space.trash", input: json!({ "path": "a/b.txt" }) });
        assert_eq!(delete_call(&m, "a/unknown.txt"), None);
        assert_eq!(move_call(&m, "A/B.txt", "a/c d.txt").unwrap().unwrap(), Call { tool: "files.drive.space.move", input: json!({ "from": "a/b.txt", "to": "a/c d.txt" }) });
        assert_eq!(move_call(&m, "a/b.txt", "a/x%3Ay.txt").unwrap().unwrap().input["to"], json!("a/x:y.txt"), "an escaped name goes up as the real one");
        assert!(move_call(&m, "a/b.txt", ".trash/b.txt").is_err());
        assert!(move_call(&m, "a/b.txt", "../b.txt").is_err());
        assert_eq!(move_call(&m, "nope.txt", "a/z.txt").unwrap(), None);
        assert_eq!(upload_call("a/b.txt", b"hi", Some(3)), Call { tool: "files.drive.upload", input: json!({ "path": "a/b.txt", "base64": "aGk=", "base": 3 }) });
        assert_eq!(upload_call("a/b.txt", b"hi", None).input.get("base"), None);
        assert_eq!(begin_call("a/b.txt", None).tool, "files.drive.space.upload.begin");
        assert_eq!(part_call("u1", 2, b"hi").input, json!({ "upload": "u1", "index": 2, "base64": "aGk=" }));
        assert_eq!(commit_call("u1", 3).input, json!({ "upload": "u1", "parts": 3 }));
        assert_eq!(read_call("a/b.txt", 3, 4, 5).input, json!({ "path": "a/b.txt", "version": 3, "offset": 4, "length": 5 }));
    }
}
