//! What the app may ask the local core, and how the asking is framed (#26, v0.2.3). The core speaks
//! HTTP on its named pipe; the app is its only caller. A bundled page never names a path or a header:
//! it names one of a fixed set of tools with inputs this file checks, and the app turns that into one
//! request with the caller label the core's own import tools accept. Pure: the pipe, the process check
//! and the file I/O are the app's.

use serde_json::{json, Map, Value};

/// The only tools the app calls on the core. Import is the whole of what the Windows core does for
/// the person; anything else (Drive, vault, sessions) is on the box.
pub const ALLOWED: [&str; 5] = ["import.scan", "import.plan", "import.start", "import.stop", "import.status"];
/// The caller label the core's import tools list for the person's own surfaces.
pub const CALLER: &str = "local";
/// The largest response the app reads.
pub const MAX_RESPONSE: usize = 8 << 20;

const MAX_PATH: usize = 520;
const MAX_ITEMS: usize = 5000;

fn abs_path(v: &Value) -> Option<&str> {
    let s = v.as_str()?;
    let b = s.as_bytes();
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    let unc = s.starts_with("\\\\") && !s.starts_with("\\\\?\\") && !s.starts_with("\\\\.\\");
    if s.len() > MAX_PATH || s.contains('\0') || !(drive || unc) || s.split(['\\', '/']).any(|p| p == "..") { return None; }
    Some(s)
}

fn only_keys(o: &Map<String, Value>, ok: &[&str]) -> Result<(), String> {
    match o.keys().find(|k| !ok.contains(&k.as_str())) { Some(k) => Err(format!("{k} is not an input of this call")), None => Ok(()) }
}

fn path_list(v: &Value, what: &str) -> Result<Vec<Value>, String> {
    let a = v.as_array().ok_or_else(|| format!("{what} must be a list"))?;
    if a.len() > MAX_ITEMS { return Err(format!("{what} is too long")); }
    a.iter().map(|x| abs_path(x).map(|s| json!(s)).ok_or_else(|| format!("{what} holds something that is not a full folder path"))).collect()
}

/// The input to send, rebuilt from only the fields the tool takes, or why the call is refused.
pub fn check(tool: &str, input: &Value) -> Result<Value, String> {
    if !ALLOWED.contains(&tool) { return Err(format!("{tool} is not a call the app makes")); }
    let empty = Map::new();
    let o = match input { Value::Null => &empty, Value::Object(o) => o, _ => return Err("the input must be an object".into()) };
    match tool {
        "import.scan" => {
            only_keys(o, &["folders"])?;
            Ok(match o.get("folders") { Some(f) => json!({ "folders": path_list(f, "folders")? }), None => json!({}) })
        }
        "import.plan" => {
            only_keys(o, &["include", "exclude"])?;
            let include = path_list(o.get("include").ok_or("include is needed")?, "include")?;
            Ok(match o.get("exclude") { Some(e) => json!({ "include": include, "exclude": path_list(e, "exclude")? }), None => json!({ "include": include }) })
        }
        "import.start" => {
            only_keys(o, &["plan", "mode", "pace"])?;
            let plan = o.get("plan").and_then(|v| v.as_str()).filter(|s| !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))).ok_or("plan is not a plan id")?;
            let mode = o.get("mode").and_then(|v| v.as_str()).filter(|m| ["once", "sync"].contains(m)).ok_or("mode is once or sync")?;
            let pace = o.get("pace").and_then(|v| v.as_str()).filter(|p| ["fast", "gentle"].contains(p)).ok_or("pace is fast or gentle")?;
            Ok(json!({ "plan": plan, "mode": mode, "pace": pace }))
        }
        _ => { only_keys(o, &[])?; Ok(json!({})) }
    }
}

/// One HTTP request for the pipe: no keep-alive, a body with its length, the caller label, and nothing
/// the page chose.
pub fn request(tool: &str, input: &Value) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(&check(tool, input)?).unwrap();
    let head = format!("POST /v1/tools/{tool} HTTP/1.1\r\nHost: vyred\r\nx-vyre-caller: {CALLER}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let mut out = head.into_bytes();
    out.extend_from_slice(&body);
    Ok(out)
}

/// The readiness check: the core's health, asked the same way.
pub fn health_request() -> Vec<u8> {
    format!("GET /v1/health HTTP/1.1\r\nHost: vyred\r\nx-vyre-caller: {CALLER}\r\nConnection: close\r\n\r\n").into_bytes()
}

/// The core's answer: `data` on success, or its own error message in plain words.
pub fn parse_response(raw: &[u8]) -> Result<Value, String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("the local core's answer was cut short")?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| "the local core's answer is not text")?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next().and_then(|l| l.split(' ').nth(1)).and_then(|s| s.parse().ok()).ok_or("the local core's answer has no status")?;
    let chunked = lines.clone().any(|l| l.to_ascii_lowercase().starts_with("transfer-encoding:") && l.to_ascii_lowercase().contains("chunked"));
    let length = lines.find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()));
    let rest = &raw[split + 4..];
    let body: Vec<u8> = if chunked { dechunk(rest)? } else if let Some(n) = length { if rest.len() < n { return Err("the local core's answer was cut short".into()); } rest[..n].to_vec() } else { rest.to_vec() };
    let v: Value = serde_json::from_slice(&body).map_err(|_| "the local core's answer is not JSON".to_string())?;
    if (200..300).contains(&status) {
        return v.get("data").cloned().ok_or_else(|| "the local core's answer has no data".to_string());
    }
    let msg = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("the local core refused this");
    Err(msg.chars().filter(|c| !c.is_control()).take(300).collect())
}

fn dechunk(mut rest: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = rest.windows(2).position(|w| w == b"\r\n").ok_or("the local core's answer was cut short")?;
        let size = usize::from_str_radix(std::str::from_utf8(&rest[..eol]).map_err(|_| "bad chunk")?.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "the local core's answer has a bad chunk".to_string())?;
        rest = &rest[eol + 2..];
        if size == 0 { return Ok(out); }
        if rest.len() < size + 2 || out.len() + size > MAX_RESPONSE { return Err("the local core's answer was cut short".into()); }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_import_tools_are_called() {
        assert!(check("import.status", &json!({})).is_ok());
        for t in ["vault.get", "link.call", "sync.send", "import.cancel", "../x", ""] { assert!(check(t, &json!({})).is_err(), "{t}"); }
    }

    #[test]
    fn inputs_are_rebuilt_from_known_fields_and_paths_must_be_full() {
        assert_eq!(check("import.scan", &Value::Null).unwrap(), json!({}));
        assert_eq!(check("import.scan", &json!({ "folders": ["D:\\Work\\agents"] })).unwrap(), json!({ "folders": ["D:\\Work\\agents"] }));
        assert!(check("import.scan", &json!({ "folders": ["relative\\x"] })).is_err());
        assert!(check("import.scan", &json!({ "folders": ["C:\\a\\..\\b"] })).is_err());
        assert!(check("import.scan", &json!({ "folders": ["\\\\?\\C:\\x"] })).is_err());
        assert!(check("import.scan", &json!({ "folders": "C:\\x" })).is_err());
        assert!(check("import.scan", &json!({ "extra": 1 })).is_err());
        assert!(check("import.plan", &json!({})).is_err());
        assert_eq!(check("import.plan", &json!({ "include": ["C:\\a"], "exclude": ["C:\\a\\b"] })).unwrap(), json!({ "include": ["C:\\a"], "exclude": ["C:\\a\\b"] }));
        assert_eq!(check("import.start", &json!({ "plan": "p_1-x", "mode": "once", "pace": "gentle" })).unwrap(), json!({ "plan": "p_1-x", "mode": "once", "pace": "gentle" }));
        for bad in [json!({ "plan": "a b", "mode": "once", "pace": "fast" }), json!({ "plan": "p", "mode": "always", "pace": "fast" }), json!({ "plan": "p", "mode": "once", "pace": "now" }), json!({ "plan": "p", "mode": "once" })] {
            assert!(check("import.start", &bad).is_err(), "{bad}");
        }
        assert!(check("import.stop", &json!({ "x": 1 })).is_err());
    }

    #[test]
    fn the_request_carries_the_caller_label_and_the_exact_length() {
        let r = String::from_utf8(request("import.stop", &json!({})).unwrap()).unwrap();
        assert!(r.starts_with("POST /v1/tools/import.stop HTTP/1.1\r\n"));
        assert!(r.contains("x-vyre-caller: local\r\n") && r.contains("Content-Length: 2\r\n") && r.contains("Connection: close") && r.ends_with("\r\n\r\n{}"));
        assert!(request("vault.get", &json!({})).is_err());
    }

    #[test]
    fn answers_are_read_by_length_by_chunks_or_to_the_end() {
        let body = br#"{"data":{"sessions":3}}"#;
        let by_len = [format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n", body.len()).as_bytes(), body].concat();
        assert_eq!(parse_response(&by_len).unwrap(), json!({ "sessions": 3 }));
        let chunked = [b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".as_slice(), format!("{:x}\r\n", body.len()).as_bytes(), body, b"\r\n0\r\n\r\n"].concat();
        assert_eq!(parse_response(&chunked).unwrap(), json!({ "sessions": 3 }));
        let to_end = [b"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n".as_slice(), body].concat();
        assert_eq!(parse_response(&to_end).unwrap(), json!({ "sessions": 3 }));
    }

    #[test]
    fn a_refusal_or_a_cut_answer_is_an_error_in_plain_words() {
        let err = br#"{"error":{"code":"denied","message":"an import is the person's own action"}}"#;
        let r = [format!("HTTP/1.1 403 Forbidden\r\ncontent-length: {}\r\n\r\n", err.len()).as_bytes(), err].concat();
        assert_eq!(parse_response(&r).unwrap_err(), "an import is the person's own action");
        assert!(parse_response(b"HTTP/1.1 200 OK\r\ncontent-length: 50\r\n\r\n{}").unwrap_err().contains("cut short"));
        assert!(parse_response(b"garbage").is_err());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}").unwrap_err().contains("no data"));
    }
}
