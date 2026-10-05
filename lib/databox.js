// @ts-check
// databox: the data cryptography the sealed stores need, SYNCHRONOUS and the same on Node, a phone and a browser (@noble/ciphers and @noble/hashes: pure JS, audited, no node:crypto, no Buffer).
// Sealing a record, a store key or a chat's content is AES-256-GCM with associated data; names are HMAC-SHA256 ids; keys are derived with HKDF-SHA256. The box is the same JSON the identity home and the rings
// use ({ v: 1, iv, ct, tag }, base64url), so a box made here opens in lib/keywrap.js and the other way round. Device-key operations (ECDH with the device's agree key) are NOT here: they are asynchronous, through
// the one getAgreeKey() hook, because that key lives in the platform keystore.
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { randomBytes, bytesToHex } from "@noble/hashes/utils";

const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const REV = (() => { /** @type {Record<string, number>} */ const m = {}; for (let i = 0; i < TABLE.length; i++) m[TABLE[i]] = i; return m; })();

/** Bytes to base64url (no padding). @param {Uint8Array} b */
export function toB64u(b) {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += TABLE[(n >> 18) & 63] + TABLE[(n >> 12) & 63] + (i + 1 < b.length ? TABLE[(n >> 6) & 63] : "") + (i + 2 < b.length ? TABLE[n & 63] : "");
  }
  return out;
}
/** base64url to bytes. @param {string} s */
export function fromB64u(s) {
  const t = String(s).replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((t.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < t.length; i += 4) {
    const a = REV[t[i]], b = REV[t[i + 1]], c = i + 2 < t.length ? REV[t[i + 2]] : 0, d = i + 3 < t.length ? REV[t[i + 3]] : 0;
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw Object.assign(new Error("bad base64url"), { code: "bad_format" });
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >> 16) & 255;
    if (i + 2 < t.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < t.length) out[o++] = n & 255;
  }
  return out;
}
const te = new TextEncoder(), td = new TextDecoder();
/** @param {string} s */ export const utf8 = s => te.encode(s);
/** @param {Uint8Array} b */ export const text = b => td.decode(b);

/** A new 32-byte key. */
export const newKey = () => randomBytes(32);

/** Encrypt under a 32-byte key, bound to `aad`. @param {Uint8Array|string} plain @param {Uint8Array} key @param {string} aad @returns {{ v: 1, iv: string, ct: string, tag: string }} */
export function seal(plain, key, aad) {
  const iv = randomBytes(12);
  const sealed = gcm(key, iv, utf8(aad)).encrypt(typeof plain === "string" ? utf8(plain) : plain);   // ciphertext followed by the 16-byte tag
  return { v: 1, iv: toB64u(iv), ct: toB64u(sealed.subarray(0, sealed.length - 16)), tag: toB64u(sealed.subarray(sealed.length - 16)) };
}

/** @param {{ v: number, iv: string, ct: string, tag: string }} box @param {Uint8Array} key @param {string} aad @returns {Uint8Array} @throws when the key or the binding is wrong */
export function open(box, key, aad) {
  if (!box || box.v !== 1) throw Object.assign(new Error("unknown format"), { code: "bad_format" });
  try {
    const ct = fromB64u(box.ct), tag = fromB64u(box.tag);
    const joined = new Uint8Array(ct.length + tag.length);
    joined.set(ct); joined.set(tag, ct.length);
    return gcm(key, fromB64u(box.iv), utf8(aad)).decrypt(joined);
  } catch { throw Object.assign(new Error("cannot open"), { code: "cannot_open" }); }
}

/** HKDF-SHA256 with an empty salt: a 32-byte key for one purpose. @param {Uint8Array} key @param {string} info */
export const derive = (key, info) => hkdf(sha256, key, undefined, utf8(info), 32);
/** HMAC-SHA256 of a string, hex. @param {Uint8Array} key @param {string} message */
export const hmacHex = (key, message) => bytesToHex(hmac(sha256, key, utf8(message)));
/** SHA-256 of bytes, hex. @param {Uint8Array} bytes */
export const sha256Hex = bytes => bytesToHex(sha256(bytes));

/** Standard base64 (what the server's storage tools carry as `data`). @param {Uint8Array} b */
export const toB64 = b => { const u = toB64u(b); return u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (u.length % 4)) % 4); };
/** @param {string} s */
export const fromB64 = s => fromB64u(String(s).replace(/\+/g, "-").replace(/\//g, "_"));
