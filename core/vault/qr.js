// @ts-check
// qr: a small QR code encoder for the recovery kit (ADR 0006, decision 5). Plain JS, no library.
//
// It does one thing: bytes in, a module matrix out. Byte mode only, error correction level M
// (about 15% of the symbol can be damaged and it still reads), versions 1 to 10 (up to 213
// bytes), and the mask is picked from all eight by the standard's penalty rules. A kit payload is
// about 150 bytes, so this is all it needs. The layout follows ISO/IEC 18004: finder, separator,
// timing and alignment patterns, the format bits (BCH 15,5) in both copies, the version bits
// (BCH 18,6) from version 7, then the interleaved data and Reed-Solomon codewords in the zigzag.

/** Per version (index 1 to 10) at level M: EC codewords per block, then [blocks, data codewords]. */
const BLOCKS_M = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];

/** Alignment pattern centres per version. */
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** Level M's two format bits are 00. */
const ECL_M = 0;

/** Data codewords a version holds at level M. */
export function dataCapacity(version) {
  const [, ...groups] = /** @type {any[]} */ (BLOCKS_M[version]);
  return groups.reduce((n, [count, len]) => n + count * len, 0);
}

// ---- GF(256) and Reed-Solomon ----------------------------------------------------------------

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial of the given degree, highest coefficient (always 1) left out. */
function rsDivisor(degree) {
  const d = new Array(degree).fill(0);
  d[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      d[j] = gfMul(d[j], root);
      if (j + 1 < degree) d[j] ^= d[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return d;
}

/** The EC codewords for one block: the remainder of data * x^degree divided by the generator. */
export function rsRemainder(data, degree) {
  const div = rsDivisor(degree);
  const out = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ /** @type {number} */ (out.shift());
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] ^= gfMul(div[i], factor);
  }
  return out;
}

// ---- BCH codes for the format and version bits ----------------------------------------------

/** 15 format bits for level M and a mask, already XORed with 0x5412. */
export function formatBits(mask) {
  const data = (ECL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** 18 version bits (version 7 and up). */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

const bit = (x, i) => ((x >>> i) & 1) !== 0;

// ---- data codewords ---------------------------------------------------------------------------

/** The smallest version (1 to 10) whose level M capacity holds `n` bytes in byte mode. */
export function pickVersion(n) {
  for (let v = 1; v <= 10; v++) {
    const bits = 4 + (v < 10 ? 8 : 16) + 8 * n;
    if (bits <= dataCapacity(v) * 8) return v;
  }
  throw new Error(`${n} bytes do not fit a version 10 QR code at level M (213 bytes at most)`);
}

/** Mode, count, bytes, terminator and pad codewords, then split into blocks with EC and interleaved. */
export function codewords(bytes, version) {
  const cap = dataCapacity(version);
  /** @type {number[]} */
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ec, ...groups] = /** @type {any[]} */ (BLOCKS_M[version]);
  const blocks = [];
  let at = 0;
  for (const [count, len] of groups) for (let k = 0; k < count; k++) {
    const d = data.slice(at, at + len);
    at += len;
    blocks.push({ d, e: rsRemainder(d, ec) });
  }
  const out = [];
  const longest = Math.max(...blocks.map(b => b.d.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

// ---- the matrix -------------------------------------------------------------------------------

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Build the symbol for one version and mask. `m[y][x]`, true is dark. */
function build(version, words, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = /** @type {number[]} */ (ALIGN[version]);
  const last = al.length - 1;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(set, size, mask);
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit(vb, i));
      set(b, a, bit(vb, i));
    }
  }

  // Data in the zigzag: two-module columns from the right, up then down, skipping column 6.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const up = ((right + 1) & 2) === 0;
      const y = up ? size - 1 - vert : vert;
      if (fn[y][x]) continue;
      if (i < words.length * 8) m[y][x] = bit(words[i >>> 3], 7 - (i & 7));
      i++;
    }
  }
  const inv = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && inv(x, y)) m[y][x] = !m[y][x];
  return { m, fn };
}

function drawFormat(set, size, mask) {
  const f = formatBits(mask);
  for (let i = 0; i <= 5; i++) set(8, i, bit(f, i));
  set(8, 7, bit(f, 6));
  set(8, 8, bit(f, 7));
  set(7, 8, bit(f, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(f, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(f, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(f, i));
  set(8, size - 8, true);
}

/** The standard's penalty score for a finished symbol. Lower is easier to read. */
export function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = [];
  for (let y = 0; y < size; y++) lines.push(m[y]);
  for (let x = 0; x < size; x++) lines.push(m.map(r => r[x]));
  const finderA = [true, false, true, true, true, false, true, false, false, false, false];
  const finderB = [...finderA].reverse();
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) { run++; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    // The quiet zone counts as light, so a finder-like run at the edge is caught too.
    const padded = [false, false, false, false, ...line, false, false, false, false];
    for (let i = 0; i + 11 <= padded.length; i++) {
      if (finderA.every((v, k) => padded[i + k] === v) || finderB.every((v, k) => padded[i + k] === v)) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  let dark = 0;
  for (const r of m) for (const c of r) if (c) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * Encode text or bytes as a QR code at level M.
 * @param {string | Uint8Array} input
 * @param {{ mask?: number, version?: number }} [o] force a mask or a (larger) version, for tests
 * @returns {{ version: number, mask: number, size: number, modules: boolean[][] }}
 */
export function encode(input, { mask, version } = {}) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const min = pickVersion(bytes.length);
  const v = version ?? min;
  if (v < min || v > 10) throw new Error(`version ${v} cannot hold ${bytes.length} bytes`);
  const words = codewords(bytes, v);
  let best = null;
  for (let k = 0; k < 8; k++) {
    if (mask !== undefined && k !== mask) continue;
    const { m } = build(v, words, k);
    const p = penalty(m);
    if (!best || p < best.p) best = { m, p, k };
  }
  const b = /** @type {{ m: boolean[][], p: number, k: number }} */ (best);
  return { version: v, mask: b.k, size: b.m.length, modules: b.m };
}

/** Which modules are function patterns, for structural tests. */
export function functionMask(version) {
  return build(version, codewords(Buffer.alloc(0), version), 0).fn;
}

/**
 * The symbol as an SVG, one path, with a quiet zone of four modules. Crisp at any print size.
 * @param {boolean[][]} modules @param {{ quiet?: number, px?: number, color?: string }} [o]
 */
export function toSvg(modules, { quiet = 4, px = 6, color = "#141311" } = {}) {
  const n = modules.length + quiet * 2;
  let d = "";
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * px}" height="${n * px}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="${color}"/></svg>`;
}
