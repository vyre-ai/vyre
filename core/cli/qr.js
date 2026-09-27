// @ts-check
// qr: a QR code for a short text (a URL), drawn in the terminal. No dependency: byte mode, error
// correction level M, versions 1 to 10 (up to 213 bytes), which is all a box address needs.
// `vyre phone add` prints one so the phone's camera can open the box without typing.
//
// The steps follow ISO/IEC 18004: encode, Reed-Solomon per block, interleave, place in the
// zigzag, pick the mask with the lowest penalty (rules 1, 2 and 4; rule 3 is left out, which only
// makes the choice of mask a little less picky, never the code unreadable), then the format and
// version bits.

// Level M, versions 1 to 10: error correction codewords per block, and the number of blocks.
const ECC = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

/** Modules a version holds for data and error correction, after every function pattern. */
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = ver => Math.floor(rawModules(ver) / 8) - ECC[ver - 1] * BLOCKS[ver - 1];

/** GF(256) multiply, modulo x^8 + x^4 + x^3 + x^2 + 1. */
function mul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator polynomial of a degree, without its leading 1. */
function divisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = mul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = mul(root, 0x02);
  }
  return r;
}

function remainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ /** @type {number} */ (r.shift());
    r.push(0);
    div.forEach((d, i) => { r[i] ^= mul(d, f); });
  }
  return r;
}

/** The data codewords: mode, count, bytes, terminator and padding. */
function encode(bytes, ver) {
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Split into blocks, add each block's error correction, interleave. */
function interleave(data, ver) {
  const n = BLOCKS[ver - 1], eccLen = ECC[ver - 1];
  const raw = Math.floor(rawModules(ver) / 8);
  const short = n - (raw % n), shortLen = Math.floor(raw / n);
  const div = divisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < n; i++) {
    const d = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += d.length;
    const e = remainder(d, div);
    if (i < short) d.push(0);
    blocks.push(d.concat(e));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < n; j++) if (i !== shortLen - eccLen || j >= short) out.push(blocks[j][i]);
  }
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Rules 1, 2 and 4 of the mask penalty. */
function penalty(m) {
  const n = m.length;
  let p = 0;
  for (let a = 0; a < n; a++) {
    for (const line of [m[a], m.map(r => r[a])]) {
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && line[i] === line[i - 1]) { run++; continue; }
        if (run >= 5) p += run - 2;
        run = 1;
      }
    }
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
  }
  const dark = m.reduce((s, r) => s + r.filter(Boolean).length, 0);
  p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  return p;
}

/**
 * The QR code for a text: rows of booleans, true for a dark module, without the quiet zone.
 * @param {string} text
 * @param {{ mask?: number }} [o] mask forces one of the eight masks (for tests)
 * @returns {boolean[][]}
 */
export function qr(text, { mask } = {}) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  let ver = 1;
  while (ver <= MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > MAX_VERSION) throw new Error(`too long for a QR code here (${bytes.length} bytes)`);
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  if (ver > 1) {
    const count = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < count; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const format = mk => {
    const data = (0 << 3) | mk; // level M's bits are 00
    let r = data;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const bits = ((data << 10) | r) ^ 0x5412;
    const bit = i => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0); // reserves the format modules; drawn again once the mask is chosen
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  const words = interleave(encode(bytes, ver), ver);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
        if (!fn[y][x] && i < words.length * 8) { m[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  }

  const apply = mk => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mk](x, y)) m[y][x] = !m[y][x]; };
  let best = mask ?? 0;
  if (mask === undefined) {
    let low = Infinity;
    for (let mk = 0; mk < 8; mk++) {
      apply(mk); format(mk);
      const p = penalty(m);
      if (p < low) { low = p; best = mk; }
      apply(mk); // masking twice undoes it
    }
  }
  apply(best); format(best);
  return m;
}

/**
 * The code as terminal lines, two modules per character cell, with a quiet zone. Explicit black
 * and white, so it scans the same on a dark terminal and a light one.
 * @param {boolean[][]} m
 * @param {{ quiet?: number, indent?: string }} [o]
 * @returns {string[]}
 */
export function terminal(m, { quiet = 2, indent = "  " } = {}) {
  const n = m.length + quiet * 2;
  const dark = (x, y) => { x -= quiet; y -= quiet; return y >= 0 && y < m.length && x >= 0 && x < m.length && m[y][x]; };
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let s = indent;
    for (let x = 0; x < n; x++) {
      // The upper half block in the top module's colour, on the bottom module's colour.
      s += `\x1b[${dark(x, y) ? 30 : 97};${y + 1 < n && dark(x, y + 1) ? 40 : 107}m▀`;
    }
    lines.push(s + "\x1b[0m");
  }
  return lines;
}
