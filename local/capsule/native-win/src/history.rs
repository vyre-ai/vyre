//! What agent sessions this PC holds, without reading what was said (#26, docs/design/import.md).
//!
//! This is the discovery half of "Import my history" for the Windows app, which has no local vyred
//! (the 0.2 pivot), so it cannot call `import.scan`. It reads the same places the import module
//! reads (Claude Code, Codex, Grok, Gemini CLI), lists session files by name, size and time, and
//! finds the folder each session ran in from the head of the file only. It answers in
//! `import.scan`'s shape so a later local core can replace it without a new screen. Nothing is
//! sent anywhere, no turn is read, a link is never followed, and credential folders are never
//! walked.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// The caps of one scan (the import module's): files listed, and bytes of file heads read.
pub const MAX_FILES: usize = 20_000;
pub const MAX_HEAD_BYTES: u64 = 64 * 1024 * 1024;
/// How much of a session's start is read to find its folder.
const HEAD: u64 = 16 * 1024;
const CODEX_HEAD: u64 = 256 * 1024;
const DEPTH: usize = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind { Claude, Codex, Grok, Gemini }

impl Kind {
    /// The agent name `import.scan` uses.
    pub fn agent(self) -> &'static str {
        match self { Kind::Claude => "claude-code", Kind::Codex => "codex", Kind::Grok => "grok", Kind::Gemini => "gemini-cli" }
    }
}

#[derive(Clone, Debug)]
pub struct Root { pub kind: Kind, pub path: PathBuf }

/// What a scan leaves unsuggested: temporary folders, and Vyre's own home.
#[derive(Clone, Default, Debug)]
pub struct Opts { pub temp: Vec<PathBuf>, pub vyre_home: Option<PathBuf> }

fn tilde(p: &str, home: &Path) -> PathBuf {
    if p == "~" { return home.to_path_buf(); }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) { return home.join(rest); }
    PathBuf::from(p)
}

/// Where each agent keeps its sessions on this PC. `get` reads an environment variable.
/// Claude Code: CLAUDE_CONFIG_DIR\projects or ~\.claude\projects. Codex: CODEX_HOME or ~\.codex.
/// Grok: GROK_HOME or ~\.grok. Gemini CLI: ~\.gemini. VYRE_<AGENT>_HOME overrides each.
pub fn agent_roots(get: &dyn Fn(&str) -> Option<String>, home: &Path) -> Vec<Root> {
    let pick = |names: &[&str], default: PathBuf| -> PathBuf {
        for n in names { if let Some(v) = get(n).filter(|v| !v.trim().is_empty()) { return tilde(v.trim(), home); } }
        default
    };
    let claude = match get("VYRE_CLAUDE_HOME").or_else(|| get("CLAUDE_CONFIG_DIR")).filter(|v| !v.trim().is_empty()) {
        Some(v) => tilde(v.trim(), home).join("projects"),
        None => home.join(".claude").join("projects"),
    };
    vec![
        Root { kind: Kind::Claude, path: claude },
        Root { kind: Kind::Codex, path: pick(&["VYRE_CODEX_HOME", "CODEX_HOME"], home.join(".codex")) },
        Root { kind: Kind::Grok, path: pick(&["VYRE_GROK_HOME", "GROK_HOME"], home.join(".grok")) },
        Root { kind: Kind::Gemini, path: pick(&["VYRE_GEMINI_HOME"], home.join(".gemini")) },
    ]
}

/// Folders a scan never enters: keys and credentials.
fn forbidden(p: &Path) -> bool {
    const SECRET: [&str; 7] = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store"];
    p.components().any(|c| SECRET.iter().any(|s| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(s)))
}

struct File { path: PathBuf, id: String, bytes: u64, mtime_ms: i64 }

fn entry(path: &Path, id: String) -> Option<File> {
    let md = fs::symlink_metadata(path).ok()?;
    if !md.file_type().is_file() { return None; }
    let mtime_ms = md.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
    Some(File { path: path.to_path_buf(), id, bytes: md.len(), mtime_ms })
}

/// Sub-directories (never links) of `dir` whose name satisfies `ok`, sorted.
fn subdirs(dir: &Path, ok: &dyn Fn(&str) -> bool) -> Vec<PathBuf> {
    let mut out = vec![];
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) && ok(&name) { out.push(e.path()); }
        }
    }
    out.sort();
    out
}

fn all_digits(s: &str, n: usize) -> bool { s.len() == n && s.bytes().all(|b| b.is_ascii_digit()) }

fn is_uuid(s: &str) -> bool {
    let p: Vec<&str> = s.split('-').collect();
    p.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&p).all(|(n, x)| x.len() == *n && x.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn list_claude(root: &Path, files: &mut Vec<File>) {
    fn walk(dir: &Path, depth: usize, files: &mut Vec<File>) {
        if files.len() >= MAX_FILES { return; }
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut ents: Vec<_> = rd.flatten().collect();
        ents.sort_by_key(|e| e.file_name());
        for e in ents {
            let name = e.file_name().to_string_lossy().to_string();
            let p = e.path();
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                if depth < DEPTH && name != "node_modules" && name != ".git" && name != "subagents" && !name.starts_with('.') && !forbidden(&p) { walk(&p, depth + 1, files); }
            } else if t.is_file() && name.ends_with(".jsonl") {
                if let Some(f) = entry(&p, name[..name.len() - 6].to_string()) { files.push(f); }
            }
        }
    }
    if !forbidden(root) { walk(root, 0, files); }
}

fn list_codex(home: &Path, files: &mut Vec<File>) {
    for y in subdirs(&home.join("sessions"), &|n| all_digits(n, 4)) {
        for m in subdirs(&y, &|n| all_digits(n, 2)) {
            for d in subdirs(&m, &|n| all_digits(n, 2)) {
                let Ok(rd) = fs::read_dir(&d) else { continue };
                let mut ents: Vec<_> = rd.flatten().collect();
                ents.sort_by_key(|e| e.file_name());
                for e in ents {
                    let name = e.file_name().to_string_lossy().to_string();
                    if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) { continue; }
                    let stem = &name[..name.len() - 6];
                    // The session id is the trailing uuid when the name carries one.
                    let id = stem.get(stem.len().saturating_sub(36)..).filter(|t| is_uuid(t)).unwrap_or(stem).to_lowercase();
                    if let Some(f) = entry(&e.path(), id) { files.push(f); }
                }
            }
        }
    }
}

fn list_grok(home: &Path, files: &mut Vec<File>) {
    for folder in subdirs(&home.join("sessions"), &|_| true) {
        for dir in subdirs(&folder, &|n| is_uuid(n)) {
            let id = dir.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if let Some(f) = entry(&dir.join("chat_history.jsonl"), id) { files.push(f); }
        }
    }
}

fn list_gemini(home: &Path, files: &mut Vec<File>) {
    for h in subdirs(&home.join("tmp"), &|n| n.len() == 64 && n.bytes().all(|b| b.is_ascii_hexdigit())) {
        let Ok(rd) = fs::read_dir(h.join("chats")) else { continue };
        let mut ents: Vec<_> = rd.flatten().collect();
        ents.sort_by_key(|e| e.file_name());
        for e in ents {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("session-") { continue; }
            let stem = name.strip_suffix(".jsonl").or_else(|| name.strip_suffix(".json"));
            if let Some(stem) = stem { if let Some(f) = entry(&e.path(), format!("gemini-{stem}")) { files.push(f); } }
        }
    }
}

fn head_text(path: &Path, max: u64) -> Option<String> {
    let mut buf = vec![];
    fs::File::open(path).ok()?.take(max).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).to_string())
}

fn string_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> { v.get(key).and_then(|c| c.as_str()).filter(|s| !s.is_empty()) }

/// Claude Code writes `cwd` on its first entries.
fn cwd_claude(text: &str) -> Option<String> {
    text.lines().filter(|l| l.contains("\"cwd\"")).find_map(|l| serde_json::from_str::<Value>(l).ok().and_then(|j| string_at(&j, "cwd").map(String::from)))
}

/// Codex: `cwd` in the session_meta payload, or an `<cwd>` tag in an early message.
fn cwd_codex(text: &str) -> Option<String> {
    for row in text.lines().filter(|r| !r.trim().is_empty()) {
        let Ok(o) = serde_json::from_str::<Value>(row) else { continue };
        let p = match o.get("payload") { Some(p) if p.is_object() => p, _ => &o };
        if let Some(c) = string_at(p, "cwd") { return Some(c.to_string()); }
        if p.get("type").and_then(|t| t.as_str()) == Some("message") {
            let body: String = p.get("content").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|c| c.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            if let Some(i) = body.find("<cwd>") { if let Some(j) = body[i + 5..].find("</cwd>") { let c = body[i + 5..i + 5 + j].trim(); if !c.is_empty() { return Some(c.to_string()); } } }
        }
    }
    None
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else { out.push(b[i]); i += 1; }
    }
    String::from_utf8(out).ok()
}

/// Grok: summary.json's info.cwd, else the percent-encoded folder name.
fn cwd_grok(file: &Path) -> Option<String> {
    let dir = file.parent()?;
    if let Some(j) = head_text(&dir.join("summary.json"), HEAD).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        if let Some(c) = j.get("info").and_then(|i| string_at(i, "cwd")) { return Some(c.to_string()); }
    }
    let name = dir.parent()?.file_name()?.to_string_lossy().to_string();
    let c = percent_decode(&name)?;
    let drive = c.len() >= 3 && c.as_bytes()[0].is_ascii_alphabetic() && c.as_bytes()[1] == b':' && (c.as_bytes()[2] == b'\\' || c.as_bytes()[2] == b'/');
    if c.starts_with('/') || drive { Some(c) } else { None }
}

/// Lower-cased, forward-slashed, no trailing slash: how two Windows paths are compared.
fn norm(p: &str) -> String { p.replace('\\', "/").trim_end_matches('/').to_lowercase() }

fn under(cwd: &str, base: &Path) -> bool {
    let (c, b) = (norm(cwd), norm(&base.to_string_lossy()));
    !b.is_empty() && (c == b || c.starts_with(&format!("{b}/")))
}

fn why_not_suggested(cwd: Option<&str>, o: &Opts) -> Option<&'static str> {
    let Some(c) = cwd else { return Some("the folder it ran in is unknown") };
    if o.vyre_home.as_deref().map(|h| under(c, h)).unwrap_or(false) { return Some("Vyre's own sessions"); }
    if o.temp.iter().any(|t| under(c, t)) || norm(c).starts_with("/tmp/") { return Some("a temporary folder"); }
    None
}

fn leaf(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(cwd).to_string()
}

/// The `import.scan` shape: `{ sources: [{ id, path, kind, agent, sessions, bytes, from, to, folders: [...] }], left_out, capped }`.
/// Sources with no sessions are left out; `looked_in` names every folder that was checked.
pub fn scan(roots: &[Root], o: &Opts) -> Value {
    let mut sources = vec![];
    let mut seen: HashSet<String> = HashSet::new();
    let (mut budget, mut capped, mut total) = (MAX_HEAD_BYTES as i64, false, 0usize);
    let looked: Vec<String> = roots.iter().map(|r| r.path.to_string_lossy().to_string()).collect();
    for r in roots {
        let mut files = vec![];
        match r.kind {
            Kind::Claude => list_claude(&r.path, &mut files),
            Kind::Codex => list_codex(&r.path, &mut files),
            Kind::Grok => list_grok(&r.path, &mut files),
            Kind::Gemini => list_gemini(&r.path, &mut files),
        }
        if files.len() >= MAX_FILES { capped = true; }
        // folder key (None = unknown) -> (cwd, sessions, bytes, from, to)
        let mut by: BTreeMap<String, (Option<String>, usize, u64, i64, i64)> = BTreeMap::new();
        let (mut bytes, mut from, mut to, mut sessions) = (0u64, i64::MAX, 0i64, 0usize);
        for f in files {
            if !seen.insert(f.id.clone()) { continue; }
            total += 1;
            if total > MAX_FILES { capped = true; break; }
            let head = match r.kind { Kind::Codex => CODEX_HEAD, Kind::Gemini => 0, _ => HEAD };
            let cwd = if budget <= 0 { capped = true; None } else {
                budget -= head.min(f.bytes) as i64;
                match r.kind {
                    Kind::Claude => head_text(&f.path, HEAD).and_then(|t| cwd_claude(&t)),
                    Kind::Codex => head_text(&f.path, CODEX_HEAD).and_then(|t| cwd_codex(&t)),
                    Kind::Grok => cwd_grok(&f.path),
                    Kind::Gemini => None,
                }
            };
            sessions += 1; bytes += f.bytes; from = from.min(f.mtime_ms); to = to.max(f.mtime_ms);
            let g = by.entry(cwd.clone().unwrap_or_default()).or_insert((cwd, 0, 0, i64::MAX, 0));
            g.1 += 1; g.2 += f.bytes; g.3 = g.3.min(f.mtime_ms); g.4 = g.4.max(f.mtime_ms);
        }
        if sessions == 0 { continue; }
        let mut folders: Vec<(Option<String>, usize, u64, i64, i64)> = by.into_values().collect();
        folders.sort_by(|a, b| b.4.cmp(&a.4).then_with(|| a.0.cmp(&b.0)));
        let folders: Vec<Value> = folders.into_iter().map(|(cwd, n, b, f, t)| {
            let why = why_not_suggested(cwd.as_deref(), o);
            let mut m = Map::new();
            m.insert("cwd".into(), cwd.as_ref().map(|c| json!(c)).unwrap_or(Value::Null));
            m.insert("sessions".into(), json!(n)); m.insert("bytes".into(), json!(b));
            m.insert("from".into(), json!(f)); m.insert("to".into(), json!(t));
            if let Some(c) = &cwd { m.insert("name".into(), json!(leaf(c))); }
            m.insert("suggested".into(), json!(why.is_none()));
            if let Some(w) = why { m.insert("why".into(), json!(w)); }
            Value::Object(m)
        }).collect();
        sources.push(json!({ "id": format!("{}:{}", r.kind.agent(), r.path.to_string_lossy()), "path": r.path.to_string_lossy(), "kind": r.kind.agent(), "agent": r.kind.agent(),
            "sessions": sessions, "bytes": bytes, "from": from, "to": to, "folders": folders }));
    }
    json!({ "sources": sources, "left_out": { "vyre": 0, "excluded": 0 }, "capped": capped, "looked_in": looked })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);
    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vyre-history-{}-{}-{}", std::process::id(), tag, N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn put(p: &Path, text: &str) { fs::create_dir_all(p.parent().unwrap()).unwrap(); fs::write(p, text).unwrap(); }
    const UUID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const UUID2: &str = "1a9fbe6c-e0dc-47a0-b276-81978839a61f";

    #[test]
    fn roots_follow_the_environment_and_the_profile() {
        let home = PathBuf::from("C:\\Users\\alex");
        let none = |_: &str| None;
        let r = agent_roots(&none, &home);
        assert_eq!(r[0].path, home.join(".claude").join("projects"));
        assert_eq!(r[1].path, home.join(".codex"));
        assert_eq!(r[2].path, home.join(".grok"));
        assert_eq!(r[3].path, home.join(".gemini"));
        let env = |k: &str| match k { "CLAUDE_CONFIG_DIR" => Some("~\\cfg".into()), "CODEX_HOME" => Some("D:\\codex".into()), "GROK_HOME" => Some("~/g".into()), _ => None };
        let r = agent_roots(&env, &home);
        assert_eq!(r[0].path, home.join("cfg").join("projects"));
        assert_eq!(r[1].path, PathBuf::from("D:\\codex"));
        assert_eq!(r[2].path, home.join("g"));
    }

    #[test]
    fn claude_sessions_group_by_folder_and_say_why_some_are_not_suggested() {
        let root = dir("claude");
        let proj = root.join("p1");
        put(&proj.join("a.jsonl"), "{\"type\":\"summary\"}\n{\"cwd\":\"C:\\\\work\\\\app\",\"type\":\"user\"}\n");
        put(&proj.join("b.jsonl"), "{\"cwd\":\"C:\\\\work\\\\app\"}\n");
        put(&root.join("p2").join("c.jsonl"), "{\"cwd\":\"C:\\\\Users\\\\alex\\\\AppData\\\\Local\\\\Temp\\\\x\"}\n");
        put(&root.join("p3").join("d.jsonl"), "{\"type\":\"summary\"}\n");
        put(&root.join("p4").join("subagents").join("e.jsonl"), "{\"cwd\":\"C:\\\\work\\\\app\"}\n");
        let o = Opts { temp: vec![PathBuf::from("C:\\Users\\alex\\AppData\\Local\\Temp")], vyre_home: None };
        let v = scan(&[Root { kind: Kind::Claude, path: root.clone() }], &o);
        let s = &v["sources"][0];
        assert_eq!(s["agent"], "claude-code");
        assert_eq!(s["sessions"], 4);
        let f = s["folders"].as_array().unwrap();
        let app = f.iter().find(|x| x["cwd"] == "C:\\work\\app").unwrap();
        assert_eq!((app["sessions"].as_u64(), app["suggested"].as_bool(), app["name"].as_str()), (Some(2), Some(true), Some("app")));
        let tmp = f.iter().find(|x| x["cwd"].as_str().map(|c| c.ends_with("\\x")).unwrap_or(false)).unwrap();
        assert_eq!((tmp["suggested"].as_bool(), tmp["why"].as_str()), (Some(false), Some("a temporary folder")));
        let unk = f.iter().find(|x| x["cwd"].is_null()).unwrap();
        assert_eq!(unk["why"], "the folder it ran in is unknown");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_grok_and_gemini_are_read_from_their_own_layouts() {
        let root = dir("others");
        let codex = root.join("codex");
        put(&codex.join("sessions/2026/09/30").join(format!("rollout-2026-09-30T10-00-00-{UUID}.jsonl")), "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\",\"cwd\":\"C:\\\\work\\\\codex-app\"}}\n");
        put(&codex.join("sessions/2026/09/30/notes.jsonl"), "{\"cwd\":\"C:\\\\no\"}\n");
        put(&codex.join("sessions/bad/09/30/rollout-1.jsonl"), "{\"cwd\":\"C:\\\\no\"}\n");
        let grok = root.join("grok");
        put(&grok.join(format!("sessions/C%3A%5Cwork%5Cgrok-app/{UUID2}/chat_history.jsonl")), "{\"type\":\"user\"}\n");
        put(&grok.join(format!("sessions/C%3A%5Cwork%5Cgrok-app/{UUID2}/summary.json")), "{\"info\":{\"cwd\":\"C:\\\\work\\\\grok-app\"}}");
        let gem = root.join("gemini");
        put(&gem.join(format!("tmp/{}/chats/session-1.jsonl", "a".repeat(64))), "{}\n");
        let roots = [Root { kind: Kind::Codex, path: codex }, Root { kind: Kind::Grok, path: grok }, Root { kind: Kind::Gemini, path: gem }];
        let v = scan(&roots, &Opts::default());
        let src = v["sources"].as_array().unwrap();
        assert_eq!(src.len(), 3);
        assert_eq!(src[0]["folders"][0]["cwd"], "C:\\work\\codex-app");
        assert_eq!(src[0]["sessions"], 1, "only sessions/YYYY/MM/DD/rollout-*.jsonl counts");
        assert_eq!(src[1]["folders"][0]["cwd"], "C:\\work\\grok-app");
        assert!(src[2]["folders"][0]["cwd"].is_null(), "Gemini keeps the folder only as a hash");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_found_lists_where_it_looked_and_a_session_counts_once() {
        let root = dir("none");
        let missing = Root { kind: Kind::Codex, path: root.join("nope") };
        let v = scan(&[missing], &Opts::default());
        assert_eq!(v["sources"].as_array().unwrap().len(), 0);
        assert_eq!(v["looked_in"].as_array().unwrap().len(), 1);
        let a = root.join("a"); let b = root.join("b");
        put(&a.join("p/same.jsonl"), "{\"cwd\":\"C:\\\\w\"}\n");
        put(&b.join("p/same.jsonl"), "{\"cwd\":\"C:\\\\w\"}\n");
        let v = scan(&[Root { kind: Kind::Claude, path: a }, Root { kind: Kind::Claude, path: b }], &Opts::default());
        assert_eq!(v["sources"].as_array().unwrap().len(), 1);
        assert_eq!(v["sources"][0]["sessions"], 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn credential_folders_are_never_walked_and_vyre_home_is_not_suggested() {
        let root = dir("secret");
        put(&root.join(".ssh/p/k.jsonl"), "{\"cwd\":\"C:\\\\w\"}\n");
        let v = scan(&[Root { kind: Kind::Claude, path: root.join(".ssh") }], &Opts::default());
        assert_eq!(v["sources"].as_array().unwrap().len(), 0);
        put(&root.join("ok/p/v.jsonl"), "{\"cwd\":\"C:\\\\Users\\\\alex\\\\.vyre\\\\home\"}\n");
        let o = Opts { temp: vec![], vyre_home: Some(PathBuf::from("C:\\Users\\alex\\.vyre")) };
        let v = scan(&[Root { kind: Kind::Claude, path: root.join("ok") }], &o);
        assert_eq!(v["sources"][0]["folders"][0]["why"], "Vyre's own sessions");
        let _ = fs::remove_dir_all(&root);
    }
}
