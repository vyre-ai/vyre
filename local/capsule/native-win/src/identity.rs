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
