// @ts-check
// lib/thumb: a small preview of an image, with no image library (the box ships none). A PNG is decoded, averaged down and written again; any other image that is already small is its own
// preview; a larger JPEG, GIF or WebP has none here (null), and the caller sends the file itself, which the attachment limits keep under 5 MB. Pure: bytes in, bytes out.
import zlib from "node:zlib";

/** The longest side a preview has. */
export const THUMB_SIDE = 256;
/** An image this small is its own preview. */
export const SMALL_BYTES = 48 * 1024;
/** A PNG this many pixels or more is not decoded (the memory a decode takes). */
const MAX_PIXELS = 40_000_000;
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc = (/** @type {Buffer} */ b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};

/** Write RGBA pixels as a PNG. @param {number} w @param {number} h @param {Uint8Array} rgba */
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Read a PNG (8 bits a channel, not interlaced; grey, grey+alpha, RGB, RGBA and palette) into RGBA, or null when it is anything else. @param {Uint8Array} bytes */
export function decodePng(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 33 || !b.subarray(0, 8).equals(SIG)) return null;
  let w = 0, h = 0, depth = 0, type = -1, inter = 0, plte = null, trns = null;
  /** @type {Buffer[]} */ const idat = [];
  for (let at = 8; at + 12 <= b.length;) {
    const len = b.readUInt32BE(at), kind = b.toString("latin1", at + 4, at + 8), body = b.subarray(at + 8, at + 8 + len);
    if (body.length < len) return null;
    if (kind === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; inter = body[12]; }
    else if (kind === "PLTE") plte = body;
    else if (kind === "tRNS") trns = body;
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    at += 12 + len;
  }
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[/** @type {0|2|3|4|6} */ (type)];
  if (!w || !h || depth !== 8 || inter !== 0 || !chans || w * h > MAX_PIXELS || (type === 3 && !plte)) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * chans;
  if (raw.length < (stride + 1) * h) return null;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= chans ? px[dst + x - chans] : 0, up = y ? px[dst - stride + x] : 0, ul = y && x >= chans ? px[dst - stride + x - chans] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul; }
      else if (f !== 0) return null;
      px[dst + x] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (type === 6) { out[o] = px[i * 4]; out[o + 1] = px[i * 4 + 1]; out[o + 2] = px[i * 4 + 2]; out[o + 3] = px[i * 4 + 3]; }
    else if (type === 2) { out[o] = px[i * 3]; out[o + 1] = px[i * 3 + 1]; out[o + 2] = px[i * 3 + 2]; out[o + 3] = 255; }
    else if (type === 0) { out[o] = out[o + 1] = out[o + 2] = px[i]; out[o + 3] = 255; }
    else if (type === 4) { out[o] = out[o + 1] = out[o + 2] = px[i * 2]; out[o + 3] = px[i * 2 + 1]; }
    else { const p = px[i], pl = /** @type {Buffer} */ (plte); out[o] = pl[p * 3] ?? 0; out[o + 1] = pl[p * 3 + 1] ?? 0; out[o + 2] = pl[p * 3 + 2] ?? 0; out[o + 3] = trns && p < trns.length ? trns[p] : 255; }
  }
  return { w, h, rgba: out };
}

/** Average an RGBA image down so its longest side is `side`, never up. @param {{ w: number, h: number, rgba: Uint8Array }} img @param {number} side */
export function shrink(img, side) {
  const k = Math.max(img.w, img.h) / side;
  if (k <= 1) return img;
  const w = Math.max(1, Math.round(img.w / k)), h = Math.max(1, Math.round(img.h / k)), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * img.h / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * img.h / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * img.w / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * img.w / w));
      let r = 0, g = 0, bl = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * img.w + xx) * 4, al = img.rgba[i + 3]; r += img.rgba[i] * al; g += img.rgba[i + 1] * al; bl += img.rgba[i + 2] * al; a += al; n++; }
      const o = (y * w + x) * 4;
      if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(bl / a); }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { w, h, rgba: out };
}

/**
 * A preview of an image file: { mime, bytes } (a PNG for a PNG; the file itself when it is small), or null when this build cannot make one.
 * @param {Uint8Array} bytes @param {string} mime
 * @returns {{ mime: string, bytes: Uint8Array } | null}
 */
export function thumbOf(bytes, mime) {
  if (mime === "image/png") {
    const img = decodePng(bytes);
    if (img) return { mime, bytes: Math.max(img.w, img.h) <= THUMB_SIDE && bytes.length <= SMALL_BYTES ? bytes : new Uint8Array(encodePng(...(/** @type {[number, number, Uint8Array]} */ ((s => [s.w, s.h, s.rgba])(shrink(img, THUMB_SIDE)))))) };
  }
  return bytes.length <= SMALL_BYTES && /^image\/(png|jpeg|gif|webp)$/.test(mime) ? { mime, bytes } : null;
}
