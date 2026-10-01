//! Mapping a Vyre Drive share as a Windows drive (plans/drive.md 4.x, mirrors
//! core/files/drive-windows.js). Taildrive is WebDAV at 100.100.100.100:8080, which Windows maps
//! with `net use` through its WebClient service. Pure pieces only; the app runs the command.

/// The one address a share may live at. Anything else is refused before `net use` sees it.
const HOST: &str = "100.100.100.100@8080";

/// The UNC name for a Taildrive URL such as http://100.100.100.100:8080/example.com/vyre/projects.
pub fn unc_for(url: &str) -> Result<String, String> {
    let rest = url.strip_prefix("http://100.100.100.100:8080/").ok_or("a Vyre Drive address is http on the tailnet")?;
    let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|s| s.contains(['\\', ':', '*', '?', '"', '<', '>', '|', '%']) || *s == "..") {
        return Err("a share name Windows cannot map".into());
    }
    Ok(format!("\\\\{HOST}\\{}", parts.join("\\")))
}

/// True for a UNC this app is willing to map.
pub fn is_vyre_unc(unc: &str) -> bool {
    let prefix = format!("\\\\{HOST}\\");
    match unc.strip_prefix(prefix.as_str()) {
        Some(rest) => !rest.is_empty() && !rest.split('\\').any(|s| s.is_empty() || s == ".." || s.contains(['/', ':', '*', '?', '"', '<', '>', '|'])),
        None => false,
    }
}

pub fn map_args(letter: &str, unc: &str) -> Vec<String> {
    ["use", letter, unc, "/persistent:no"].iter().map(|s| s.to_string()).collect()
}

pub fn unmap_args(letter: &str) -> Vec<String> {
    ["use", letter, "/delete", "/y"].iter().map(|s| s.to_string()).collect()
}

/// Drive letters `net use` lists as mapped (any address), like "Z:".
pub fn used_letters(out: &str) -> Vec<String> {
    out.lines().filter_map(|line| {
        let mut it = line.split_whitespace();
        let first = it.next()?;
        let cand = if is_letter(first) { first } else { it.next().filter(|s| is_letter(s))? };
        let unc = it.next()?;
        unc.starts_with("\\\\").then(|| cand.to_ascii_uppercase())
    }).collect()
}

fn is_letter(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// First free letter from Z down to D. `exists` says whether a letter is already a drive.
pub fn free_letter(used: &[String], exists: impl Fn(&str) -> bool) -> Option<String> {
    (b'D'..=b'Z').rev().map(|c| format!("{}:", c as char)).find(|l| !used.iter().any(|u| u.eq_ignore_ascii_case(l)) && !exists(l))
}

/// What the person can do about a `net use` failure.
pub fn explain(text: &str) -> String {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    let has = |n: &str| lower.split(|c: char| !c.is_ascii_digit()).any(|w| w == n);
    if has("67") || has("1244") || has("53") || lower.contains("network name cannot be found") || lower.contains("network path was not found") {
        "Windows could not reach the share. Check Tailscale is running and signed in on this PC, and that the WebClient service is running (Services, WebClient, Start).".into()
    } else if has("85") || lower.contains("already in use") {
        "That drive letter is already in use.".into()
    } else {
        t.lines().find(|l| !l.trim().is_empty()).unwrap_or("net use failed").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unc_from_a_taildrive_url() {
        assert_eq!(unc_for("http://100.100.100.100:8080/example.com/vyre/projects").unwrap(), "\\\\100.100.100.100@8080\\example.com\\vyre\\projects");
        for bad in ["https://100.100.100.100:8080/a/b", "http://evil.example:8080/a/b", "http://100.100.100.100:8080/", "http://100.100.100.100:8080/a/../b", "http://100.100.100.100:8080/a%5Cb"] {
            assert!(unc_for(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_vyre_shares_are_mapped() {
        assert!(is_vyre_unc("\\\\100.100.100.100@8080\\example.com\\vyre\\projects"));
        for bad in ["\\\\evil.example\\share", "\\\\100.100.100.100@8080\\", "\\\\100.100.100.100@8080\\a\\..\\b", "\\\\100.100.100.100@8081\\a", "Z:"] {
            assert!(!is_vyre_unc(bad), "{bad}");
        }
    }

    #[test]
    fn net_use_arguments_never_persist() {
        assert_eq!(map_args("Z:", "\\\\h\\s"), ["use", "Z:", "\\\\h\\s", "/persistent:no"]);
        assert_eq!(unmap_args("Z:"), ["use", "Z:", "/delete", "/y"]);
    }

    #[test]
    fn free_letter_skips_mapped_and_existing() {
        let out = "OK           Z:        \\\\100.100.100.100@8080\\a\\b\\c   Web Client Network\nUnavailable  Y:        \\\\srv\\x   Microsoft Windows Network\n";
        let used = used_letters(out);
        assert_eq!(used, ["Z:", "Y:"]);
        assert_eq!(free_letter(&used, |l| l == "X:").as_deref(), Some("W:"));
        assert_eq!(free_letter(&[], |_| false).as_deref(), Some("Z:"));
        assert_eq!(free_letter(&[], |_| true), None);
    }

    #[test]
    fn failures_are_explained() {
        assert!(explain("System error 67 has occurred.").contains("WebClient"));
        assert!(explain("System error 85 has occurred.").contains("already in use"));
        assert_eq!(explain("\nsomething odd\n"), "something odd");
    }
}
