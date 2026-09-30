//! Reading a Wink pairing ticket (ADR 0045) on the Windows side. The shell has no Noise channel:
//! it only needs to know which box the ticket names, confirm that with the person, and pin the
//! address. The derivations, MAC and seal match core/relay/wire.js byte for byte (a fixture made
//! by that code is in tests/wink-vector.json). The relay lookup is one POST to /v1/pair.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub const TICKET_BYTES: usize = 8;
const SEAL_AD: &[u8] = b"vyre-pair-record\n1";
const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

fn derive(tag: &str, ticket: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag.as_bytes());
    h.update(b"\n");
    h.update(ticket);
    h.finalize().into()
}

/// The locator the relay stores the sealed record under (base64url), the only value it sees.
pub fn locator(ticket: &[u8]) -> String { B64U.encode(derive("vyre-pair-loc", ticket)) }

/// What a person confirms before anything is pinned.
#[derive(Debug, PartialEq, Eq)]
pub struct Offer {
    pub name: String,
    /// The box's subdomain of vyre.run, when the record carries a well-formed one.
    pub handle: Option<String>,
    /// "abcd 2345", the box key's fingerprint as the phone shows it.
    pub fingerprint: String,
}

impl Offer {
    /// The address to pin. Only a handle on vyre.run yields one; own-domain boxes pair another way.
    pub fn address(&self) -> Option<String> { self.handle.as_ref().map(|h| format!("https://{h}.vyre.run")) }
}

fn clean_name(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_control() || ('\u{200b}'..='\u{200f}').contains(&c) || ('\u{202a}'..='\u{202e}').contains(&c) || ('\u{2066}'..='\u{2069}').contains(&c) || c == '\u{feff}' { ' ' } else { c }).collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = t.chars().take(64).collect();
    if t.is_empty() { "a Vyre box".into() } else { t }
}

fn valid_handle(h: &str) -> bool {
    let b = h.as_bytes();
    !b.is_empty() && b.len() <= 32 && b[0].is_ascii_alphanumeric() && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// Check the relay's answer (MAC first, then the seal) and read the offer. `now_ms` is injected so
/// an expired record is testable.
pub fn open_record(ticket: &[u8], record: &str, mac: &str, now_ms: u64) -> Result<Offer, &'static str> {
    if ticket.len() != TICKET_BYTES { return Err("bad_input"); }
    let want = B64U.decode(mac).map_err(|_| "bad_record")?;
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(&derive("vyre-pair-mac", ticket)).unwrap();
    m.update(record.as_bytes());
    m.verify_slice(&want).map_err(|_| "bad_record")?;
    let sealed = B64U.decode(record).map_err(|_| "bad_record")?;
    if sealed.len() < 28 { return Err("bad_record"); }
    let cipher = Aes256Gcm::new_from_slice(&derive("vyre-pair-enc", ticket)).unwrap();
    let plain = cipher
        .decrypt(Nonce::from_slice(&sealed[..12]), Payload { msg: &sealed[12..], aad: SEAL_AD })
        .map_err(|_| "bad_record")?;
    let v: serde_json::Value = serde_json::from_slice(&plain).map_err(|_| "bad_record")?;
    if v["v"] != 1 { return Err("bad_record"); }
    if v["exp"].as_u64().ok_or("bad_record")? < now_ms { return Err("ticket_gone"); }
    let boxkey = B64U.decode(v["box"].as_str().ok_or("bad_record")?).map_err(|_| "bad_record")?;
    if boxkey.len() != 32 { return Err("bad_record"); }
    let d = Sha256::digest(&boxkey);
    let fp: String = (0..8).map(|i| {
        let bit = i * 5;
        let (byte, off) = (bit / 8, bit % 8);
        let two = ((d[byte] as u16) << 8) | *d.get(byte + 1).unwrap_or(&0) as u16;
        B32[((two >> (11 - off)) & 31) as usize] as char
    }).collect();
    Ok(Offer {
        name: clean_name(v["name"].as_str().unwrap_or("")),
        handle: v["handle"].as_str().filter(|h| valid_handle(h)).map(str::to_string),
        fingerprint: format!("{} {}", &fp[..4], &fp[4..]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v() -> serde_json::Value { serde_json::from_str(include_str!("../tests/wink-vector.json")).unwrap() }
    fn s<'a>(v: &'a serde_json::Value, k: &str) -> &'a str { v[k].as_str().unwrap() }
    fn ticket(v: &serde_json::Value) -> Vec<u8> { (0..8).map(|i| u8::from_str_radix(&s(v, "ticket")[i * 2..i * 2 + 2], 16).unwrap()).collect() }

    #[test]
    fn matches_the_node_vector() {
        let v = v();
        let t = ticket(&v);
        assert_eq!(locator(&t), s(&v, "loc"));
        let o = open_record(&t, s(&v, "record"), s(&v, "mac"), 1).unwrap();
        assert_eq!(o.name, s(&v, "name"));
        assert_eq!(o.handle.as_deref(), Some("alex"));
        assert_eq!(o.fingerprint, s(&v, "fingerprint"));
        assert_eq!(o.address().as_deref(), Some("https://alex.vyre.run"));
    }

    #[test]
    fn a_wrong_ticket_or_changed_record_is_refused() {
        let v = v();
        let t = ticket(&v);
        assert_eq!(open_record(&[9u8; 8], s(&v, "record"), s(&v, "mac"), 1), Err("bad_record"));
        let mut r = s(&v, "record").to_string();
        r.push('A');
        assert_eq!(open_record(&t, &r, s(&v, "mac"), 1), Err("bad_record"));
        assert_eq!(open_record(&t, s(&v, "record"), "AAAA", 1), Err("bad_record"));
        assert_eq!(open_record(&t[..4], s(&v, "record"), s(&v, "mac"), 1), Err("bad_input"));
    }

    #[test]
    fn an_expired_record_is_gone() {
        let v = v();
        assert_eq!(open_record(&ticket(&v), s(&v, "record"), s(&v, "mac"), 5_000_000_000_000), Err("ticket_gone"));
    }

    #[test]
    fn handles_and_names_are_cleaned() {
        assert!(valid_handle("alex-1") && !valid_handle("-alex") && !valid_handle("a.b") && !valid_handle(""));
        assert_eq!(clean_name("  a\u{202e}b\n c "), "a b c");
        assert_eq!(clean_name("\u{200b}"), "a Vyre box");
    }
}
