//! When the app may countersign the local core's pairing request (#26, v0.2.3). The box approves a
//! core as a companion of the device already confirmed on this PC, so the app's device key must
//! never be a signing oracle for whatever connects. Pure decisions only; the pipe, the pid check
//! and the signature itself are the app's (platform's and reviewer-2's conditions):
//!
//! - the app builds the message itself, from values it knows, under a fixed domain prefix, and never
//!   signs bytes the core hands it (the device key also signs relay logins; without the prefix a
//!   countersign could be replayed as one);
//! - it signs only just after pairing, inside the window, or after the person's tap on the card;
//! - once per request nonce, remembered; one request per connection.

use std::collections::HashSet;

/// The domain separator at the front of every countersigned message.
pub const PREFIX: &str = "vyre-companion-v1";
/// How long after the app pairs a core's request may be signed without a tap.
pub const WINDOW_MS: u64 = 5 * 60 * 1000;

/// The message the app signs. Every field is the app's own value except the core's public key and the
/// nonce, which are checked for shape and bound into the signature, never interpreted.
pub fn message(core_public_key: &str, box_id: &str, device_id: &str, nonce: &str, ts_ms: u64) -> Result<Vec<u8>, String> {
    for (name, v) in [("core key", core_public_key), ("box id", box_id), ("device id", device_id), ("nonce", nonce)] {
        if v.is_empty() || v.len() > 256 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_=+/.:".contains(&b)) {
            return Err(format!("the {name} is not in a shape the app will sign"));
        }
    }
    Ok(format!("{PREFIX}\ncore:{core_public_key}\nbox:{box_id}\ndevice:{device_id}\nnonce:{nonce}\nts:{ts_ms}\n").into_bytes())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision { Sign, Refuse(&'static str) }

#[derive(Default)]
pub struct Gate {
    /// When the app last finished pairing, if it has.
    paired_at: Option<u64>,
    /// The person tapped Allow on the card for the next request.
    tapped: bool,
    seen: HashSet<String>,
}

impl Gate {
    pub fn new() -> Gate { Gate::default() }
    /// The app has just paired this PC (a confirmed device).
    pub fn paired(&mut self, now_ms: u64) { self.paired_at = Some(now_ms); }
    /// The person pressed Allow on the app's own card.
    pub fn tap(&mut self) { self.tapped = true; }

    /// One request. The caller has already checked the connecting pid and closes the connection after
    /// this answer, whatever it is. A nonce is recorded only when it is signed, so a refusal does not
    /// burn it, but a signed one can never be signed twice.
    pub fn decide(&mut self, now_ms: u64, nonce: &str) -> Decision {
        if self.seen.contains(nonce) { return Decision::Refuse("this request was already answered"); }
        let in_window = self.paired_at.map(|t| now_ms >= t && now_ms - t <= WINDOW_MS).unwrap_or(false);
        if !in_window && !self.tapped { return Decision::Refuse("the person has not allowed this"); }
        self.seen.insert(nonce.to_string());
        self.tapped = false;
        Decision::Sign
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_has_the_prefix_and_binds_every_field() {
        let m = String::from_utf8(message("KEY", "box1", "dev1", "n1", 1700000000000).unwrap()).unwrap();
        assert!(m.starts_with("vyre-companion-v1\n"));
        for f in ["core:KEY", "box:box1", "device:dev1", "nonce:n1", "ts:1700000000000"] { assert!(m.contains(f), "{f}"); }
        let other = String::from_utf8(message("KEY", "box1", "dev1", "n2", 1700000000000).unwrap()).unwrap();
        assert_ne!(m, other);
    }

    #[test]
    fn a_field_that_could_forge_another_is_refused() {
        assert!(message("K\nbox:evil", "b", "d", "n", 1).is_err());
        assert!(message("K", "", "d", "n", 1).is_err());
        assert!(message("K", "b", "d", &"x".repeat(257), 1).is_err());
        assert!(message("K", "b d", "d", "n", 1).is_err());
    }

    #[test]
    fn nothing_is_signed_before_pairing_or_a_tap() {
        let mut g = Gate::new();
        assert_eq!(g.decide(1_000, "a"), Decision::Refuse("the person has not allowed this"));
    }

    #[test]
    fn inside_the_window_after_pairing_it_signs_and_once_per_nonce() {
        let mut g = Gate::new();
        g.paired(10_000);
        assert_eq!(g.decide(10_000 + 1000, "a"), Decision::Sign);
        assert_eq!(g.decide(10_000 + 2000, "a"), Decision::Refuse("this request was already answered"));
        assert_eq!(g.decide(10_000 + 3000, "b"), Decision::Sign, "another nonce in the window is its own request");
    }

    #[test]
    fn the_window_ends_and_then_only_a_tap_allows_one_request() {
        let mut g = Gate::new();
        g.paired(0);
        assert_eq!(g.decide(WINDOW_MS + 1, "a"), Decision::Refuse("the person has not allowed this"));
        g.tap();
        assert_eq!(g.decide(WINDOW_MS + 2, "a"), Decision::Sign);
        assert_eq!(g.decide(WINDOW_MS + 3, "b"), Decision::Refuse("the person has not allowed this"), "a tap allows one");
    }

    #[test]
    fn a_clock_that_runs_backwards_does_not_open_the_window() {
        let mut g = Gate::new();
        g.paired(100_000);
        assert_eq!(g.decide(50_000, "a"), Decision::Refuse("the person has not allowed this"));
    }
}
