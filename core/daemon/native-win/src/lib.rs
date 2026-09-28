//! Section 7a point 2c (docs/design/windows-plan.md): the part of the client-side owner check
//! that has nothing to do with a live Windows handle, and so can be tested on any platform.
//! `main.rs` does the actual Win32 calls (`GetNamedPipeServerProcessId`, then the owning
//! process's token SID) and hands the two SID strings this module compares to `verdict`.

/// Two SIDs as Windows renders them (`ConvertSidToStringSidW`, e.g. `S-1-5-21-...-1001`),
/// compared as plain strings: a SID has exactly one textual form, so string equality is the
/// whole check, no normalization needed.
pub fn sids_match(mine: &str, servers: &str) -> bool {
    mine == servers
}

/// What to tell the person and how loudly, given whether the SIDs matched and whether either
/// side could even be read. A missing SID is never treated as a pass: 2c exists specifically
/// because "couldn't tell" must not become "assume it's fine" (the same fail-closed rule as the
/// peer check in point 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The pipe's owner is this user. Safe to send.
    Ok,
    /// The pipe's owner is someone else: point 2b's defenses were bypassed, or raced. Refuse.
    OwnedByAnother,
    /// A Win32 call failed before a comparison was even possible (the process exited between
    /// `GetNamedPipeServerProcessId` and opening it, access denied, ...). Refuse: this is not
    /// evidence of safety, only of not having checked.
    Unreadable,
}

pub fn verdict(mine: Option<&str>, servers: Option<&str>) -> Verdict {
    match (mine, servers) {
        (Some(a), Some(b)) if sids_match(a, b) => Verdict::Ok,
        (Some(_), Some(_)) => Verdict::OwnedByAnother,
        _ => Verdict::Unreadable,
    }
}

impl Verdict {
    /// Exit code `main.rs` returns: 0 only for `Ok`, so a caller checking `$LASTEXITCODE` (or
    /// any process exit-status check) fails closed by construction, not by remembering to.
    pub fn exit_code(self) -> i32 {
        match self {
            Verdict::Ok => 0,
            Verdict::OwnedByAnother => 1,
            Verdict::Unreadable => 2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_sids_match() {
        assert!(sids_match("S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1001"));
    }

    #[test]
    fn different_sids_do_not_match() {
        assert!(!sids_match("S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1002"));
    }

    #[test]
    fn matching_sids_are_ok_and_exit_zero() {
        let v = verdict(Some("S-1-5-21-1-2-3-1001"), Some("S-1-5-21-1-2-3-1001"));
        assert_eq!(v, Verdict::Ok);
        assert_eq!(v.exit_code(), 0);
    }

    #[test]
    fn a_real_mismatch_refuses_with_a_distinct_code_from_unreadable() {
        let v = verdict(Some("S-1-5-21-1-2-3-1001"), Some("S-1-5-21-1-2-3-1002"));
        assert_eq!(v, Verdict::OwnedByAnother);
        assert_ne!(v.exit_code(), 0);
        assert_ne!(v.exit_code(), Verdict::Unreadable.exit_code());
    }

    #[test]
    fn a_missing_sid_on_either_side_refuses_never_passes() {
        assert_eq!(verdict(None, Some("S-1-5-21-1-2-3-1001")), Verdict::Unreadable);
        assert_eq!(verdict(Some("S-1-5-21-1-2-3-1001"), None), Verdict::Unreadable);
        assert_eq!(verdict(None, None), Verdict::Unreadable);
        assert_ne!(Verdict::Unreadable.exit_code(), 0, "unreadable must never look like success");
    }
}
