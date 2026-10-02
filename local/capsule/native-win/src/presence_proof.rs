//! The app's presence proof for asking the box to accept the local core as a companion (#26, v0.2.3).
//!
//! The box's `link.companion.pair` (core/link/companion.js) takes the same proof every device key
//! gives (core/presence): the header `device key=<id> ts=<ms> nonce=<n> sig=<s>`, where `sig` is an
//! ES256 (P-256, DER) signature over `vyre-presence-v1\n<tool>\n<hash>\n<ts>\n<nonce>` and `hash` is the
//! base64url SHA-256 of the canonical (sorted-key) JSON of the call's input. The proof therefore covers
//! the tool, the core's key, the nonce and the time, which is what the countersign has to bind.
//!
//! The key is the app's own, held under DPAPI, and it signs through ONE function here, for ONE tool
//! with an input the app builds itself. There is no way to ask it to sign other bytes, so it is not a
//! signing oracle for whatever connects to the app.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The only tool the key signs for.
pub const TOOL: &str = "link.companion.pair";

/// core/presence's `canonical`: sorted keys, no spaces, arrays in order.
pub fn canonical(v: &Value) -> String {
    match v {
        Value::Array(a) => format!("[{}]", a.iter().map(canonical).collect::<Vec<_>>().join(",")),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            format!("{{{}}}", keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical(&o[*k]))).collect::<Vec<_>>().join(","))
        }
        other => serde_json::to_string(other).unwrap(),
    }
}

/// core/presence's `inputHash`.
pub fn input_hash(input: &Value) -> String { B64U.encode(Sha256::digest(canonical(input).as_bytes())) }

/// The fields of a name, key or nonce the app will put in a call: the box's own pattern and no more.
fn token(v: &str, min: usize, max: usize) -> bool { v.len() >= min && v.len() <= max && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }

/// The call's input, built here from values the app checked: the core's public key (base64url of its
/// P-256 key), a label for the person to see, a nonce and the time.
pub fn companion_input(core: &str, name: &str, nonce: &str, ts_ms: u64) -> Result<Value, String> {
    if !token(core, 60, 200) { return Err("the core's key is not a public key the app will vouch for".into()); }
    if !token(nonce, 16, 64) { return Err("the nonce is not in a shape the app will sign".into()); }
    let name: String = name.chars().filter(|c| !c.is_control()).take(64).collect();
    Ok(json!({ "core": core, "name": if name.trim().is_empty() { "this PC's core".to_string() } else { name }, "nonce": nonce, "ts": ts_ms }))
}

pub struct ProofKey(SigningKey);

impl ProofKey {
    pub fn from_scalar(b: &[u8; 32]) -> Result<ProofKey, String> {
        SigningKey::from_slice(b).map(ProofKey).map_err(|_| "that is not a usable P-256 key".to_string())
    }

    /// SubjectPublicKeyInfo DER of the public key: the fixed P-256 header, then the uncompressed point.
    fn spki_der(&self) -> Vec<u8> {
        const HEAD: [u8; 26] = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00];
        let mut v = HEAD.to_vec();
        v.extend_from_slice(self.0.verifying_key().to_encoded_point(false).as_bytes());
        v
    }

    /// The public key as the box stores it: SPKI DER, base64url.
    pub fn public_spki_b64u(&self) -> String { B64U.encode(self.spki_der()) }

    /// The box's key id: the first 22 characters of the base64url SHA-256 of the SPKI DER.
    pub fn key_id(&self) -> String { B64U.encode(Sha256::digest(self.spki_der()))[..22].to_string() }

    fn header(&self, tool: &str, input: &Value, ts_ms: u64, nonce: &str) -> String {
        let msg = format!("vyre-presence-v1\n{tool}\n{}\n{ts_ms}\n{nonce}", input_hash(input));
        let sig: Signature = self.0.sign(msg.as_bytes());
        format!("device key={} ts={ts_ms} nonce={nonce} sig={}", self.key_id(), B64U.encode(sig.to_der().as_bytes()))
    }

    /// The `x-vyre-presence` header for `link.companion.pair` with exactly `input` (from `companion_input`).
    /// The proof's own nonce is separate from the call's, and is spent on the box once.
    pub fn companion_proof(&self, input: &Value, ts_ms: u64, proof_nonce: &str) -> Result<String, String> {
        if !token(proof_nonce, 8, 128) { return Err("the proof nonce is not in a shape the app will sign".into()); }
        Ok(self.header(TOOL, input, ts_ms, proof_nonce))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};

    fn key() -> ProofKey { ProofKey::from_scalar(&[7u8; 32]).unwrap() }

    #[test]
    fn the_hash_is_the_presence_layers_over_sorted_keys() {
        let v = json!({ "b": 1, "a": ["x", { "d": null, "c": "é" }], "e": true });
        assert_eq!(canonical(&v), r#"{"a":["x",{"c":"é","d":null}],"b":1,"e":true}"#);
        assert_eq!(input_hash(&json!({})), B64U.encode(Sha256::digest(b"{}")));
    }

    #[test]
    fn the_input_is_built_from_checked_values_only() {
        let core = "A".repeat(87);
        assert!(companion_input(&core, "Alex's PC", &"n".repeat(22), 1).is_ok());
        for (c, n) in [("short", "n".repeat(22)), (&core as &str, "short".to_string()), ("a b".repeat(30).as_str(), "n".repeat(22))] {
            assert!(companion_input(c, "x", &n, 1).is_err());
        }
        let i = companion_input(&core, "line\nbreak", &"n".repeat(22), 5).unwrap();
        assert_eq!(i["name"], "linebreak");
        assert_eq!(companion_input(&core, "  ", &"n".repeat(22), 5).unwrap()["name"], "this PC's core");
    }

    #[test]
    fn the_proof_verifies_against_the_message_the_box_builds() {
        let k = key();
        let input = companion_input(&"A".repeat(87), "PC", &"n".repeat(22), 1_700_000_000_000).unwrap();
        let h = k.companion_proof(&input, 1_700_000_000_123, "proofnonce0001").unwrap();
        let parts: Vec<&str> = h.split(' ').collect();
        assert_eq!(parts[0], "device");
        assert_eq!(parts[1], format!("key={}", k.key_id()));
        assert_eq!(parts[2], "ts=1700000000123");
        assert_eq!(parts[3], "nonce=proofnonce0001");
        let sig = B64U.decode(parts[4].strip_prefix("sig=").unwrap()).unwrap();
        let msg = format!("vyre-presence-v1\nlink.companion.pair\n{}\n1700000000123\nproofnonce0001", input_hash(&input));
        let vk = VerifyingKey::from(&k.0);
        vk.verify(msg.as_bytes(), &Signature::from_der(&sig).unwrap()).unwrap();
        let other = format!("vyre-presence-v1\nvault.reveal\n{}\n1700000000123\nproofnonce0001", input_hash(&input));
        assert!(vk.verify(other.as_bytes(), &Signature::from_der(&sig).unwrap()).is_err(), "bound to its tool");
        assert!(k.companion_proof(&input, 1, "short").is_err());
    }

    #[test]
    fn the_key_id_is_the_boxes_fingerprint_of_the_spki() {
        let k = key();
        let der = B64U.decode(k.public_spki_b64u()).unwrap();
        assert_eq!(der.len(), 91);
        assert_eq!(k.key_id(), B64U.encode(Sha256::digest(&der))[..22]);
        assert!(ProofKey::from_scalar(&[0u8; 32]).is_err());
    }

    /// Prints the shared vector (run once with --ignored --nocapture); the test below pins it.
    #[test]
    #[ignore]
    fn print_vector() {
        let k = key();
        let input = companion_input(&"A".repeat(87), "Alex's PC", &"n".repeat(22), 1_700_000_000_000).unwrap();
        let h = k.companion_proof(&input, 1_700_000_000_123, "proofnonce0001").unwrap();
        println!("{}", serde_json::to_string_pretty(&json!({ "scalar_hex": "07".repeat(32), "spki": k.public_spki_b64u(), "key_id": k.key_id(), "input": input, "ts": 1_700_000_000_123u64, "nonce": "proofnonce0001", "header": h })).unwrap());
    }

    #[test]
    fn the_shared_vector_is_reproduced_and_the_node_side_verifies_it() {
        // tests/presence-vector.json is also verified by test/windows-presence-proof.test.js with Node's crypto and core/presence's own hash.
        let v: Value = serde_json::from_str(include_str!("../tests/presence-vector.json")).unwrap();
        let k = key();
        assert_eq!(v["spki"], k.public_spki_b64u());
        assert_eq!(v["key_id"], k.key_id());
        assert_eq!(k.companion_proof(&v["input"], v["ts"].as_u64().unwrap(), v["nonce"].as_str().unwrap()).unwrap(), v["header"].as_str().unwrap());
    }
}
