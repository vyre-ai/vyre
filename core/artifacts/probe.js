// @ts-check
// What a media file says about itself, read from its own headers with no decoder and no dependency: the size of
// an image, and the size and length of a video or sound. Pure over a reader: `readAt(offset, length)` returns a
// Buffer (shorter at the end of the file). Everything is bounded (no read over 8 MB, no loop without a limit),
// and a field it cannot find is simply absent: this is for layout and labels, never for a decision.

/** @typedef {(offset: number, length: number) => Promise<Buffer>} ReadAt */
/** @typedef {{ width?: number, height?: number, duration_s?: number }} Probed */

const MAX_BOX = 8 * 1024 * 1024;
const sane = (/** @type {number} */ n) => Number.isFinite(n) && n > 0 && n < 100_000;

/** @param {Buffer} b */
function png(b) { return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : {}; }
/** @param {Buffer} b */
function gif(b) { return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : {}; }

/** @param {Buffer} b */
function jpeg(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return {};
}

/** @param {Buffer} b */
function webp(b) {
  if (b.length < 30) return {};
  const kind = b.subarray(12, 16).toString("latin1");
  if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
  return {};
}

/** @param {Buffer} b */
function wav(b) {
  let i = 12, rate = 0;
  for (let n = 0; n < 64 && i + 8 <= b.length; n++) {
    const id = b.subarray(i, i + 4).toString("latin1"), size = b.readUInt32LE(i + 4);
    if (id === "fmt " && i + 20 <= b.length) rate = b.readUInt32LE(i + 16);
    if (id === "data") return rate ? { duration_s: size / rate } : {};
    i += 8 + size + (size & 1);
  }
  return {};
}

/** The duration and the picture size from a moov box. @param {Buffer} moov */
function moov(moovBuf) {
  /** @type {Probed} */ const out = {};
  const walk = (/** @type {Buffer} */ b, /** @type {number} */ depth) => {
    let i = 0;
    for (let n = 0; n < 200 && i + 8 <= b.length; n++) {
      let size = b.readUInt32BE(i), start = 8;
      const type = b.subarray(i + 4, i + 8).toString("latin1");
      if (size === 1 && i + 16 <= b.length) { size = Number(b.readBigUInt64BE(i + 8)); start = 16; }
      if (size < start || i + size > b.length) break;
      const body = b.subarray(i + start, i + size);
      if (type === "mvhd" && body.length >= 20) {
        const v = body[0];
        const scale = body.readUInt32BE(v === 1 ? 20 : 12), dur = v === 1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
        if (scale > 0 && dur > 0) out.duration_s = dur / scale;
      } else if (type === "tkhd" && body.length >= 84) {
        const o = body[0] === 1 ? 88 : 76; // width and height, 16.16 fixed point, at the end of the box
        if (body.length >= o + 8) { const w = body.readUInt32BE(o) / 65536, h = body.readUInt32BE(o + 4) / 65536; if (sane(w) && sane(h) && !out.width) { out.width = Math.round(w); out.height = Math.round(h); } }
      } else if (depth < 4 && (type === "trak" || type === "mdia")) walk(body, depth + 1);
      i += size;
    }
  };
  walk(moovBuf, 0);
  return out;
}

/** @param {ReadAt} readAt @param {number} size */
async function mp4(readAt, size) {
  let pos = 0;
  for (let n = 0; n < 64 && pos + 8 <= size; n++) {
    const h = await readAt(pos, 16);
    if (h.length < 8) break;
    let len = h.readUInt32BE(0), start = 8;
    const type = h.subarray(4, 8).toString("latin1");
    if (len === 1 && h.length >= 16) { len = Number(h.readBigUInt64BE(8)); start = 16; } else if (len === 0) len = size - pos;
    if (len < start) break;
    if (type === "moov") {
      if (len - start > MAX_BOX) return {};
      const body = await readAt(pos + start, len - start);
      const tracks = moov(body);
      return tracks;
    }
    pos += len;
  }
  return {};
}

/** @param {Buffer} b */
function webm(b) {
  /** @type {Probed} */ const out = {};
  let scale = 1_000_000;
  const find = (/** @type {number[]} */ id, /** @type {number} */ from = 0) => { outer: for (let i = from; i + id.length < b.length; i++) { for (let k = 0; k < id.length; k++) if (b[i + k] !== id[k]) continue outer; return i + id.length; } return -1; };
  const size = (/** @type {number} */ at) => { const f = b[at]; let len = 1; while (len <= 8 && !(f & (0x80 >> (len - 1)))) len++; let v = f & (0xff >> len); for (let k = 1; k < len; k++) v = v * 256 + b[at + k]; return { len, v }; };
  let i = find([0x2a, 0xd7, 0xb1]);
  if (i > 0) { const s = size(i); let v = 0; for (let k = 0; k < s.v && k < 6; k++) v = v * 256 + b[i + s.len + k]; if (v > 0) scale = v; }
  i = find([0x44, 0x89]);
  if (i > 0) { const s = size(i); if (s.v === 8) out.duration_s = (b.readDoubleBE(i + s.len) * scale) / 1e9; else if (s.v === 4) out.duration_s = (b.readFloatBE(i + s.len) * scale) / 1e9; }
  const px = (/** @type {number[]} */ id) => { const j = find(id); if (j < 0) return 0; const s = size(j); let v = 0; for (let k = 0; k < s.v && k < 4; k++) v = v * 256 + b[j + s.len + k]; return v; };
  const w = px([0xb0]), h = px([0xba]);
  if (sane(w) && sane(h)) { out.width = w; out.height = h; }
  if (out.duration_s !== undefined && !(out.duration_s > 0 && out.duration_s < 86_400)) delete out.duration_s;
  return out;
}

/**
 * @param {string} format the artifact format (png, jpeg, gif, webp, mp4, webm, mp3, wav, ogg, m4a)
 * @param {number} size the file's size in bytes @param {ReadAt} readAt
 * @returns {Promise<Probed>}
 */
export async function probe(format, size, readAt) {
  try {
    /** @type {Probed} */ let r = {};
    if (format === "png") r = png(await readAt(0, 32));
    else if (format === "gif") r = gif(await readAt(0, 16));
    else if (format === "jpeg") r = jpeg(await readAt(0, 512 * 1024));
    else if (format === "webp") r = webp(await readAt(0, 64));
    else if (format === "wav") r = wav(await readAt(0, 4096));
    else if (format === "mp4" || format === "m4a") r = await mp4(readAt, size);
    else if (format === "webm") r = webm(await readAt(0, 256 * 1024));
    // mp3 and ogg: no length without scanning the whole file, so none is claimed.
    /** @type {Probed} */ const out = {};
    if (sane(/** @type {number} */ (r.width)) && sane(/** @type {number} */ (r.height))) { out.width = r.width; out.height = r.height; }
    if (typeof r.duration_s === "number" && r.duration_s > 0 && r.duration_s < 86_400) out.duration_s = Math.round(r.duration_s * 100) / 100;
    return out;
  } catch { return {}; }
}
