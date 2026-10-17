// @ts-check
// The hash a person's key signs for an approval, recomputed here from the fields the person SEES (reviewer-2 AP-1): the box hands over a payload_hash with the card, and a box that could be altered must
// not be able to show one act and hand over the hash of another. Same bytes as kernel/seal/wire.js: sha-256 (base64url) over sorted-key JSON of { op, space, fields } (the nested form, platform b1cc0b0ed: a field named op or space can no longer stand in for the real one).
import { canonical } from "../../../../kernel/core/canonical.js";

// No node:crypto and no Buffer: the Android and web bundles cannot resolve them, and a plain node test cannot import a .ts file. The sha-256 is @noble/hashes' (pure JS, already in the app for unlock and the master
// key, and in Node, Metro and the web alike); only the base64url encoding below is written here. approvals.test.js and test/bytes-single.test.js hold the result to the kernel's own node:crypto bytes.
import { sha256 } from "@noble/hashes/sha2";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** base64url without padding. @param {Uint8Array} bytes */
const b64url = (bytes) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += ALPHABET[n & 63];
  }
  return out;
};

/** The two helpers, exported so a test can hold them to node:crypto byte for byte. */
export { sha256, b64url };

/** Sorted-key JSON, no spaces: the kernel's canonical, imported not copied (kernel/core/canonical.js, which is kernel/seal/wire.js's byte for byte). */
export { canonical };

/** @param {string} op @param {string} space @param {Record<string, any>} fields */
export const payloadHash = (op, space, fields) => b64url(sha256(new TextEncoder().encode(canonical({ op, space, fields }))));

/** Does the hash the box gave match the fields shown? @param {{ op: string, space: string, fields: Record<string, any>, payload_hash: string }} c */
export const hashMatches = (c) => typeof c.payload_hash === "string" && payloadHash(c.op, c.space, c.fields ?? {}) === c.payload_hash;
