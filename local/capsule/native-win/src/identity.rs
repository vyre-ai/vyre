//! The Windows app's identity key, the way the Mac app's is (local/capsule/native/Sources/Host/MacIdentity.swift, MacEnclave.swift). The page, a remote one on the person's own server, never holds a
//! seed: it asks for the Ed25519 public key and for signatures over the bytes of a chain operation, and Rust signs. A second key, a P-256 key in the TPM behind Windows Hello, is the
//! device entry's `enclave` key (NK-2): its public point is raw uncompressed (65 bytes) and its signatures are raw r||s (64 bytes). The TPM calls are the app's (ncrypt.rs, Windows only);
//! this file is the part that is the same on every host, so it is tested without a Windows machine: the Ed25519 key and the shape of the TPM's public blob.

use ed25519_dalek::{Signer, SigningKey};

/// The BCRYPT_ECCPUBLIC_BLOB of a peer's raw uncompressed point (65 bytes, 0x04 first) as an ECDH public key, for CNG to import; None for anything else.
pub fn ecdh_blob_from_point(point: &[u8]) -> Option<Vec<u8>> {
    if point.len() != 65 || point[0] != 4 { return None; }
    let mut blob = Vec::with_capacity(72);
    blob.extend_from_slice(&ECK1.to_le_bytes());
    blob.extend_from_slice(&32u32.to_le_bytes());
    blob.extend_from_slice(&point[1..]);
    Some(blob)
}

/// CNG's raw ECDH secret comes back little-endian; the agreed value everyone else uses (node's computeSecret, CryptoKit, WebCrypto) is the big-endian X coordinate.
pub fn secret_big_endian(raw: &[u8]) -> Option<[u8; 32]> {
    if raw.len() != 32 { return None; }
    let mut out = [0u8; 32];
    for (i, b) in raw.iter().rev().enumerate() { out[i] = *b; }
    Some(out)
}

/// The 32-byte Ed25519 public key for a 32-byte seed.
pub fn public_key(seed: &[u8; 32]) -> [u8; 32] { SigningKey::from_bytes(seed).verifying_key().to_bytes() }

/// The 64-byte Ed25519 signature of `message` under a 32-byte seed.
pub fn sign(seed: &[u8; 32], message: &[u8]) -> [u8; 64] { SigningKey::from_bytes(seed).sign(message).to_bytes() }

/// BCRYPT_ECCPUBLIC_BLOB: the magic ("ECS1", 0x31534345, for an ECDSA key; "ECK1", 0x314B4345, for an ECDH key), the key size in bytes (32 for P-256), then X and Y, 32 bytes each, big-endian.
const ECS1: u32 = 0x3153_4345;
const ECK1: u32 = 0x314B_4345;

/// The raw uncompressed point (0x04, X, Y: 65 bytes) a BCRYPT_ECCPUBLIC_BLOB of a P-256 key holds, or None for any other blob.
/// An ECDH key's blob is the same but for its magic.
pub fn point_from_ecc_blob(blob: &[u8]) -> Option<[u8; 65]> {
    if blob.len() != 8 + 64 { return None; }
    let magic = u32::from_le_bytes(blob[0..4].try_into().ok()?);
    let cb = u32::from_le_bytes(blob[4..8].try_into().ok()?);
    if (magic != ECS1 && magic != ECK1) || cb != 32 { return None; }
    let mut p = [0u8; 65];
    p[0] = 4;
    p[1..].copy_from_slice(&blob[8..72]);
    Some(p)
}

/// What the person is told they are signing (KP-3): the shell reads the identity-list change itself ("vyre-chain-v1\n" and the op's JSON) and writes the words, so a page cannot call "add this
/// device" something else. None means the shell cannot read it, and then it is not signed. The page's own caption is never read.
pub fn chain_summary(message: &[u8]) -> Option<String> {
    let body = message.strip_prefix(b"vyre-chain-v1\n")?;
    let op: serde_json::Value = serde_json::from_slice(body).ok()?;
    let clean = |v: Option<&serde_json::Value>, max: usize| -> String {
        let t: String = v.and_then(|x| x.as_str()).unwrap_or("").chars().filter(|c| !c.is_control()).collect();
        let t = t.trim().to_string();
        if t.chars().count() > max { format!("{}...", t.chars().take(max).collect::<String>()) } else { t }
    };
    let entry = op.get("entry");
    let name = |e: &serde_json::Value| -> String {
        let l = clean(e.get("label"), 40);
        let l = if l.is_empty() { clean(e.get("subject"), 40) } else { l };
        if l.is_empty() { "unnamed".to_string() } else { l }
    };
    match op.get("type")?.as_str()? {
        "add" => {
            let e = entry?;
            match e.get("kind")?.as_str()? {
                "device" => Some(format!("Add a device: {}", name(e))),
                "contact" => Some(format!("Add a recovery contact: {}", name(e))),
                "code" => Some("Add a recovery code".to_string()),
                "owner" => Some(format!("Make {} an owner", name(e))),
                _ => None,
            }
        }
        "remove" => {
            let t = clean(op.get("target"), 12);
            if t.is_empty() { None } else { Some(format!("Remove a sign-in ({})", t)) }
        }
        "replace-code" => if entry?.get("kind")?.as_str()? == "code" { Some("Replace your recovery code".to_string()) } else { None },
        "recover" => {
            let e = entry?;
            if e.get("kind")?.as_str()? == "device" { Some(format!("Recover your name onto a new device: {}", name(e))) } else { None }
        }
        "agree" => if op.get("target")?.as_str().is_some() { Some("Add a sharing key to this device".to_string()) } else { None },
        "genesis" => Some(format!("Start an identity with this device: {}", name(entry?))),
        _ => None,
    }
}

/// A server ownership proof (relay/client/finish.js pairToProofMessage), read strictly: four lines, "vyre-wink-pair-to-v1", a 32-byte key in base64url (43 characters), a relay device id
/// (16 of a-z and 2-7) and a ticket tag (24 hex). Anything else is None, and is not signed. The server's own name is not in the bytes, so the words do not claim one.
pub fn pair_to_summary(message: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(message).ok()?;
    let lines: Vec<&str> = text.split('\n').collect();
    fn all(s: &str, n: usize, ok: fn(char) -> bool) -> bool { s.chars().count() == n && s.chars().all(ok) }
    if lines.len() != 4 || lines[0] != "vyre-wink-pair-to-v1" { return None; }
    if !all(lines[1], 43, |c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return None; }
    if !all(lines[2], 16, |c| c.is_ascii_lowercase() || ('2'..='7').contains(&c)) { return None; }
    if !all(lines[3], 24, |c| c.is_ascii_digit() || ('a'..='f').contains(&c)) { return None; }
    Some("Make the server you are pairing yours".to_string())
}

/// kernel/seal canonical: keys sorted by UTF-16 code units (the same order as `Object.keys().sort()`), no whitespace. A fraction is refused, the same as the Mac shell, so a page cannot hide a value the words would round.
pub fn canonical(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => Some("null".into()),
        serde_json::Value::Bool(b) => Some(if *b { "true" } else { "false" }.into()),
        serde_json::Value::String(s) => Some(json_quote(s)),
        serde_json::Value::Number(n) => canonical_number(n),
        serde_json::Value::Array(a) => {
            let mut parts = Vec::with_capacity(a.len());
            for x in a { parts.push(canonical(x)?); }
            Some(format!("[{}]", parts.join(",")))
        }
        serde_json::Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let mut parts = Vec::with_capacity(keys.len());
            for k in keys { parts.push(format!("{}:{}", json_quote(k), canonical(o.get(k)?)?)); }
            Some(format!("{{{}}}", parts.join(",")))
        }
    }
}

fn json_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Whole numbers inside the range JavaScript can name exactly. A fraction, or a number too large to round-trip, is None.
fn canonical_number(n: &serde_json::Number) -> Option<String> {
    const MAX: i64 = 9_007_199_254_740_991;
    if let Some(i) = n.as_i64() {
        if (-MAX..=MAX).contains(&i) { return Some(i.to_string()); }
        return None;
    }
    if let Some(u) = n.as_u64() {
        if u <= MAX as u64 { return Some(u.to_string()); }
    }
    None
}

fn sha256_b64url(s: &str) -> String {
    use sha2::{Digest, Sha256};
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(s.as_bytes()))
}

/// sha-256 (base64url) of the canonical `{ op, space, fields }`. None when a field is a fraction.
pub fn payload_hash(op: &str, space: &str, fields: &serde_json::Value) -> Option<String> {
    let body = serde_json::json!({ "op": op, "space": space, "fields": fields });
    Some(sha256_b64url(&canonical(&body)?))
}

fn clean_text(s: &str, max: usize) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).collect();
    let t = t.trim().to_string();
    if t.chars().count() > max { format!("{}...", t.chars().take(max).collect::<String>()) } else { t }
}

/// A yes-moment proof: the card's fields and space must hash to `payload_hash`, and the proof must name a decision and a nonce. The words are the shell's.
pub fn proof_summary(message: &[u8], fields: Option<&serde_json::Value>, space: Option<&str>) -> Option<String> {
    let fields = fields.filter(|f| f.is_object())?;
    let space = space?;
    let p: serde_json::Value = serde_json::from_slice(message).ok()?;
    let decision = p.get("decision")?.as_str()?;
    let hash = p.get("payload_hash")?.as_str()?;
    if p.get("nonce").is_none() { return None; }
    if payload_hash(decision, space, fields)? != hash { return None; }
    let what = clean_text(&decision.replace('_', " "), 60);
    let obj = fields.as_object()?;
    let mut keys: Vec<&String> = obj.keys().collect();
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut lines = vec![format!("Approve: {what}")];
    for k in keys.into_iter().take(6) {
        let v = match obj.get(k)? {
            serde_json::Value::String(s) => clean_text(s, 60),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
            _ => "...".to_string(),
        };
        lines.push(format!("{}: {v}", clean_text(k, 24)));
    }
    Some(lines.join("\n"))
}

/// Which store may hold a new identity key. Hello, then the TPM. Software only when the person was asked and said yes.
/// `software_yes` is None when nobody could answer, and that refuses a software key.
/// [reviewed: trust]
pub fn identity_key_store(hello: bool, tpm: bool, software_yes: Option<bool>) -> Result<&'static str, &'static str> {
    if hello {
        return Ok("windows_hello");
    }
    if tpm {
        return Ok("tpm");
    }
    if software_yes == Some(true) {
        return Ok("software");
    }
    Err("This computer has no TPM that Vyre can use.")
}

/// What the shell signs with the computer's key, in its own words: an identity-list change, a server ownership proof, or a yes-moment proof whose card matches. None is not signed. The page's caption is never read.
pub fn sign_summary(message: &[u8], fields: Option<&serde_json::Value>, space: Option<&str>) -> Option<String> {
    chain_summary(message).or_else(|| pair_to_summary(message)).or_else(|| proof_summary(message, fields, space))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier, VerifyingKey, Signature};

    fn hex(s: &str) -> Vec<u8> { (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect() }

    // RFC 8032 section 7.1, test 1 (the empty message)
    const SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const PUB: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const SIG: &str = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

    fn seed() -> [u8; 32] { hex(SEED).try_into().unwrap() }

    fn chain(json: &str) -> Vec<u8> { let mut m = b"vyre-chain-v1\n".to_vec(); m.extend_from_slice(json.as_bytes()); m }

    #[test]
    fn the_shell_writes_the_summary_from_the_bytes_and_refuses_what_it_cannot_read() {
        assert_eq!(chain_summary(&chain(r#"{"type":"add","entry":{"kind":"device","label":"Ana's iPhone"}}"#)).as_deref(), Some("Add a device: Ana's iPhone"));
        assert_eq!(chain_summary(&chain(r#"{"type":"add","entry":{"kind":"owner","label":"Sam"}}"#)).as_deref(), Some("Make Sam an owner"));
        assert_eq!(chain_summary(&chain(r#"{"type":"remove","target":"abc"}"#)).as_deref(), Some("Remove a sign-in (abc)"));
        assert_eq!(chain_summary(&chain(r#"{"type":"agree","target":"abc","agree":"x"}"#)).as_deref(), Some("Add a sharing key to this device"));
        assert_eq!(chain_summary(&chain(r#"{"type":"mystery"}"#)), None);
        assert_eq!(chain_summary(&chain(r#"{"type":"add","entry":{"kind":"robot"}}"#)), None);
        assert_eq!(chain_summary(b"not a chain message"), None);
        assert_eq!(chain_summary(&chain("{")), None);
    }

    // relay/client/pairto-vector.test.js pins the same bytes: what the app's identity signs to own a server (wink.server.adopt's proof).
    #[test]
    fn a_server_ownership_proof_the_real_bytes_is_read_and_any_other_shape_is_not() {
        use base64::Engine;
        let real = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode("dnlyZS13aW5rLXBhaXItdG8tdjEKQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Ywp5ZmJlcnByazJ4cTIya29iCjBiNjBjNDA2ZTZlMWE3YzM4YjY5MDBhMw").unwrap();
        assert_eq!(sign_summary(&real, None, None).as_deref(), Some("Make the server you are pairing yours"));
        let (b, d, t) = ("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc", "yfberprk2xq22kob", "0b60c406e6e1a7c38b6900a3");
        for bad in [
            format!("vyre-wink-pair-to-v1\n{b}\n{d}"),
            format!("vyre-wink-pair-to-v1\n{b}\n{d}\n{t}\nUnlock Drive"),
            format!("vyre-wink-pair-to-v1\n{b}\n{d}\n{t}\n"),
            format!("vyre-wink-pair-to-v1\n{b}x\n{d}\n{t}"),
            format!("vyre-wink-pair-to-v1\n{b}\nYFBERPRK2XQ22KOB\n{t}"),
            format!("vyre-wink-pair-to-v1\n{b}\n{d}\n{t}00"),
        ] {
            assert_eq!(sign_summary(bad.as_bytes(), None, None), None, "{bad}");
        }
        assert_eq!(sign_summary(&chain(r#"{"type":"add","entry":{"kind":"code"}}"#), None, None).as_deref(), Some("Add a recovery code"));
    }

    // kernel/seal/payloadhash-vectors.json, "empty fields". The same hash the Mac shell checks before it signs a yes-moment proof.
    #[test]
    fn a_yes_moment_proof_is_summarised_only_when_the_card_hashes_to_its_payload_hash() {
        let fields = serde_json::json!({});
        assert_eq!(
            payload_hash("grant.invite", "spc_aaaaaaaaaaaa", &fields).as_deref(),
            Some("ZLy1LQwY-00KVALmtNpi45C5M8X9spxqjZhoPnmqLA8")
        );
        assert_eq!(
            canonical(&serde_json::json!({"op": "grant.invite", "space": "spc_aaaaaaaaaaaa", "fields": {}})).as_deref(),
            Some(r#"{"fields":{},"op":"grant.invite","space":"spc_aaaaaaaaaaaa"}"#)
        );
        let proof = br#"{"decision":"grant.invite","nonce":"n","payload_hash":"ZLy1LQwY-00KVALmtNpi45C5M8X9spxqjZhoPnmqLA8"}"#;
        assert_eq!(sign_summary(proof, Some(&fields), Some("spc_aaaaaaaaaaaa")).as_deref(), Some("Approve: grant.invite"));
        let other = serde_json::json!({"to": "someone else"});
        assert_eq!(sign_summary(proof, Some(&other), Some("spc_aaaaaaaaaaaa")), None);
        assert_eq!(sign_summary(proof, None, None), None);
        let fraction = serde_json::json!({"f": 1.5});
        assert_eq!(payload_hash("grant.revoke", "spc_aaaaaaaaaaaa", &fraction), None, "a fraction is refused");
        let named = serde_json::json!({"to": "Sam"});
        let hash = payload_hash("make_owner", "spc_aaaaaaaaaaaa", &named).unwrap();
        let msg = format!(r#"{{"decision":"make_owner","nonce":"n","payload_hash":"{hash}"}}"#);
        let said = sign_summary(msg.as_bytes(), Some(&named), Some("spc_aaaaaaaaaaaa")).unwrap();
        assert_eq!(said, "Approve: make owner\nto: Sam");
    }

    #[test]
    fn a_label_cannot_smuggle_lines_or_length_into_the_summary() {
        let s = chain_summary(&chain(r#"{"type":"add","entry":{"kind":"device","label":"A\nUnlock Drive\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}"#)).unwrap();
        assert!(!s.contains('\n'));
        assert!(s.starts_with("Add a device: "));
        assert!(s.chars().count() < 70);
    }

    #[test]
    fn the_ed25519_key_matches_rfc_8032() {
        assert_eq!(public_key(&seed()).to_vec(), hex(PUB));
        assert_eq!(sign(&seed(), b"").to_vec(), hex(SIG));
    }

    #[test]
    fn a_signature_verifies_under_the_public_key_and_not_another_message() {
        let m = b"a chain operation";
        let sig = Signature::from_bytes(&sign(&seed(), m));
        let key = VerifyingKey::from_bytes(&public_key(&seed())).unwrap();
        assert!(key.verify(m, &sig).is_ok());
        assert!(key.verify(b"another", &sig).is_err());
    }

    #[test]
    fn the_tpm_blob_becomes_a_65_byte_uncompressed_point() {
        let mut blob = Vec::new();
        blob.extend_from_slice(&0x3153_4345u32.to_le_bytes());
        blob.extend_from_slice(&32u32.to_le_bytes());
        blob.extend((0..32).map(|i| i as u8));
        blob.extend((100..132).map(|i| i as u8));
        let p = point_from_ecc_blob(&blob).unwrap();
        assert_eq!(p[0], 4);
        assert_eq!(&p[1..33], &(0..32).map(|i| i as u8).collect::<Vec<_>>()[..]);
        assert_eq!(&p[33..], &(100..132).map(|i| i as u8).collect::<Vec<_>>()[..]);
    }

    #[test]
    fn an_ecdh_blob_has_the_same_point_and_round_trips_from_a_raw_point() {
        let mut point = [0u8; 65];
        point[0] = 4;
        for i in 1..65 { point[i] = i as u8; }
        let blob = ecdh_blob_from_point(&point).unwrap();
        assert_eq!(&blob[0..4], &0x314B_4345u32.to_le_bytes());
        assert_eq!(point_from_ecc_blob(&blob).unwrap(), point);
        assert!(ecdh_blob_from_point(&point[..64]).is_none(), "short");
        let mut compressed = point; compressed[0] = 2;
        assert!(ecdh_blob_from_point(&compressed).is_none(), "not uncompressed");
    }

    #[test]
    fn cngs_little_endian_secret_becomes_the_big_endian_x_coordinate() {
        let le: Vec<u8> = (0..32).collect();
        let be = secret_big_endian(&le).unwrap();
        assert_eq!(be[0], 31);
        assert_eq!(be[31], 0);
        assert!(secret_big_endian(&le[..31]).is_none());
    }

    #[test]
    fn a_software_key_is_made_only_after_the_person_says_yes() {
        assert_eq!(identity_key_store(true, false, None).unwrap(), "windows_hello");
        assert_eq!(identity_key_store(false, true, None).unwrap(), "tpm");
        assert_eq!(identity_key_store(false, false, Some(true)).unwrap(), "software");
        let refused = "This computer has no TPM that Vyre can use.";
        assert_eq!(identity_key_store(false, false, Some(false)), Err(refused));
        assert_eq!(identity_key_store(false, false, None), Err(refused));
    }

    #[test]
    fn any_other_blob_is_refused() {
        assert!(point_from_ecc_blob(&[]).is_none());
        let mut blob = vec![0u8; 72];
        assert!(point_from_ecc_blob(&blob).is_none(), "no magic");
        blob[0..4].copy_from_slice(&0x3153_4345u32.to_le_bytes());
        blob[4..8].copy_from_slice(&48u32.to_le_bytes());
        assert!(point_from_ecc_blob(&blob).is_none(), "a P-384 size");
        blob[4..8].copy_from_slice(&32u32.to_le_bytes());
        assert!(point_from_ecc_blob(&blob).is_some());
        blob.push(0);
        assert!(point_from_ecc_blob(&blob).is_none(), "trailing bytes");
    }
}
