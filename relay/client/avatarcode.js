// @ts-check
// The typed Wink code as a picture (0.2.9: the Wink camera reader). The drawn avatar carries the SAME eight symbols the person would type, so the camera reads the code instead of the person typing it, and the
// pairing that follows is the typed code's own (CPace over the relay, the ack typed back): no second secret, no second way to pair. lib/wink-code/payload.js protects 8 bytes with a CRC-8 and Reed-Solomon parity and
// the renderer draws them as the avatar's rings; this file is the 8 bytes' meaning. Pure and Node-free: it runs in the app, a browser and a phone.
//
//   byte 0      0xC1   the version and kind: "a typed Wink code"
//   bytes 1-5          the eight code symbols (two rendezvous, six password), five bits each, forty bits, most significant first
//   bytes 6-7   0x57 0x4B  "WK": so a ring that carries something else (an identity mark's fingerprint) is never read as a code
//
// The code is the secret of a ten minute, single use pairing, three wrong tries long: show the avatar on the showing device only, as the code itself.

import { ALPHABET, parseCode, formatCode, CODE_RV_CHARS, CODE_PW_CHARS } from "./code.js";

export const AVATAR_KIND = 0xc1;
const MAGIC = [0x57, 0x4b];

/** The 8 bytes a code's avatar carries, or null when it is not a code. @param {string} code @returns {Uint8Array | null} */
export function codeToAvatarBytes(code) {
  const p = parseCode(code);
  if (!p) return null;
  let bits = 0n;
  for (const c of p.rv + p.pw) bits = (bits << 5n) | BigInt(ALPHABET.indexOf(c));
  const out = new Uint8Array(8);
  out[0] = AVATAR_KIND;
  for (let i = 5; i >= 1; i--) { out[i] = Number(bits & 255n); bits >>= 8n; }
  out[6] = MAGIC[0]; out[7] = MAGIC[1];
  return out;
}

/** The typed code an avatar's 8 bytes carry (`WINK-NNPP-PPPP`), or null for anything else. @param {ArrayLike<number>} bytes */
export function avatarBytesToCode(bytes) {
  if (!bytes || bytes.length !== 8 || bytes[0] !== AVATAR_KIND || bytes[6] !== MAGIC[0] || bytes[7] !== MAGIC[1]) return null;
  let bits = 0n;
  for (let i = 1; i <= 5; i++) bits = (bits << 8n) | BigInt(bytes[i] & 255);
  let s = "";
  for (let i = 7; i >= 0; i--) s += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return formatCode(s.slice(0, CODE_RV_CHARS), s.slice(CODE_RV_CHARS, CODE_RV_CHARS + CODE_PW_CHARS));
}
