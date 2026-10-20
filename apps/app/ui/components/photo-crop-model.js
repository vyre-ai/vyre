// @ts-check
// The profile photo crop (PhotoCropSheet.tsx), pure: the picture fills a square stage under a circular mask, the person drags it and zooms it, and the part inside the circle's square is what is kept.
// Everything here is in numbers, so the crop is the same on the web, iOS and Android, and a test checks it: the kept part is square, inside the picture, and the saved photo is at most 512 pixels and
// 200 KB, with no EXIF, location or other notes in it.

/** The saved photo's side, in pixels. */
export const PHOTO_SIDE = 512;
/** The most a saved photo may weigh (the box refuses more: kernel/gateway/ownership.js). */
export const PHOTO_MAX_BYTES = 200 * 1024;
/** How far in a person can zoom: four times the picture filling the circle. */
export const ZOOM_MAX = 4;
/** The qualities a photo is encoded at, best first: the first that fits under PHOTO_MAX_BYTES is kept. */
export const QUALITIES = Object.freeze([0.82, 0.7, 0.58, 0.46, 0.34]);

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));

/** @typedef {{ w: number, h: number, stage: number, zoom: number, x: number, y: number }} View the picture's size, the stage's side, the zoom (1: the short side fills it) and how far it is moved from the centre */

/** The scale that makes the picture's short side fill the stage. @param {number} w @param {number} h @param {number} stage */
export const coverScale = (w, h, stage) => stage / Math.max(1, Math.min(w, h));

/**
 * The view kept inside its bounds: the zoom between 1 and ZOOM_MAX, and the picture moved no further than keeps the whole circle covered.
 * @param {View} v @returns {View}
 */
export function clampView(v) {
  const zoom = clamp(v.zoom, 1, ZOOM_MAX);
  const s = coverScale(v.w, v.h, v.stage) * zoom;
  const mx = Math.max(0, (v.w * s - v.stage) / 2), my = Math.max(0, (v.h * s - v.stage) / 2);
  return { ...v, zoom, x: clamp(v.x, -mx, mx), y: clamp(v.y, -my, my) };
}

/** Where the picture is drawn on the stage: its size and top left corner. @param {View} view */
export function placement(view) {
  const v = clampView(view);
  const s = coverScale(v.w, v.h, v.stage) * v.zoom;
  return { width: v.w * s, height: v.h * s, left: v.stage / 2 + v.x - (v.w * s) / 2, top: v.stage / 2 + v.y - (v.h * s) / 2 };
}

/**
 * The part of the picture inside the circle's square, in the picture's own pixels: always square and always inside the picture.
 * @param {View} view @returns {{ originX: number, originY: number, width: number, height: number }}
 */
export function cropRect(view) {
  const v = clampView(view);
  const s = coverScale(v.w, v.h, v.stage) * v.zoom;
  const side = Math.max(1, Math.min(Math.floor(v.w), Math.floor(v.h), Math.round(v.stage / s)));
  const p = placement(v);
  const originX = clamp(Math.round(-p.left / s), 0, Math.floor(v.w) - side);
  const originY = clamp(Math.round(-p.top / s), 0, Math.floor(v.h) - side);
  return { originX, originY, width: side, height: side };
}

/** The saved photo's side: PHOTO_SIDE, or the kept part's own side when it is smaller (a small picture is not blown up). @param {{ width: number }} crop */
export const outputSide = (crop) => Math.max(1, Math.min(PHOTO_SIDE, Math.round(crop.width)));

/** The bytes a base64 text holds. @param {string} b64 */
export function base64Bytes(b64) {
  const t = String(b64 || "").replace(/\s+/g, "");
  return Math.max(0, Math.floor((t.length * 3) / 4) - (t.endsWith("==") ? 2 : t.endsWith("=") ? 1 : 0));
}

/** The next quality to try after one that came out too heavy, or null when the last one did. @param {number} q */
export function nextQuality(q) {
  const i = QUALITIES.indexOf(q);
  return i >= 0 && i < QUALITIES.length - 1 ? QUALITIES[i + 1] : null;
}

/** What kind of picture these bytes are, from their first bytes, or "". @param {Uint8Array} b */
export function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && tag(b, 0) === "RIFF" && tag(b, 8) === "WEBP") return "image/webp";
  return "";
}

const tag = (/** @type {Uint8Array} */ b, /** @type {number} */ at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u32le = (/** @type {Uint8Array} */ b, /** @type {number} */ at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u32be = (/** @type {Uint8Array} */ b, /** @type {number} */ at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const join = (/** @type {Uint8Array[]} */ parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/**
 * The picture with its notes taken out: EXIF (where the camera writes the place and the time), XMP and comments. The encoder writes none already (it draws the pixels again); this makes sure, on
 * every platform. JPEG keeps its APP0 header and drops APP1 to APP15 and comments; PNG drops eXIf and its text chunks; WebP drops EXIF and XMP and says so in its header. Anything else, or bytes
 * it cannot follow, comes back unchanged.
 * @param {Uint8Array} b @returns {Uint8Array}
 */
export function stripMeta(b) {
  const kind = sniff(b);
  if (kind === "image/jpeg") {
    /** @type {Uint8Array[]} */ const parts = [b.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff) {
      const m = b[i + 1];
      if (m === 0xda) { parts.push(b.subarray(i)); return join(parts); } // start of scan: the rest is the picture
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2 || i + 2 + len > b.length) return b;
      if (!((m >= 0xe1 && m <= 0xef) || m === 0xfe)) parts.push(b.subarray(i, i + 2 + len));
      i += 2 + len;
    }
    return b;
  }
  if (kind === "image/png") {
    /** @type {Uint8Array[]} */ const parts = [b.subarray(0, 8)];
    let i = 8;
    while (i + 12 <= b.length) {
      const len = u32be(b, i), t = tag(b, i + 4), end = i + 12 + len;
      if (end > b.length) return b;
      if (!["eXIf", "tEXt", "iTXt", "zTXt", "tIME"].includes(t)) parts.push(b.subarray(i, end));
      i = end;
      if (t === "IEND") return join(parts);
    }
    return b;
  }
  if (kind === "image/webp") {
    /** @type {Uint8Array[]} */ const chunks = [];
    let i = 12;
    while (i + 8 <= b.length) {
      const len = u32le(b, i + 4), t = tag(b, i), end = i + 8 + len + (len & 1);
      if (i + 8 + len > b.length) return b;
      if (t !== "EXIF" && t !== "XMP ") {
        const c = b.slice(i, Math.min(end, b.length));
        if (t === "VP8X" && c.length > 8) c[8] &= ~0x0c; // the header's EXIF and XMP flags
        chunks.push(c);
      }
      i = end;
    }
    const body = join(chunks), size = body.length + 4, head = new Uint8Array(12);
    head.set(b.subarray(0, 4), 0); head[4] = size & 0xff; head[5] = (size >> 8) & 0xff; head[6] = (size >> 16) & 0xff; head[7] = (size >>> 24) & 0xff; head.set(b.subarray(8, 12), 8);
    return join([head, body]);
  }
  return b;
}
