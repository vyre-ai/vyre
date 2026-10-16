// @ts-check
// This browser's own device key (the key a new-device sign-in enrols, and the one the relay knows this page by). Ed25519 seed bytes, kept ONLY wrapped (AES-GCM) under a key derived from the
// unlocked identity seed, so it opens when the master password does and never sits in storage as anything usable. Never a stored CryptoKey (a Mac window does not give one back). One module for every
// platform; the Mac shell's Keychain bridge (relayKey) replaces the wrap where it is present, in the next stage.
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";

const enc = new TextEncoder();
const b64u = (/** @type {Uint8Array} */ b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (/** @type {string} */ s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };
const kekOf = (/** @type {Uint8Array} */ identitySeed) => hkdf(sha256, identitySeed, enc.encode("vyre-device-wrap"), enc.encode("vyre:device-key:wrap:v1"), 32);
const AAD = enc.encode("vyre:device-key:v1");

/**
 * A new device key, wrapped. @param {Uint8Array} identitySeed @param {(n: number) => Uint8Array} [random]
 * @returns {{ pub: string, wrapped: { iv: string, ct: string } }}
 */
export function makeDeviceKey(identitySeed, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const seed = random(32), iv = random(12);
  const kek = kekOf(identitySeed);
  const ct = gcm(kek, iv, AAD).encrypt(seed);
  const pub = b64u(ed25519.getPublicKey(seed));
  seed.fill(0); kek.fill(0);
  return { pub, wrapped: { iv: b64u(iv), ct: b64u(ct) } };
}

/**
 * Open it with the unlocked identity seed: its public half and a signer that holds the seed only for the call. A wrong identity seed (or a changed record) is `bad_device_key`.
 * @param {{ pub: string, wrapped: { iv: string, ct: string } }} kept @param {Uint8Array} identitySeed
 */
export function openDeviceKey(kept, identitySeed) {
  const kek = kekOf(identitySeed);
  /** @type {Uint8Array} */ let seed;
  try { seed = gcm(kek, unb64(kept.wrapped.iv), AAD).decrypt(unb64(kept.wrapped.ct)); }
  catch { throw Object.assign(new Error("This device's key does not open with this identity."), { code: "bad_device_key" }); }
  finally { kek.fill(0); }
  if (b64u(ed25519.getPublicKey(seed)) !== kept.pub) { seed.fill(0); throw Object.assign(new Error("This device's key does not match its record."), { code: "bad_device_key" }); }
  return { pub: kept.pub, sign: (/** @type {Uint8Array} */ m) => ed25519.sign(m, seed), close: () => seed.fill(0) };
}
