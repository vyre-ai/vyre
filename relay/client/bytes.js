// @ts-check
// bytes: the few byte helpers the device client needs, on Uint8Array alone, so the same code runs
// in a browser, in React Native (Hermes) and in Node. No Buffer, no atob.

export const EMPTY = new Uint8Array(0);

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {string} s */
export const utf8 = s => enc.encode(s);
/** @param {Uint8Array} b */
export const fromUtf8 = b => dec.decode(b);

/** @param {...Uint8Array} parts */
export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Any binary shape a WebSocket, fetch or a caller may hand us, as a Uint8Array. */
export function toBytes(v) {
  if (v == null) return EMPTY;
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return utf8(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError("expected a string, an ArrayBuffer or a Uint8Array");
}

/** @param {Uint8Array} a @param {Uint8Array} b constant time in the length of a */
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** @param {Uint8Array} b */
export const isZero = b => { let d = 0; for (let i = 0; i < b.length; i++) d |= b[i]; return d === 0; };

/** @param {Uint8Array} b */
export const hex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
/** @param {string} s */
export function fromHex(s) {
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const REV = new Map(Array.from(B64, (c, i) => [c, i]));

/** RFC 4648 base64url, no padding. @param {Uint8Array} b */
export function base64url(b) {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  if (b.length - i === 1) { const v = b[i] << 16; out += B64[v >> 18] + B64[(v >> 12) & 63]; }
  else if (b.length - i === 2) { const v = (b[i] << 16) | (b[i + 1] << 8); out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63]; }
  return out;
}

/** Decodes base64url (and plain base64, padded or not). Throws on anything else. @param {string} s */
export function fromBase64url(s) {
  const t = String(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (t.length % 4 === 1) throw new Error("bad base64");
  const out = new Uint8Array(Math.floor(t.length * 3 / 4));
  let bits = 0, value = 0, at = 0;
  for (const c of t) {
    const v = REV.get(c);
    if (v === undefined) throw new Error("bad base64");
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (value >> bits) & 255; }
  }
  return out;
}

/** A random v4 UUID from 16 random bytes. @param {Uint8Array} r */
export function uuidFrom(r) {
  const b = r.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
