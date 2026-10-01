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

/// The address a pairing offer would pin, and whether it is off vyre.run (shown as its own line).
#[derive(Debug, PartialEq, Eq)]
pub struct PinChoice {
    pub address: String,
    pub own_domain: bool,
}

/// Choose the address from a sealed ticket record's `handle` and `address` (reviewer-2's rules, as applied here).
/// The box's name is always sent as `handle`, even when the box lives on its own domain, so a handle alone does not
/// mean vyre.run. Rules: an address on vyre.run must be exactly https://<handle>.vyre.run, else it is refused; an
/// address on any other domain is the box's own and is pinned only as its own visible line (own_domain) after the
/// person's Pair; with no address, a handle gives https://<handle>.vyre.run; neither: refused.
pub fn pin_from_offer(handle: Option<&str>, address: Option<&str>) -> Result<PinChoice, &'static str> {
    let valid = |h: &str| { let b = h.as_bytes(); !b.is_empty() && b.len() <= 32 && b[0].is_ascii_alphanumeric() && b[b.len() - 1].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-') };
    if let Some(h) = handle { if !valid(h) { return Err("bad_handle"); } }
    let addr = match address { Some(a) => Some(Pinned::parse(a).ok_or("bad_address")?), None => None };
    let on_vyre = |origin: &str| origin.strip_prefix("https://").map_or(false, |h| { let host = h.split(':').next().unwrap_or("").trim_end_matches('.'); host == "vyre.run" || host.ends_with(".vyre.run") });
    match (handle, addr) {
        (Some(h), Some(a)) if on_vyre(a.origin()) => {
            let want = format!("https://{}.vyre.run", h.to_ascii_lowercase());
            if a.origin() != want { return Err("address_disagrees"); }
            Ok(PinChoice { address: want, own_domain: false })
        }
        (_, Some(a)) => Ok(PinChoice { address: a.origin().to_string(), own_domain: !on_vyre(a.origin()) }),
        (Some(h), None) => Ok(PinChoice { address: format!("https://{}.vyre.run", h.to_ascii_lowercase()), own_domain: false }),
        (None, None) => Err("no_address"),
    }
}

/// A Windows tool's full path under the Windows folder, so the shell never runs a same-named file
/// from the working directory. `system_root` is the SystemRoot variable, trusted only as a drive path.
pub fn system_path(system_root: Option<&str>, rel: &str) -> String {
    let root = match system_root {
        Some(r) if r.len() >= 3 && r.as_bytes()[0].is_ascii_alphabetic() && &r[1..3] == ":\\" => r.trim_end_matches('\\'),
        _ => "C:\\Windows",
    };
    format!("{root}\\{rel}")
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
    fn the_pin_follows_the_handle_on_vyre_run_and_the_own_domain_otherwise() {
        let ok = |h, a| pin_from_offer(h, a).map(|c| (c.address, c.own_domain));
        assert_eq!(ok(Some("alex"), None), Ok(("https://alex.vyre.run".into(), false)));
        assert_eq!(ok(Some("alex"), Some("https://alex.vyre.run")), Ok(("https://alex.vyre.run".into(), false)));
        assert_eq!(ok(Some("alex"), Some("https://mallory.vyre.run")), Err("address_disagrees"));
        assert_eq!(ok(Some("alex"), Some("https://vyre.run")), Err("address_disagrees"));
        // A trailing dot is the same host in DNS: "mallory.vyre.run." is on vyre.run, so it gets the same address check, not the own-domain path.
        assert_eq!(ok(Some("alex"), Some("https://mallory.vyre.run.")), Err("address_disagrees"));
        // A named box on its own domain: the handle is just its name, the address is its own.
        assert_eq!(ok(Some("alex"), Some("https://box.harlow.example")), Ok(("https://box.harlow.example".into(), true)));
        assert_eq!(ok(None, Some("https://box.harlow.example:8443")), Ok(("https://box.harlow.example:8443".into(), true)));
        assert_eq!(ok(None, Some("http://box.harlow.example")), Err("bad_address"));
        assert_eq!(ok(None, None), Err("no_address"));
        assert_eq!(ok(Some("-x"), None), Err("bad_handle"));
    }

    #[test]
    fn windows_tools_run_by_full_path() {
        assert_eq!(system_path(Some("D:\\Win"), "System32\\reg.exe"), "D:\\Win\\System32\\reg.exe");
        assert_eq!(system_path(Some("D:\\Win\\"), "explorer.exe"), "D:\\Win\\explorer.exe");
        assert_eq!(system_path(Some(".\\evil"), "System32\\reg.exe"), "C:\\Windows\\System32\\reg.exe");
        assert_eq!(system_path(None, "System32\\net.exe"), "C:\\Windows\\System32\\net.exe");
    }
}
