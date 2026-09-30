//! The shell's trust rules, as pure functions (plans/windows.md section 3). The Tauri glue in
//! `app/` calls these and does nothing clever of its own: which addresses the main panel may
//! load, which `vyre://open` paths are honored, and what a pairing record must look like.

use url::Url;

/// The only routes `vyre://open` may reach. A path outside this list is ignored, never redirected.
pub const OPEN_PREFIXES: [&str; 7] = ["/chat", "/projects", "/agents", "/settings", "/quick", "/now", "/needs"];

/// The person's own server, read from the pairing record the shell wrote at claim time. Nothing
/// else (a link, a query string, page content) ever supplies it (reviewer N-H1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pinned {
    origin: String,
}

impl Pinned {
    /// Accepts an https origin with no credentials, path, query or fragment beyond `/`.
    pub fn parse(address: &str) -> Option<Pinned> {
        let u = Url::parse(address.trim()).ok()?;
        if u.scheme() != "https" || u.host_str().is_none() { return None; }
        if !u.username().is_empty() || u.password().is_some() { return None; }
        if u.path() != "/" || u.query().is_some() || u.fragment().is_some() { return None; }
        Some(Pinned { origin: u.origin().ascii_serialization() })
    }

    pub fn origin(&self) -> &str { &self.origin }

    /// True when `target` is on the pinned origin. The relay-fallback origin (B5) is added by the
    /// caller as a second `Pinned`, never widened here.
    pub fn allows(&self, target: &str) -> bool {
        match Url::parse(target) {
            Ok(u) => u.scheme() == "https" && u.origin().ascii_serialization() == self.origin,
            Err(_) => false,
        }
    }

    /// The URL for a validated in-app path on the pinned origin.
    pub fn url_for(&self, path: &str) -> String { format!("{}{}", self.origin, path) }
}

/// `vyre://open?path=/chat/abc` gives `Some("/chat/abc")`. A host other than `open`, a missing or
/// odd path, a path naming another host, or one outside `OPEN_PREFIXES` gives `None`.
pub fn open_path(link: &str) -> Option<String> {
    let u = Url::parse(link).ok()?;
    if u.scheme() != "vyre" || u.host_str() != Some("open") { return None; }
    let path = u.query_pairs().find(|(k, _)| k == "path").map(|(_, v)| v.into_owned())?;
    if !path.starts_with('/') || path.starts_with("//") { return None; }
    if path.contains('\\') || path.contains("..") || path.contains('@') || path.contains(':') { return None; }
    if path.chars().any(|c| c.is_control()) { return None; }
    let head = path.split(['/', '?', '#']).nth(1).unwrap_or("");
    let route = format!("/{head}");
    if OPEN_PREFIXES.contains(&route.as_str()) { Some(path) } else { None }
}

/// Whether a `vyre://pair` link carries the nonce this app issued. A link without it, or with a
/// different one, is ignored outright.
pub fn pair_matches(link: &str, issued_nonce: &str) -> bool {
    if issued_nonce.len() < 16 { return false; }
    let Ok(u) = Url::parse(link) else { return false };
    if u.scheme() != "vyre" || u.host_str() != Some("pair") { return false; }
    u.query_pairs().any(|(k, v)| k == "nonce" && v == issued_nonce)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_takes_only_a_plain_https_origin() {
        assert!(Pinned::parse("https://alex.vyre.run").is_some());
        assert!(Pinned::parse("https://alex.vyre.run/").is_some());
        for bad in ["http://alex.vyre.run", "https://alex.vyre.run/chat", "https://a@alex.vyre.run", "https://alex.vyre.run/?x=1", "vyre://open", "alex.vyre.run", ""] {
            assert!(Pinned::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn allows_only_the_same_origin() {
        let p = Pinned::parse("https://alex.vyre.run").unwrap();
        assert!(p.allows("https://alex.vyre.run/chat"));
        assert!(!p.allows("https://alex.vyre.run.evil.example/"));
        assert!(!p.allows("https://evil.example/https://alex.vyre.run"));
        assert!(!p.allows("http://alex.vyre.run/"));
        assert!(!p.allows("https://alex.vyre.run:8443/"));
        assert!(!p.allows("https://alex.vyre.run@evil.example/"));
        assert!(!p.allows("javascript:alert(1)"));
    }

    #[test]
    fn open_honors_only_the_fixed_routes() {
        assert_eq!(open_path("vyre://open?path=/chat"), Some("/chat".into()));
        assert_eq!(open_path("vyre://open?path=/projects/harlow?tab=1"), Some("/projects/harlow?tab=1".into()));
        assert_eq!(open_path("vyre://open?path=/quick"), Some("/quick".into()));
        for bad in [
            "vyre://open?path=/admin",
            "vyre://open?path=//evil.example/chat",
            "vyre://open?path=/chat/../admin",
            "vyre://open?path=https://evil.example/chat",
            "vyre://open?path=/chat@evil.example",
            "vyre://open?path=chat",
            "vyre://open?host=evil.example",
            "vyre://open",
            "vyre://pair?path=/chat",
            "https://alex.vyre.run/chat",
        ] {
            assert_eq!(open_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_foreign_host_never_reaches_the_pinned_origin_url() {
        let p = Pinned::parse("https://alex.vyre.run").unwrap();
        let path = open_path("vyre://open?path=/chat&host=evil.example").unwrap();
        assert_eq!(p.url_for(&path), "https://alex.vyre.run/chat");
    }

    #[test]
    fn pair_needs_the_apps_own_nonce() {
        let n = "0123456789abcdef0123";
        assert!(pair_matches(&format!("vyre://pair?nonce={n}&ticket=t"), n));
        assert!(!pair_matches("vyre://pair?ticket=t", n));
        assert!(!pair_matches(&format!("vyre://pair?nonce={n}x"), n));
        assert!(!pair_matches(&format!("vyre://open?nonce={n}"), n));
        assert!(!pair_matches("vyre://pair?nonce=short", "short"));
    }
}
