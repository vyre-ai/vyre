// kernel/core/canonical.js: one canonical JSON and one hash, so a commitment, an event hash and a presence
// payload hash are the same bytes on every node. Keys sorted, no whitespace, undefined dropped, numbers finite.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** @param {unknown} v @returns {string} */
export function canonical(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("canonical: number must be finite");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(x => (x === undefined ? "null" : canonical(x))).join(",") + "]";
  if (typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    return "{" + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  throw new TypeError(`canonical: cannot encode ${typeof v}`);
}

const b64 = (/** @type {Buffer} */ b) => b.toString("base64url");

/** sha-256 over text or bytes, base64url without padding. @param {string | Uint8Array} x */
export const sha256 = x => b64(createHash("sha256").update(x).digest());

/** @param {string | Uint8Array} key @param {string} text */
export const hmac = (key, text) => b64(createHmac("sha256", key).update(text).digest());

/** Constant-time equality for two base64url strings. */
export function sameMac(/** @type {string} */ a, /** @type {string} */ b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
