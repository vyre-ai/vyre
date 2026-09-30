//! Section 7a point 2c (docs/design/windows-plan.md): the part of the client-side owner check
//! that has nothing to do with a live Windows handle, and so can be tested on any platform.
//! `main.rs` does the actual Win32 calls (`GetNamedPipeServerProcessId`, then `EqualSid` between
//! that process's token owner and the caller's own) and hands the boolean result to `verdict`.

/// What to tell the person and how loudly, given whether the two SIDs were proven equal, proven
/// different, or never compared at all because some Win32 call failed first. A missing result is
/// never treated as a pass: 2c exists specifically because "couldn't tell" must not become
/// "assume it's fine" (the same fail-closed rule as the peer check in point 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The pipe's owner is this user (`EqualSid` returned true). Safe to send.
    Ok,
    /// The pipe's owner is someone else: point 2b's defenses were bypassed, or raced. Refuse.
    OwnedByAnother,
    /// A Win32 call failed before a comparison was even possible (the process exited between
    /// `GetNamedPipeServerProcessId` and opening it, access denied, ...). Refuse: this is not
    /// evidence of safety, only of not having checked.
    Unreadable,
}

/// `matched` is `None` when the SIDs were never actually compared (a prior Win32 call failed),
/// `Some(EqualSid(...))` otherwise.
pub fn verdict(matched: Option<bool>) -> Verdict {
    match matched {
        Some(true) => Verdict::Ok,
        Some(false) => Verdict::OwnedByAnother,
        None => Verdict::Unreadable,
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
    fn a_proven_match_is_ok_and_exits_zero() {
        let v = verdict(Some(true));
        assert_eq!(v, Verdict::Ok);
        assert_eq!(v.exit_code(), 0);
    }

    #[test]
    fn a_proven_mismatch_refuses_with_a_distinct_code_from_unreadable() {
        let v = verdict(Some(false));
        assert_eq!(v, Verdict::OwnedByAnother);
        assert_ne!(v.exit_code(), 0);
        assert_ne!(v.exit_code(), Verdict::Unreadable.exit_code());
    }

    #[test]
    fn never_having_compared_at_all_refuses_never_passes() {
        let v = verdict(None);
        assert_eq!(v, Verdict::Unreadable);
        assert_ne!(v.exit_code(), 0, "unreadable must never look like success");
    }
}
