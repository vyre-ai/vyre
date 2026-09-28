// @ts-check
// Vendored from app-design's round5/payload.js (ADR 0033), CommonJS -> ESM, and fingerprint8
// ported off Node's `crypto` module (not available in the browser) onto Web Crypto's
// `crypto.subtle.digest`, which both a real browser and Node's own `--test` runner provide, so
// this needs no build-time swap between the two. Everything else is unchanged: an 8-byte public
// identifier (a stand-in for a public-key fingerprint - never a secret), a CRC-8, and 9 bytes of
// Reed-Solomon parity. 8 + 1 = 9 data bytes (72 bits), 9 parity bytes (corrects up to 4 byte
// errors), 18 bytes total = 144 bits, laid out as 2 rings of 36 marks (see vyrecode2.js).
import { encode, decode } from "./rs.js";

const PARITY = 9;

function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
  }
  return crc;
}

/** A stand-in for a real public-key fingerprint: SHA-256 of a string, truncated to 8 bytes. Never
 * a secret; this is the public id a Vyre code carries. @param {string} publicSeed @returns {Promise<number[]>} */
export async function fingerprint8(publicSeed) {
  const bytes = new TextEncoder().encode(publicSeed);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 8);
}

/** Builds the 144-bit (18-byte) codeword for an 8-byte id. @param {number[]} id8 */
export function buildCodeword(id8) {
  if (id8.length !== 8) throw new Error("id must be 8 bytes");
  const data = [...id8, crc8(id8)];
  return encode(data, PARITY);
}

/** Bytes to a bit array, MSB first, for the physical dot layout. @param {number[]} bytes */
export function bytesToBits(bytes) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
}
export function bitsToBytes(bits) {
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
    bytes.push(b);
  }
  return bytes;
}

/** Recovers the 8-byte id from a possibly-corrupted 18-byte codeword, or null if RS/CRC fail.
 * @param {number[]} received18 */
export function recoverId(received18) {
  const r = decode(received18, PARITY);
  if (!r.ok) return null;
  const data = /** @type {number[]} */ (r.corrected).slice(0, 9);
  const id8 = data.slice(0, 8);
  if (crc8(id8) !== data[8]) return null;
  return { id8, errorsCorrected: r.errors };
}

export { PARITY, crc8 };
