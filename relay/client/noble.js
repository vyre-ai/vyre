// @ts-check
// noble: a crypto provider built from @noble functions the app injects, for React Native, where
// Hermes has no WebCrypto X25519. The repo does not depend on @noble; the Expo app does:
//
//   import { x25519 } from "@noble/curves/ed25519";
//   import { sha256 } from "@noble/hashes/sha256";
//   import { hmac } from "@noble/hashes/hmac";
//   import { gcm } from "@noble/ciphers/aes";
//   import { randomBytes } from "@noble/hashes/utils";   // or expo-crypto's getRandomBytes
//   const crypto = nobleCrypto({ x25519, sha256, hmac, gcm, randomBytes });
//
// Keys here are raw bytes (JS has no non-extractable memory), so the app keeps the private key
// in expo-secure-store (the Keychain or the Android Keystore) through its key store.

import { toBytes } from "./bytes.js";

/**
 * @param {{
 *   x25519: { getPublicKey(priv: Uint8Array): Uint8Array, getSharedSecret(priv: Uint8Array, pub: Uint8Array): Uint8Array,
 *     utils?: { randomSecretKey?: () => Uint8Array, randomPrivateKey?: () => Uint8Array } },
 *   sha256: (b: Uint8Array) => Uint8Array,
 *   hmac: (hash: any, key: Uint8Array, msg: Uint8Array) => Uint8Array,
 *   gcm: (key: Uint8Array, nonce: Uint8Array, aad?: Uint8Array) => { encrypt(pt: Uint8Array): Uint8Array, decrypt(ct: Uint8Array): Uint8Array },
 *   randomBytes: (n: number) => Uint8Array,
 * }} n
 * @returns {import("./noise.js").CryptoProvider & { importKeyPair(raw: Uint8Array): Promise<import("./noise.js").KeyPair> }}
 */
export function nobleCrypto(n) {
  for (const k of ["x25519", "sha256", "hmac", "gcm", "randomBytes"]) if (!n || !n[k]) throw new Error(`nobleCrypto needs ${k}`);
  const secret = () => n.x25519.utils?.randomSecretKey?.() || n.x25519.utils?.randomPrivateKey?.() || n.randomBytes(32);
  return {
    async generateKeyPair() { const priv = secret(); return { privateKey: priv, publicKey: n.x25519.getPublicKey(priv) }; },
    async dh(priv, pub) { return n.x25519.getSharedSecret(priv, pub); },
    async sha256(b) { return n.sha256(b); },
    async hmacSha256(key, b) { return n.hmac(n.sha256, key, b); },
    async aesGcmEncrypt(key, nonce, ad, pt) { return n.gcm(key, nonce, ad).encrypt(pt); },
    async aesGcmDecrypt(key, nonce, ad, ct) { return n.gcm(key, nonce, ad).decrypt(ct); },
    randomBytes: len => n.randomBytes(len),
    async importKeyPair(raw) { const priv = toBytes(raw).slice(); return { privateKey: priv, publicKey: n.x25519.getPublicKey(priv) }; },
  };
}
