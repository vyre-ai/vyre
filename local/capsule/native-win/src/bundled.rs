//! The app's own web build, carried inside the Windows app (`expo export -p web` with baseUrl /app, put under the app's resources when it is built). Windows has no local vyred to serve
//! /app/ (vyred refuses to start there), so the window serves these files itself through a custom scheme, the way the Mac app's window does (Host/BundledApp.swift), and the page runs
//! as a browser with no box of its own: it reserves, claims and pairs through the names directory and the relay. The export is a single-page app, so every route is index.html.
//!
//! Pure (std only), so it is tested on any host: `resolve` maps a request path to a file inside the folder, never outside it.

use std::path::{Component, Path, PathBuf};

/// The scheme the window's pages are served under (registered by the app).
pub const SCHEME: &str = "vyreapp";

/// The origin the page runs at on Windows. WebView2 has no custom schemes of its own: a registered scheme `vyreapp` is served at http://vyreapp.localhost, and this is the string the page sends
/// as its Origin header and the one the names directory's APP_ORIGINS must list.
pub const ORIGIN: &str = "http://vyreapp.localhost";

/// Where the window opens.
pub const START: &str = "http://vyreapp.localhost/app/";

/// Is this the Origin header of a call made by the bundled page itself? Exactly the one origin, nothing else.
pub fn is_origin(header: Option<&str>) -> bool { header == Some(ORIGIN) }

/// Is this URL a page of the bundled app?
pub fn is_page(url: &str) -> bool { url == ORIGIN || url.starts_with("http://vyreapp.localhost/") }

#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    /// This file, with this content type.
    File { path: PathBuf, mime: &'static str },
    /// No such thing here.
    Missing,
}

/// Where the build is: it needs an index.html.
pub fn has_build(dir: &Path) -> bool { dir.join("index.html").is_file() }

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

/// A request path, as the page sends it ("/app/_expo/static/js/web/entry.js", "/app/u/now"), to what answers it. The prefix /app is the build's base URL.
pub fn resolve(raw_path: &str, dir: &Path) -> Answer {
    let Some(mut path) = percent_decode(raw_path) else { return Answer::Missing };
    if path == "/app" { path = "/app/".into(); }
    let Some(rest) = path.strip_prefix("/app/") else { return Answer::Missing };
    // No backslash, no drive letter, no parent step: a Windows path can hide any of them in a URL.
    if rest.contains('\\') || rest.contains(':') || rest.contains('\0') { return Answer::Missing; }
    let mut file = dir.to_path_buf();
    for part in rest.split('/') {
        match Path::new(part).components().next() {
            None => {}
            Some(Component::Normal(p)) if Path::new(part).components().count() == 1 => file.push(p),
            _ => return Answer::Missing,
        }
    }
    if file.is_file() { let m = mime(&file); return Answer::File { path: file, mime: m }; }
    // A route of the app (no extension) is the single page; a missing asset is missing.
    if file.extension().is_none() { return Answer::File { path: dir.join("index.html"), mime: "text/html; charset=utf-8" }; }
    Answer::Missing
}

pub fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("webmanifest") => "application/manifest+json",
        Some("txt") => "text/plain; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build() -> PathBuf {
        let d = std::env::temp_dir().join(format!("vyre-bundled-test-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("_expo/static/js/web")).unwrap();
        std::fs::write(d.join("index.html"), "<html>").unwrap();
        std::fs::write(d.join("_expo/static/js/web/entry.js"), "1").unwrap();
        std::fs::write(d.join("secret.txt"), "no").ok();
        d
    }

    #[test]
    fn files_routes_and_missing_assets() {
        let d = build();
        assert_eq!(resolve("/app/", &d), Answer::File { path: d.join("index.html"), mime: "text/html; charset=utf-8" });
        assert_eq!(resolve("/app", &d), Answer::File { path: d.join("index.html"), mime: "text/html; charset=utf-8" });
        assert_eq!(resolve("/app/_expo/static/js/web/entry.js", &d), Answer::File { path: d.join("_expo/static/js/web/entry.js"), mime: "text/javascript; charset=utf-8" });
        // a route of the app is the single page
        assert_eq!(resolve("/app/u/now", &d), Answer::File { path: d.join("index.html"), mime: "text/html; charset=utf-8" });
        // a missing asset is missing
        assert_eq!(resolve("/app/nope.js", &d), Answer::Missing);
        // outside the base URL is missing (the box's /v1 calls have no vyred here)
        assert_eq!(resolve("/v1/tools", &d), Answer::Missing);
        assert_eq!(resolve("/", &d), Answer::Missing);
    }

    #[test]
    fn nothing_outside_the_folder_is_reachable() {
        let d = build();
        for bad in ["/app/../secret.txt", "/app/%2e%2e/secret.txt", "/app/%2E%2E%2Fsecret.txt", "/app/..%5Csecret.txt", "/app/..\\secret.txt", "/app/C:/Windows/win.ini", "/app/c%3A/x", "/app/a/../../x.txt", "/app/%00", "/app/%zz"] {
            assert_eq!(resolve(bad, &d), Answer::Missing, "{bad}");
        }
    }

    #[test]
    fn the_origin_is_exact() {
        assert!(is_origin(Some("http://vyreapp.localhost")));
        for bad in ["http://vyreapp.localhost/", "https://vyreapp.localhost", "http://vyreapp.localhost.evil.example", "null", ""] { assert!(!is_origin(Some(bad)), "{bad}"); }
        assert!(!is_origin(None));
        assert!(is_page("http://vyreapp.localhost/app/u/now"));
        assert!(!is_page("http://vyreapp.localhost.evil.example/app/"));
        assert!(!is_page("https://vyreapp.localhost/app/"));
    }

    #[test]
    fn a_build_needs_an_index() {
        let d = build();
        assert!(has_build(&d));
        assert!(!has_build(&d.join("_expo")));
    }
}
