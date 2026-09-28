// Builds and parses the Vyre code's payload: an 8-byte public identifier (a stand-in for a
// public-key fingerprint - never a secret), a CRC-8, and 9 bytes of Reed-Solomon parity.
// 8 + 1 = 9 data bytes (72 bits, inside the "64 to 96 bits plus a checksum" the lead asked for),
// 9 parity bytes (corrects up to 4 byte errors), 18 bytes total = 144 bits. Layout-agnostic: how
// those 144 bits map onto marks (round5's 4 rings x 36 dots x 1 bit, or the final 2 rings x 36
// marks x 2 bits app-design's renderer draws) is the renderer/decoder's own concern, not this
// file's - see decode-core2.js for the current layout's geometry.
import * as rs from "./rs.js";

const PARITY = 9;

function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
  }
  return crc;
}

/** Builds the 144-bit (18-byte) codeword for an 8-byte id. @param {number[]} id8 */
function buildCodeword(id8) {
  if (id8.length !== 8) throw new Error("id must be 8 bytes");
  const data = [...id8, crc8(id8)];
  return rs.encode(data, PARITY);
}

/** Bytes to a bit array, MSB first, for the physical dot layout. @param {number[]} bytes */
function bytesToBits(bytes) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
}
function bitsToBytes(bits) {
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
function recoverId(received18) {
  const r = rs.decode(received18, PARITY);
  if (!r.ok) return null;
  const data = r.corrected.slice(0, 9);
  const id8 = data.slice(0, 8);
  if (crc8(id8) !== data[8]) return null;
  return { id8, errorsCorrected: r.errors };
}

export { PARITY, crc8, buildCodeword, bytesToBits, bitsToBytes, recoverId };
