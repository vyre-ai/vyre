//! The Windows app's identity key, the way the Mac app's is (local/capsule/native/Sources/Host/MacIdentity.swift, MacEnclave.swift). The page, a remote one on the person's own server, never holds a
//! seed: it asks for the Ed25519 public key and for signatures over the bytes of a chain operation, and Rust signs. A second key, a P-256 key in the TPM behind Windows Hello, is the
//! device entry's `enclave` key (NK-2): its public point is raw uncompressed (65 bytes) and its signatures are raw r||s (64 bytes). The TPM calls are the app's (ncrypt.rs, Windows only);
//! this file is the part that is the same on every host, so it is tested without a Windows machine: the Ed25519 key and the shape of the TPM's public blob.

use ed25519_dalek::{Signer, SigningKey};

/// The 32-byte Ed25519 public key for a 32-byte seed.
pub fn public_key(seed: &[u8; 32]) -> [u8; 32] { SigningKey::from_bytes(seed).verifying_key().to_bytes() }

/// The 64-byte Ed25519 signature of `message` under a 32-byte seed.
pub fn sign(seed: &[u8; 32], message: &[u8]) -> [u8; 64] { SigningKey::from_bytes(seed).sign(message).to_bytes() }

/// BCRYPT_ECCPUBLIC_BLOB: the magic "ECS1" (0x31534345), the key size in bytes (32 for P-256), then X and Y, 32 bytes each, big-endian.
const ECS1: u32 = 0x3153_4345;

/// The raw uncompressed point (0x04, X, Y: 65 bytes) a BCRYPT_ECCPUBLIC_BLOB of a P-256 key holds, or None for any other blob.
pub fn point_from_ecc_blob(blob: &[u8]) -> Option<[u8; 65]> {
    if blob.len() != 8 + 64 { return None; }
    let magic = u32::from_le_bytes(blob[0..4].try_into().ok()?);
    let cb = u32::from_le_bytes(blob[4..8].try_into().ok()?);
    if magic != ECS1 || cb != 32 { return None; }
    let mut p = [0u8; 65];
    p[0] = 4;
    p[1..].copy_from_slice(&blob[8..72]);
    Some(p)
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
