//! The Windows app's log, %LOCALAPPDATA%\Vyre\logs\app.log: one line per failure of a key, a claim bridge or a window, with the real reason. The Mac had one generic message and no log (IR-29, IR-31);
//! this one says why. Pure formatting plus one append, so it is tested on any host. A line never holds a key, a seed or a message that was signed: callers pass a command name and a reason, nothing else.

use std::io::Write;
use std::path::{Path, PathBuf};

/// The log file under the Windows local app data folder; `local_app_data` is the LOCALAPPDATA variable, trusted only as a drive path. Falls back to the temp folder.
pub fn path(local_app_data: Option<&str>, temp: &Path) -> PathBuf {
    match local_app_data {
        Some(r) if r.len() >= 3 && r.as_bytes()[0].is_ascii_alphabetic() && &r[1..3] == ":\\" => PathBuf::from(r.trim_end_matches('\\')).join("Vyre").join("logs").join("app.log"),
        _ => temp.join("Vyre").join("logs").join("app.log"),
    }
}

fn clean(s: &str, max: usize) -> String {
    let t: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let t = t.trim();
    if t.chars().count() > max { format!("{}...", t.chars().take(max).collect::<String>()) } else { t.to_string() }
}

/// `2026-10-08T07:12:03Z fail identity_public: Windows would not open the device key.`
pub fn line(unix_secs: u64, kind: &str, who: &str, what: &str) -> String {
    format!("{} {} {}: {}\n", iso(unix_secs), clean(kind, 12), clean(who, 40), clean(what, 400))
}

fn iso(secs: u64) -> String {
    let (days, rem) = (secs / 86400, secs % 86400);
    // civil-from-days (Howard Hinnant)
    let z = days as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Append one line, making the folder; the log is capped (past 512 KB it is started again) so it cannot grow without end. Failing to log is silent: a log must not break the thing it reports.
pub fn append(file: &Path, text: &str) {
    if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
    if std::fs::metadata(file).map(|m| m.len() > 512 * 1024).unwrap_or(false) { let _ = std::fs::rename(file, file.with_extension("log.old")); }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) { let _ = f.write_all(text.as_bytes()); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_is_under_local_app_data_or_the_temp_folder() {
        let t = Path::new("T");
        assert_eq!(path(Some("C:\\Users\\a\\AppData\\Local"), t), PathBuf::from("C:\\Users\\a\\AppData\\Local").join("Vyre").join("logs").join("app.log"));
        assert_eq!(path(Some(".\\evil"), t), t.join("Vyre").join("logs").join("app.log"));
        assert_eq!(path(None, t), t.join("Vyre").join("logs").join("app.log"));
    }

    #[test]
    fn a_line_has_a_time_a_kind_a_command_and_one_line_of_reason() {
        assert_eq!(line(0, "fail", "identity_public", "no key"), "1970-01-01T00:00:00Z fail identity_public: no key\n");
        assert_eq!(line(1791443523, "fail", "x", "a\nb\r\nc"), "2026-10-08T07:12:03Z fail x: a b  c\n");
        assert_eq!(line(951782400, "ok", "x", "leap day").split(' ').next().unwrap(), "2000-02-29T00:00:00Z");
        assert!(line(0, "fail", "x", &"y".repeat(1000)).len() < 500);
    }

    #[test]
    fn append_makes_the_folder_and_adds_lines() {
        let f = std::env::temp_dir().join(format!("vyre-applog-test-{}", std::process::id())).join("logs").join("app.log");
        let _ = std::fs::remove_dir_all(f.parent().unwrap());
        append(&f, &line(0, "fail", "a", "one"));
        append(&f, &line(1, "fail", "b", "two"));
        let s = std::fs::read_to_string(&f).unwrap();
        assert_eq!(s.lines().count(), 2);
        assert!(s.contains("fail b: two"));
    }
}
