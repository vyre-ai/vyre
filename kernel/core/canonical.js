// kernel/core/canonical.js: one canonical JSON and one hash, so a commitment, an event hash and a presence
// payload hash are the same bytes on every node. Keys sorted, no whitespace, undefined dropped, numbers finite.
// Portable: @noble through lib/databox.js's neighbours, no node:crypto and no Buffer, so the same file runs on a server, a phone and a browser.
import { sha256 as sha256Bytes } from "@noble/hashes/sha2";
import { hmac as hmacBytes } from "@noble/hashes/hmac";
import { toB64u, utf8 } from "../../lib/databox.js";

/** @param {unknown} v @returns {string} */
export function canonical(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("canonical: number must be finite");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(x => (x === undefined ? "null" : canonical(x))).join(",") + "]";
  if (typeof v === "object") {
    // Date, Map, Set and class instances would encode as {} and let different data share a hash: refuse them.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("canonical: only plain objects and arrays");
    const o = /** @type {Record<string, unknown>} */ (v);
    return "{" + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  throw new TypeError(`canonical: cannot encode ${typeof v}`);
}

const bytes = (/** @type {string | Uint8Array} */ x) => (typeof x === "string" ? utf8(x) : x);

/** sha-256 over text or bytes, base64url without padding. @param {string | Uint8Array} x */
export const sha256 = x => toB64u(sha256Bytes(bytes(x)));

/** @param {string | Uint8Array} key @param {string} text */
export const hmac = (key, text) => toB64u(hmacBytes(sha256Bytes, bytes(key), utf8(text)));

/** Constant-time equality for two base64url strings. */
export function sameMac(/** @type {string} */ a, /** @type {string} */ b) {
  const x = utf8(a), y = utf8(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
