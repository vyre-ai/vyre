// @ts-check
// Private chat messages (stream.send enc { alg, kid, ct }): decrypted on the person's device only.

import { fromB64u, open, seal, text as bytesToText, toB64u } from "../../../../lib/databox.js";

const AAD = (/** @type {string} */ kid) => `vyre-chat-v1:${kid}`;

/** In-process keys the device holds for chat messages (tests and stream.decrypt). @type {Map<string, Uint8Array>} */
const held = new Map();

/** @param {string} kid @param {Uint8Array} key */
export function holdPrivateKey(kid, key) {
  held.set(kid, key);
}

/** @param {string} kid @returns {Promise<Uint8Array | null>} */
export async function resolveDecryptKid(kid) {
  return held.get(kid) ?? null;
}

/**
 * Open the message key for a kid (device-side: stream.decrypt / ring unwrap).
 * @param {string} kid
 * @returns {Promise<Uint8Array | null>}
 */
export async function openPrivateKey(kid) {
  if (!kid) return null;
  try {
    const { tool } = await import("../real/box");
    const r = /** @type {any} */ (await tool("stream.decrypt", { kid }));
    return r.key ? fromB64u(r.key) : null;
  } catch {
    return resolveDecryptKid(kid);
  }
}

/**
 * @param {{ alg?: string, kid?: string, ct?: string }} enc
 * @param {(kid: string) => Promise<Uint8Array | null>} opener
 * @returns {Promise<string | null>}
 */
export async function decryptUserMessage(enc, opener) {
  if (!enc || enc.alg !== "vyre-chat-v1" || !enc.kid || !enc.ct) return null;
  try {
    const box = JSON.parse(enc.ct);
    const key = await opener(enc.kid);
    if (!key) return null;
    return bytesToText(open(/** @type {any} */ (box), key, AAD(enc.kid)));
  } catch {
    return null;
  }
}

/** Seal plain text for tests and fixtures (vyre-chat-v1). @param {string} kid @param {Uint8Array} key @param {string} plain */
export function sealUserMessage(kid, key, plain) {
  const box = seal(plain, key, AAD(kid));
  return { alg: "vyre-chat-v1", kid, ct: JSON.stringify(box) };
}

/** @param {string} kid @param {Uint8Array} key */
export function exportKeyB64(kid, key) {
  return { kid, key: toB64u(key) };
}
