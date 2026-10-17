// @ts-check
// Unlocked key material for this process only. The identity file and the vault key file stay the stores; this map is what sign() uses after the plaintext halves are wrapped.

import crypto from "node:crypto";
import path from "node:path";

/** @typedef {{ privateKey: Buffer, agreePrivate: Buffer|null }} Held */

/** @type {Map<string, Held>} */
const ids = new Map();
/** @type {Buffer|null} */
let personal = null;

const keyOf = (/** @type {string} */ file) => path.resolve(file);

/** @param {string} file @param {{ privateKeyB64: string, agreePrivateB64?: string|null }} material */
export function holdIdentity(file, material) {
  forgetIdentity(file);
  ids.set(keyOf(file), {
    privateKey: Buffer.from(material.privateKeyB64, "base64url"),
    agreePrivate: material.agreePrivateB64 ? Buffer.from(material.agreePrivateB64, "base64url") : null,
  });
}

/** PKCS8 DER, or null when this process has not unlocked that file. @param {string} file @returns {Buffer|null} */
export function signingDer(file) {
  const h = ids.get(keyOf(file));
  return h ? h.privateKey : null;
}

/** The agreement scalar, or null. @param {string} file @returns {Buffer|null} */
export function agreeScalar(file) {
  const h = ids.get(keyOf(file));
  return h ? h.agreePrivate : null;
}

/** @param {string} file */
export function forgetIdentity(file) {
  const h = ids.get(keyOf(file));
  if (!h) return;
  h.privateKey.fill(0);
  if (h.agreePrivate) h.agreePrivate.fill(0);
  ids.delete(keyOf(file));
}

/** @param {string} file */
export function identityHeld(file) {
  return ids.has(keyOf(file));
}

/** A copy of the personal vault master key, when this process unwrapped one. @param {Buffer|Uint8Array|null} bytes */
export function holdPersonal(bytes) {
  clearPersonal();
  personal = bytes ? Buffer.from(bytes) : null;
}

/** @returns {Buffer|null} a copy, so the caller can zero its own */
export function currentPersonalKey() {
  return personal ? Buffer.from(personal) : null;
}

export function personalKeyIfUnlocked() {
  return currentPersonalKey();
}

export function clearPersonal() {
  if (personal) personal.fill(0);
  personal = null;
}

/** Drop every unlocked key. Tests and identity.lock use this. */
export function forgetAll() {
  for (const f of [...ids.keys()]) forgetIdentity(f);
  clearPersonal();
}

/** @param {Buffer} der */
export function keyObjectFromDer(der) {
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}
