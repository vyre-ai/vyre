//! The Windows app's Noise device key, as pure X25519 (plans/windows.md, tailnet's shellkey.js
//! contract). The private key never leaves Rust: a bundled page asks for the public half and for a
//! Diffie-Hellman result against a remote public key, never the key itself. Storage (DPAPI) is the
//! app's job; this only makes and uses the key.

use x25519_dalek::{PublicKey, StaticSecret};

pub fn public_key(secret: &[u8; 32]) -> [u8; 32] { PublicKey::from(&StaticSecret::from(*secret)).to_bytes() }

/// The shared secret with `remote`; an all-zero result (a low-order remote key) is refused.
pub fn dh(secret: &[u8; 32], remote: &[u8; 32]) -> Result<[u8; 32], &'static str> {
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(*remote));
    if !shared.was_contributory() { return Err("refused: not a valid public key"); }
    Ok(shared.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> [u8; 32] { let mut o = [0u8; 32]; for i in 0..32 { o[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap(); } o }

    // RFC 7748 section 6.1
    const A: &str = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
    const A_PUB: &str = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
    const B: &str = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb";
    const B_PUB: &str = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
    const SHARED: &str = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

    #[test]
    fn matches_rfc_7748() {
        assert_eq!(public_key(&hex(A)), hex(A_PUB));
        assert_eq!(dh(&hex(A), &hex(B_PUB)).unwrap(), hex(SHARED));
        assert_eq!(dh(&hex(B), &hex(A_PUB)).unwrap(), hex(SHARED));
    }

    #[test]
    fn a_low_order_remote_key_is_refused() {
        assert!(dh(&hex(A), &[0u8; 32]).is_err());
    }
}
