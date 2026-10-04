// @ts-check
// The part of WebCrypto the identity code uses, on @noble, with no native import so Node can test it against node:crypto (webcrypto-impl.test.js). The phone's file
// (webcrypto.native.ts) installs it. SHA-256 digest; HKDF into AES-256-GCM; AES-GCM with additional data (128 bit tag); Ed25519 verify, STRICT (RFC 8032: a
// non-canonical S or a small-order key is refused, as Node and OpenSSL refuse them, so the phone, the box and the directory never disagree on a signature);
// ECDSA P-256 verify (passkey entries, esig). Everything else refuses with NotSupportedError, and a caller falls back (keys.js makes a seed key).

import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { gcm } from "@noble/ciphers/aes";
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";

/** A copy of the bytes: never a view of the caller's buffer. @param {any} d @returns {Uint8Array} */
const bytes = (d) => (d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)));
/** @param {any} a */
const nameOf = (a) => String(typeof a === "string" ? a : a?.name ?? "").toUpperCase();
/** @param {string} what */
const refuse = (what) => Object.assign(new Error(`${what} is not available on this runtime`), { name: "NotSupportedError" });
/** @param {Uint8Array} u */
const out = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);

/** @type {Record<string, (...a: any[]) => any>} */
export const methods = {
  async digest(/** @type {any} */ algo, /** @type {any} */ data) {
    if (nameOf(algo) !== "SHA-256") throw refuse(`digest ${nameOf(algo)}`);
    return out(sha256(bytes(data)));
  },
  async importKey(/** @type {string} */ format, /** @type {any} */ data, /** @type {any} */ algo) {
    if (format !== "raw") throw refuse(`importKey ${format}`);
    const n = nameOf(algo);
    if (n === "HKDF") return { kind: "hkdf", raw: bytes(data) };
    if (n === "ED25519") return { kind: "ed25519-public", raw: bytes(data) };
    if (n === "ECDSA" && nameOf(algo.namedCurve) === "P-256") return { kind: "p256-public", raw: bytes(data) };
    throw refuse(`importKey ${n}`);
  },
  async deriveKey(/** @type {any} */ algo, /** @type {any} */ base, /** @type {any} */ target) {
    if (nameOf(algo) !== "HKDF" || nameOf(algo.hash) !== "SHA-256" || nameOf(target) !== "AES-GCM" || base?.kind !== "hkdf") throw refuse("deriveKey");
    return { kind: "aes", raw: hkdf(sha256, base.raw, bytes(algo.salt), bytes(algo.info), target.length / 8) };
  },
  async encrypt(/** @type {any} */ algo, /** @type {any} */ key, /** @type {any} */ data) {
    if (nameOf(algo) !== "AES-GCM" || key?.kind !== "aes" || (algo.tagLength ?? 128) !== 128) throw refuse("encrypt");
    return out(gcm(key.raw, bytes(algo.iv), algo.additionalData ? bytes(algo.additionalData) : undefined).encrypt(bytes(data)));
  },
  async decrypt(/** @type {any} */ algo, /** @type {any} */ key, /** @type {any} */ data) {
    if (nameOf(algo) !== "AES-GCM" || key?.kind !== "aes" || (algo.tagLength ?? 128) !== 128) throw refuse("decrypt");
    return out(gcm(key.raw, bytes(algo.iv), algo.additionalData ? bytes(algo.additionalData) : undefined).decrypt(bytes(data)));
  },
  async verify(/** @type {any} */ algo, /** @type {any} */ key, /** @type {any} */ sig, /** @type {any} */ msg) {
    const n = nameOf(algo);
    try {
      if (n === "ED25519" && key?.kind === "ed25519-public") return ed25519.verify(bytes(sig), bytes(msg), key.raw, { zip215: false });
      if (n === "ECDSA" && key?.kind === "p256-public" && nameOf(algo.hash) === "SHA-256") return p256.verify(bytes(sig), sha256(bytes(msg)), key.raw, { lowS: false });
    } catch { return false; }
    throw refuse(`verify ${n}`);
  },
  async generateKey(/** @type {any} */ algo) { throw refuse(`generateKey ${nameOf(algo)}`); },
};

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** @param {string} s */
export function btoaImpl(s) {
  let o = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    o += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63] + (i + 1 < s.length ? ALPHA[(n >> 6) & 63] : "=") + (i + 2 < s.length ? ALPHA[n & 63] : "=");
  }
  return o;
}
/** @param {string} s */
export function atobImpl(s) {
  const t = s.replace(/[\t\n\f\r ]+/g, "").replace(/=+$/, "");
  let o = "", acc = 0, bits = 0;
  for (const ch of t) {
    const v = ALPHA.indexOf(ch);
    if (v < 0) throw Object.assign(new Error("not base64"), { name: "InvalidCharacterError" });
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; o += String.fromCharCode((acc >> bits) & 255); }
  }
  return o;
}

/**
 * Put what is missing on `g`: each subtle method one by one (a partial third-party subtle keeps its methods and gets the rest), btoa and atob, and a getRandomValues that is
 * ALWAYS `random` (the native source), never whatever polyfill loaded first. Then a boot check that fails closed: two draws must differ and not be all zero.
 * @param {any} g globalThis @param {(n: number) => Uint8Array} random the native random source, any length
 */
export function install(g, random) {
  g.crypto = g.crypto ?? {};
  g.crypto.getRandomValues = (/** @type {any} */ a) => {
    if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(random(a.byteLength));
    return a;
  };
  const a = g.crypto.getRandomValues(new Uint8Array(16)), b = g.crypto.getRandomValues(new Uint8Array(16));
  if (a.every((/** @type {number} */ x) => x === 0) || a.every((/** @type {number} */ x, /** @type {number} */ i) => x === b[i])) throw new Error("the random source is constant: refusing to start");
  g.crypto.subtle = g.crypto.subtle ?? {};
  for (const [k, f] of Object.entries(methods)) if (typeof g.crypto.subtle[k] !== "function") g.crypto.subtle[k] = f;
  if (typeof g.btoa !== "function") g.btoa = btoaImpl;
  if (typeof g.atob !== "function") g.atob = atobImpl;
}
