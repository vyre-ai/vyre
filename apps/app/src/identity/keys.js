// @ts-check
// This device's identity key: Ed25519, made here, never sent anywhere. Where the platform's WebCrypto has Ed25519 the key is NON-EXTRACTABLE (the browser or the
// phone holds it and only signs with it). Where it does not, @noble/curves makes it and the seed is the app's to keep (flagged `software`, so a screen can say so).

import { ed25519 } from "@noble/curves/ed25519.js";
import { b64u, eidOf } from "../../../../kernel/identity/chain.js";

/**
 * @typedef {{ publicKey: string, eid: string, software: boolean, sign(message: Uint8Array): Promise<Uint8Array>, keep(): any }} DeviceKey
 * `keep()` is what a store persists: the CryptoKey pair itself (structured-cloneable, not extractable), or the noble seed.
 */

/** Does this platform's WebCrypto make Ed25519 keys? */
export async function webCryptoEd25519() {
  try { await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]); return true; } catch { return false; }
}

/** @param {{ forceSoftware?: boolean }} [o] @returns {Promise<DeviceKey>} */
export async function generateDeviceKey({ forceSoftware = false } = {}) {
  if (!forceSoftware && await webCryptoEd25519()) {
    const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]));
    return fromPair(pair);
  }
  return fromSeed(crypto.getRandomValues(new Uint8Array(32)));
}

/** @param {CryptoKeyPair} pair @returns {Promise<DeviceKey>} */
export async function fromPair(pair) {
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: b64u(pub), eid: await eidOf(pub), software: false, sign: async m => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, /** @type {BufferSource} */ (m))), keep: () => ({ kind: "webcrypto", pair }) };
}

/** @param {Uint8Array} seed @returns {Promise<DeviceKey>} */
export async function fromSeed(seed) {
  const pub = ed25519.getPublicKey(seed);
  return { publicKey: b64u(pub), eid: await eidOf(pub), software: true, sign: async m => ed25519.sign(m, seed), keep: () => ({ kind: "seed", seed }) };
}

/** A key from what keep() gave. @param {any} kept @returns {Promise<DeviceKey>} */
export const restoreDeviceKey = kept => (kept && kept.kind === "webcrypto" ? fromPair(kept.pair) : fromSeed(kept.seed));
