//! Self-update trust (plans/windows.md 6.4, the user's 0.2 decision: unsigned app, signed
//! updates). An update installs only when the release SHA256SUMS carries a valid Ed25519
//! signature from the Vyre release key, the downloaded file's hash is listed in it, and the
//! version is newer than the running one. Anything unsigned or unlisted is refused. The scheme
//! is core/vyre-core/release.js's `verifySums`: the signature covers "vyre-release-sums\n" then
//! the exact SHA256SUMS bytes.

use std::collections::HashMap;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

/// Same key as core/vyre-core/release.js (a test in test/ keeps them equal).
pub const RELEASE_KEY: &str = "MCowBQYDK2VwAyEAKXSdujH7tO/gscXCJZmYCjB+Cv1sVlOfdgLNedMR7FU=";
const SUMS_PREFIX: &[u8] = b"vyre-release-sums\n";
const SPKI_HEAD: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

fn verifying_key(spki_b64: &str) -> Result<VerifyingKey, String> {
    let der = B64.decode(spki_b64).map_err(|_| "release key is not a valid Ed25519 public key")?;
    if der.len() != 44 || der[..12] != SPKI_HEAD { return Err("release key is not a valid Ed25519 public key".into()); }
    let raw: [u8; 32] = der[12..].try_into().unwrap();
    VerifyingKey::from_bytes(&raw).map_err(|_| "release key is not a valid Ed25519 public key".into())
}

/// The names and lowercase sha256 hashes in `sums`, only once the signature holds.
pub fn verify_sums(sums: &[u8], sig_b64: &str, key_b64: &str) -> Result<HashMap<String, String>, String> {
    let sig_text = sig_b64.trim();
    if sig_text.is_empty() { return Err("signature is empty".into()); }
    let sig_bytes = B64.decode(sig_text).map_err(|_| "signature is not base64")?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| "signature is not 64 bytes")?;
    let mut msg = SUMS_PREFIX.to_vec();
    msg.extend_from_slice(sums);
    verifying_key(key_b64)?.verify(&msg, &sig).map_err(|_| "SHA256SUMS signature does not verify")?;
    let text = std::str::from_utf8(sums).map_err(|_| "SHA256SUMS is not text")?;
    let mut out = HashMap::new();
    for line in text.split('\n').filter(|l| !l.trim().is_empty()) {
        let (hash, name) = line.split_once(' ').ok_or("SHA256SUMS has a line that is not `sha256  name`")?;
        let name = name.strip_prefix(' ').or_else(|| name.strip_prefix('*')).ok_or("SHA256SUMS has a line that is not `sha256  name`")?;
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) || name.is_empty() || name.contains(['/', '\\']) {
            return Err("SHA256SUMS has a line that is not `sha256  name`".into());
        }
        if out.insert(name.to_string(), hash.to_ascii_lowercase()).is_some() { return Err(format!("SHA256SUMS lists {name} twice")); }
    }
    Ok(out)
}

/// The downloaded file must be listed and hash to the signed value.
pub fn check_file(listed: &HashMap<String, String>, name: &str, bytes: &[u8]) -> Result<(), String> {
    let want = listed.get(name).ok_or_else(|| format!("{name} is not in the signed SHA256SUMS"))?;
    let got: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    if &got == want { Ok(()) } else { Err(format!("{name} does not match its signed hash")) }
}

/// A semantic version: `major.minor.patch` and optional `-pre.release` identifiers (build metadata with `+` is
/// refused, as in lib/releases.js). Same ordering as lib/releases.js `compare` (a shared case table checks both).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    core: (u64, u64, u64),
    pre: Vec<String>,
}

impl Version {
    pub fn parse(v: &str) -> Option<Version> {
        let v = v.trim().trim_start_matches('v');
        if v.contains('+') { return None; }
        let (core, pre) = match v.split_once('-') { Some((c, p)) => (c, Some(p)), None => (v, None) };
        let mut it = core.split('.');
        let core = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
        if it.next().is_some() { return None; }
        let pre: Vec<String> = match pre {
            Some(p) => p.split('.').map(str::to_string).collect(),
            None => Vec::new(),
        };
        if pre.iter().any(|x| x.is_empty() || !x.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) { return None; }
        Some(Version { core, pre })
    }

    pub fn is_pre(&self) -> bool { !self.pre.is_empty() }
}

impl Ord for Version {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering::*;
        if self.core != o.core { return self.core.cmp(&o.core); }
        // A prerelease sorts before its release.
        match (self.pre.is_empty(), o.pre.is_empty()) {
            (true, true) => return Equal,
            (true, false) => return Greater,
            (false, true) => return Less,
            _ => {}
        }
        for i in 0..self.pre.len().max(o.pre.len()) {
            let (Some(p), Some(q)) = (self.pre.get(i), o.pre.get(i)) else {
                // The shorter list sorts first when the rest is equal.
                return if self.pre.get(i).is_none() { Less } else { Greater };
            };
            if p == q { continue; }
            let (pn, qn) = (p.bytes().all(|c| c.is_ascii_digit()), q.bytes().all(|c| c.is_ascii_digit()));
            return match (pn, qn) {
                (true, true) => p.parse::<u64>().unwrap_or(0).cmp(&q.parse::<u64>().unwrap_or(0)),
                // A number sorts before a word.
                (true, false) => Less,
                (false, true) => Greater,
                _ => p.cmp(q),
            };
        }
        Equal
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> { Some(self.cmp(o)) }
}

/// Downgrade refusal: only a strictly newer version installs. A prerelease is older than its release, so a
/// build on 0.2.0-rc.1 is offered 0.2.0, and one on 0.2.0 is never offered 0.2.0-rc.2.
pub fn is_newer(current: &str, candidate: &str) -> bool {
    match (Version::parse(current), Version::parse(candidate)) { (Some(a), Some(b)) => b > a, _ => false }
}

/// The release to read: the newest stable `vX.Y.Z` tag in GitHub's public releases feed
/// (https://github.com/vyre-ai/vyre/releases.atom). The repository's "Latest" release is often an Android one
/// (`android-0.1.0-...`) with no SHA256SUMS, so `releases/latest/download` cannot be used, and the REST API
/// answers 403 once a shared address has made 60 calls an hour, which a person's PC cannot be asked to risk.
/// Tags that are not plain versions (android-..., -rc.N) are skipped; the signature check is what trusts a release.
pub fn pick_tag(atom: &str) -> Option<String> {
    let mut best: Option<(Version, String)> = None;
    for part in atom.split("/releases/tag/").skip(1) {
        let tag: String = part.chars().take_while(|c| !matches!(c, '"' | '<' | '&' | '\'' | ' ' | '#' | '?')).collect();
        let Some(plain) = tag.strip_prefix('v') else { continue };
        // Stable releases only: a plain vX.Y.Z tag. Prereleases and builds are not offered by the feed pick.
        let Some(key) = Version::parse(plain).filter(|v| !v.is_pre()) else { continue };
        if best.as_ref().map_or(true, |(k, _)| key > *k) { best = Some((key, tag)); }
    }
    best.map(|(_, t)| t)
}

/// Where a tag's files live.
pub fn release_base(tag: &str) -> String { format!("https://github.com/vyre-ai/vyre/releases/download/{tag}") }

/// The installer named in the signed sums (`Vyre_<version>_x64-setup.exe`) when it is newer than
/// `current`. The version comes from the signed name, never from anything unsigned.
pub fn newer_installer(listed: &HashMap<String, String>, current: &str) -> Option<(String, String)> {
    listed.keys()
        .filter_map(|n| {
            let v = n.strip_prefix("Vyre_")?.strip_suffix("_x64-setup.exe")?;
            if Version::parse(v).is_some() && is_newer(current, v) { Some((n.clone(), v.to_string())) } else { None }
        })
        .max_by_key(|(_, v)| Version::parse(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/sums-vector.json")).unwrap()
    }
    fn f<'a>(v: &'a serde_json::Value, k: &str) -> &'a str { v[k].as_str().unwrap() }

    #[test]
    fn a_signed_sums_file_verifies_and_lists_hashes() {
        let v = vector();
        let m = verify_sums(f(&v, "sums").as_bytes(), f(&v, "sig"), f(&v, "key")).unwrap();
        assert_eq!(m["Vyre_0.2.0_x64-setup.exe"], "aa".repeat(32));
    }

    /// The one shared vector (launch's test/box-update.test.js, also in anywhere's tests), so
    /// every verifier agrees: seed 0x07 x32, the prefix, these exact bytes.
    const SHARED_KEY: &str = "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
    const SHARED_SUMS: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  manifest.json\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  vyre.tgz\n";
    const SHARED_SIG: &str = "X+aWDX+6p5YDh32E4tUXAHKEvCwi36rUm4I889QLs2I6b4hlP0J05o8PNtuyZnsCaqMkiv2MWmqJ3fllTLIzDA==";

    #[test]
    fn the_shared_vector_verifies_and_one_more_byte_does_not() {
        let m = verify_sums(SHARED_SUMS.as_bytes(), SHARED_SIG, SHARED_KEY).unwrap();
        assert_eq!(m["vyre.tgz"], "b".repeat(64));
        assert!(verify_sums(format!("{SHARED_SUMS}x").as_bytes(), SHARED_SIG, SHARED_KEY).is_err());
    }

    #[test]
    fn unsigned_changed_or_wrong_key_is_refused() {
        let v = vector();
        let sums = f(&v, "sums");
        assert!(verify_sums(sums.as_bytes(), "", f(&v, "key")).is_err());
        assert!(verify_sums(sums.replace("aa", "ab").as_bytes(), f(&v, "sig"), f(&v, "key")).is_err());
        assert!(verify_sums(sums.as_bytes(), f(&v, "sig"), RELEASE_KEY).is_err());
        assert!(verify_sums(sums.as_bytes(), "not base64!!", f(&v, "key")).is_err());
    }

    #[test]
    fn the_file_must_be_listed_and_match() {
        let mut m = HashMap::new();
        let body = b"installer";
        let h: String = Sha256::digest(body).iter().map(|b| format!("{b:02x}")).collect();
        m.insert("Vyre.exe".to_string(), h);
        assert!(check_file(&m, "Vyre.exe", body).is_ok());
        assert!(check_file(&m, "Vyre.exe", b"tampered").is_err());
        assert!(check_file(&m, "Other.exe", body).is_err());
    }

    #[test]
    fn the_order_matches_lib_releases_for_every_shared_case() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../tests/semver-cases.json")).unwrap();
        for c in cases.as_array().unwrap() {
            let (a, b, want) = (c[0].as_str().unwrap(), c[1].as_str().unwrap(), c[2].as_i64().unwrap());
            let got = Version::parse(a).unwrap().cmp(&Version::parse(b).unwrap()) as i64;
            assert_eq!(got, want, "{a} vs {b}");
        }
    }

    #[test]
    fn a_prerelease_is_offered_its_release_and_a_release_never_its_prerelease() {
        assert!(is_newer("0.2.0-rc.1", "0.2.0"));
        assert!(is_newer("0.2.0-rc.1", "0.2.0-rc.2"));
        assert!(!is_newer("0.2.0", "0.2.0-rc.2"));
        assert!(!is_newer("0.2.0-rc.2", "0.2.0-rc.2"));
        assert!(!is_newer("0.2.0", "garbage"));
        let mut m = HashMap::new();
        for n in ["Vyre_0.2.0_x64-setup.exe", "Vyre_0.2.0-rc.2_x64-setup.exe"] { m.insert(n.to_string(), "aa".repeat(32)); }
        assert_eq!(newer_installer(&m, "0.2.0-rc.1"), Some(("Vyre_0.2.0_x64-setup.exe".into(), "0.2.0".into())));
        assert_eq!(newer_installer(&m, "0.2.0"), None);
    }

    #[test]
    fn only_a_newer_version_installs() {
        assert!(is_newer("0.2.0", "0.2.1"));
        assert!(is_newer("0.2.9", "0.10.0"));
        assert!(!is_newer("0.2.1", "0.2.1"));
        assert!(!is_newer("0.2.1", "0.2.0"));
        assert!(!is_newer("0.2.1", "garbage"));
    }

    #[test]
    fn picks_the_newest_signed_installer_only_when_newer() {
        let mut m = HashMap::new();
        for n in ["Vyre_0.2.0_x64-setup.exe", "Vyre_0.10.0_x64-setup.exe", "vyre-box.tar.gz", "Vyre_x_x64-setup.exe"] { m.insert(n.to_string(), "aa".repeat(32)); }
        assert_eq!(newer_installer(&m, "0.2.0"), Some(("Vyre_0.10.0_x64-setup.exe".into(), "0.10.0".into())));
        assert_eq!(newer_installer(&m, "0.10.0"), None);
    }

    #[test]
    fn the_release_is_the_newest_stable_version_tag_never_an_android_one() {
        let atom = r#"<feed><entry><link href="https://github.com/vyre-ai/vyre/releases/tag/android-0.1.0-ebcb0b0"/></entry>
          <entry><link rel="alternate" href="https://github.com/vyre-ai/vyre/releases/tag/v0.1.1"/></entry>
          <entry><link href="https://github.com/vyre-ai/vyre/releases/tag/v0.2.0-rc.1"/></entry>
          <entry><link href="https://github.com/vyre-ai/vyre/releases/tag/v0.1.10"/></entry>
          <entry><link href="https://github.com/vyre-ai/vyre/releases/tag/v0.1.9"/></entry></feed>"#;
        assert_eq!(pick_tag(atom), Some("v0.1.10".into()));
        assert_eq!(pick_tag("<feed></feed>"), None);
        assert_eq!(pick_tag("not xml"), None);
        assert_eq!(release_base("v0.1.1"), "https://github.com/vyre-ai/vyre/releases/download/v0.1.1");
    }
}
