// @ts-check
// kernel/identity: the one key stretch for the recovery code (ADR 0051, DESIGN-wink section 2). The recovery entry's key is Argon2id of the code
// and the optional recovery password, so the paper alone is not enough, and a short password adds only the cost of this function against an
// offline guesser (the public half of the key is on a public list). The UI therefore recommends four or more words.
//
// Argon2id, RFC 9106, version 0x13, one lane, 19 MiB, two passes (the OWASP minimum), a 32 byte tag. The same file runs on every client and
// every verifier: Node's own argon2 where it has one (24.7 and later), otherwise the pure JS below, which a test pins to fixed vectors made
// by the native one. No imports but node:crypto, no dependency.

import crypto from "node:crypto";

export const STRETCH = Object.freeze({ memoryKiB: 19456, passes: 2, lanes: 1, tagLength: 32 });
export const STRETCH_SALT = "vyre-recovery-code-v1";

/**
 * @param {Uint8Array|string} secret @param {Uint8Array|string} [salt]
 * @param {{ memoryKiB: number, passes: number, lanes?: number, tagLength?: number, pure?: boolean }} [params]
 * @returns {Buffer}
 */
export function argon2id(secret, salt = STRETCH_SALT, params = STRETCH) {
  const P = { lanes: 1, tagLength: 32, ...params };
  if (P.lanes !== 1) throw new Error("one lane only");
  const pw = Buffer.from(secret), sa = Buffer.from(salt);
  // @ts-ignore argon2Sync exists from Node 24.7
  if (!P.pure && typeof crypto.argon2Sync === "function") {
    // @ts-ignore
    return Buffer.from(crypto.argon2Sync("argon2id", { message: pw, nonce: sa, parallelism: 1, tagLength: P.tagLength, memory: P.memoryKiB, passes: P.passes }));
  }
  return pureArgon2id(pw, sa, P.memoryKiB, P.passes, P.tagLength);
}

// ---------- BLAKE2b (variable output, no key), BigInt: used only for the few hashes around the big loop ----------
const M64 = (1n << 64n) - 1n;
const IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3], [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8], [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10], [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (/** @type {bigint} */ x, /** @type {bigint} */ n) => ((x >> n) | (x << (64n - n))) & M64;

/** @param {Uint8Array} data @param {number} outLen 1..64 */
function blake2b(data, outLen) {
  const h = IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  const total = data.length;
  const blocks = Math.max(1, Math.ceil(total / 128));
  for (let b = 0; b < blocks; b++) {
    const block = Buffer.alloc(128);
    Buffer.from(data.subarray(b * 128, Math.min(total, (b + 1) * 128))).copy(block);
    const m = Array.from({ length: 16 }, (_, i) => block.readBigUInt64LE(i * 8));
    const v = [...h, ...IV];
    const last = b === blocks - 1;
    v[12] ^= BigInt(last ? total : (b + 1) * 128) & M64;
    if (last) v[14] ^= M64;
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      const g = (/** @type {number} */ a, /** @type {number} */ bb, /** @type {number} */ c, /** @type {number} */ d, /** @type {bigint} */ x, /** @type {bigint} */ y) => {
        v[a] = (v[a] + v[bb] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32n);
        v[c] = (v[c] + v[d]) & M64; v[bb] = rotr(v[bb] ^ v[c], 24n);
        v[a] = (v[a] + v[bb] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16n);
        v[c] = (v[c] + v[d]) & M64; v[bb] = rotr(v[bb] ^ v[c], 63n);
      };
      g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]]); g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]]); g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[i], i * 8);
  return out.subarray(0, outLen);
}

const le32 = (/** @type {number} */ n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** Argon2's variable-length hash H'. @param {Uint8Array} x @param {number} outLen */
function hPrime(x, outLen) {
  const input = Buffer.concat([le32(outLen), x]);
  if (outLen <= 64) return Buffer.from(blake2b(input, outLen));
  const r = Math.ceil(outLen / 32) - 2;
  const parts = [];
  let v = blake2b(input, 64);
  parts.push(Buffer.from(v.subarray(0, 32)));
  for (let i = 2; i <= r; i++) { v = blake2b(v, 64); parts.push(Buffer.from(v.subarray(0, 32))); }
  parts.push(Buffer.from(blake2b(v, outLen - 32 * r)));
  return Buffer.concat(parts);
}

// ---------- the compression function on 32-bit halves (word w is lo at 2w, hi at 2w+1) ----------
/** @param {Uint32Array} v @param {number} a @param {number} b word indexes; a = a + b + 2 * lo(a) * lo(b) */
function mix(v, a, b) {
  const al = v[2 * a], ah = v[2 * a + 1], bl = v[2 * b], bh = v[2 * b + 1];
  const x0 = al & 0xffff, x1 = al >>> 16, y0 = bl & 0xffff, y1 = bl >>> 16;
  const p00 = x0 * y0, mid = x0 * y1 + x1 * y0, p11 = x1 * y1;
  const lo64 = p00 + (mid % 65536) * 65536;
  const plo = lo64 >>> 0;
  const phi = (p11 + Math.floor(mid / 65536) + Math.floor(lo64 / 4294967296)) >>> 0;
  const dlo = (plo << 1) >>> 0, dhi = ((phi << 1) | (plo >>> 31)) >>> 0;
  const sum = al + bl + dlo;
  v[2 * a] = sum >>> 0;
  v[2 * a + 1] = (ah + bh + dhi + Math.floor(sum / 4294967296)) >>> 0;
}
/** d = rotr(d ^ a, k) for 0 < k < 32 or k = 32. @param {Uint32Array} v @param {number} d @param {number} a @param {number} k */
function xr(v, d, a, k) {
  const lo = (v[2 * d] ^ v[2 * a]) >>> 0, hi = (v[2 * d + 1] ^ v[2 * a + 1]) >>> 0;
  if (k === 32) { v[2 * d] = hi; v[2 * d + 1] = lo; return; }
  v[2 * d] = ((lo >>> k) | (hi << (32 - k))) >>> 0;
  v[2 * d + 1] = ((hi >>> k) | (lo << (32 - k))) >>> 0;
}
/** b = rotr(b ^ c, 63) = rotl(.., 1). */
function xr63(/** @type {Uint32Array} */ v, /** @type {number} */ b, /** @type {number} */ c) {
  const lo = (v[2 * b] ^ v[2 * c]) >>> 0, hi = (v[2 * b + 1] ^ v[2 * c + 1]) >>> 0;
  v[2 * b] = ((lo << 1) | (hi >>> 31)) >>> 0;
  v[2 * b + 1] = ((hi << 1) | (lo >>> 31)) >>> 0;
}
function gb(/** @type {Uint32Array} */ v, /** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c, /** @type {number} */ d) {
  mix(v, a, b); xr(v, d, a, 32);
  mix(v, c, d); xr(v, b, c, 24);
  mix(v, a, b); xr(v, d, a, 16);
  mix(v, c, d); xr63(v, b, c);
}
const IDX = new Uint32Array(16);
/** The permutation P over 16 words picked from a block by `idx`. @param {Uint32Array} blk @param {number[]} idx */
function perm(blk, idx, v = new Uint32Array(32)) {
  for (let i = 0; i < 16; i++) { v[2 * i] = blk[2 * idx[i]]; v[2 * i + 1] = blk[2 * idx[i] + 1]; }
  gb(v, 0, 4, 8, 12); gb(v, 1, 5, 9, 13); gb(v, 2, 6, 10, 14); gb(v, 3, 7, 11, 15);
  gb(v, 0, 5, 10, 15); gb(v, 1, 6, 11, 12); gb(v, 2, 7, 8, 13); gb(v, 3, 4, 9, 14);
  for (let i = 0; i < 16; i++) { blk[2 * idx[i]] = v[2 * i]; blk[2 * idx[i] + 1] = v[2 * i + 1]; }
}
const ROWS = Array.from({ length: 8 }, (_, r) => Array.from({ length: 16 }, (_, i) => 16 * r + i));
const COLS = Array.from({ length: 8 }, (_, c) => Array.from({ length: 16 }, (_, i) => 16 * (i >> 1) + 2 * c + (i & 1)));
void IDX;

/** next = P(prev ^ ref) ^ prev ^ ref (^ next when xor). All are 256-entry views. @param {Uint32Array} out @param {Uint32Array} x @param {Uint32Array} y @param {boolean} xor */
function fillBlock(out, x, y, xor) {
  const r = new Uint32Array(256), z = new Uint32Array(256), v = new Uint32Array(32);
  for (let i = 0; i < 256; i++) { r[i] = x[i] ^ y[i]; z[i] = r[i]; }
  for (const row of ROWS) perm(z, row, v);
  for (const col of COLS) perm(z, col, v);
  for (let i = 0; i < 256; i++) out[i] = xor ? (out[i] ^ r[i] ^ z[i]) : (r[i] ^ z[i]);
}

/** @param {Buffer} pw @param {Buffer} salt @param {number} memoryKiB @param {number} passes @param {number} tag */
function pureArgon2id(pw, salt, memoryKiB, passes, tag) {
  const p = 1, m = 4 * Math.floor(memoryKiB / 4), q = m, seg = q / 4;
  if (memoryKiB < 8 || passes < 1) throw new Error("bad argon2 parameters");
  const h0 = Buffer.from(blake2b(Buffer.concat([le32(p), le32(tag), le32(memoryKiB), le32(passes), le32(0x13), le32(2), le32(pw.length), pw, le32(salt.length), salt, le32(0), le32(0)]), 64));
  const mem = new Uint32Array(m * 256);
  const blk = (/** @type {number} */ i) => mem.subarray(i * 256, i * 256 + 256);
  for (const col of [0, 1]) {
    const bytes = hPrime(Buffer.concat([h0, le32(col), le32(0)]), 1024);
    for (let w = 0; w < 256; w++) mem[col * 256 + w] = bytes.readUInt32LE(w * 4);
  }
  const zero = new Uint32Array(256), input = new Uint32Array(256), addr = new Uint32Array(256);
  for (let pass = 0; pass < passes; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      const independent = pass === 0 && slice < 2;
      let counter = 0;
      for (let i = 0; i < seg; i++) {
        const col = slice * seg + i;
        if (pass === 0 && col < 2) continue;
        const prev = col === 0 ? q - 1 : col - 1;
        let j1, j2;
        if (independent) {
          if (i % 128 === 0 || (i === 2 && counter === 0)) {
            // the address block for this stretch of 128 indexes: G(0, G(0, input)), input = (pass, lane, slice, m, passes, type, counter)
            counter = Math.floor(i / 128) + 1;
            input.fill(0);
            input[0] = pass; input[2] = 0; input[4] = slice; input[6] = m; input[8] = passes; input[10] = 2; input[12] = counter;
            fillBlock(addr, zero, input, false);
            fillBlock(addr, zero, addr.slice(), false);
          }
          j1 = addr[2 * (i % 128)]; j2 = addr[2 * (i % 128) + 1];
        } else { const pb = blk(prev); j1 = pb[0]; j2 = pb[1]; }
        void j2;
        let area;
        if (pass === 0) area = slice === 0 ? i - 1 : slice * seg + i - 1;
        else area = q - seg + i - 1;
        // relative position = area - 1 - ((area * ((j1^2) >> 32)) >> 32)
        const x = Math.floor(j1 * j1 / 4294967296);
        const y = Math.floor(area * x / 4294967296);
        const rel = area - 1 - y;
        const start = pass === 0 ? 0 : (slice === 3 ? 0 : (slice + 1) * seg);
        const ref = (start + rel) % q;
        fillBlock(blk(col), blk(prev), blk(ref), pass > 0);
      }
    }
  }
  const last = blk(q - 1);
  const c = Buffer.alloc(1024);
  for (let w = 0; w < 256; w++) c.writeUInt32LE(last[w], w * 4);
  return hPrime(c, tag);
}
