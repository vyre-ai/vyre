// @ts-check
// Generated media (the user's ask, 1 Oct): images, video and audio a provider made, kept as an artifact
// with its provider, prompt and session, reached through the same project permission as every other
// artifact. Pure: the formats, their media types, and a check that the bytes are what the name says. A
// file is accepted only when its first bytes match its format, so a page renamed .png is refused, and
// it is served with its own type, nosniff and a sandbox header (never as a page).

/** The most one media file may hold. */
export const MAX_MEDIA = 100 * 1024 * 1024;

/** @type {Record<string, { mime: string, kind: "image"|"video"|"audio", ext: string, magic: (b: Buffer) => boolean }>} */
export const MEDIA = {
  png: { mime: "image/png", kind: "image", ext: ".png", magic: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpeg: { mime: "image/jpeg", kind: "image", ext: ".jpg", magic: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { mime: "image/gif", kind: "image", ext: ".gif", magic: b => b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")) },
  webp: { mime: "image/webp", kind: "image", ext: ".webp", magic: b => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  mp4: { mime: "video/mp4", kind: "video", ext: ".mp4", magic: b => b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp" },
  webm: { mime: "video/webm", kind: "video", ext: ".webm", magic: b => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  mp3: { mime: "audio/mpeg", kind: "audio", ext: ".mp3", magic: b => b.length >= 3 && (b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  wav: { mime: "audio/wav", kind: "audio", ext: ".wav", magic: b => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE" },
  ogg: { mime: "audio/ogg", kind: "audio", ext: ".ogg", magic: b => b.length >= 4 && b.subarray(0, 4).toString("latin1") === "OggS" },
  m4a: { mime: "audio/mp4", kind: "audio", ext: ".m4a", magic: b => b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp" },
};

/** The format a file name says it is, or null. @param {string} name */
export function mediaFormatOf(name) {
  const e = name.toLowerCase().replace(/^.*(?=\.)/, "");
  return ({ ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp", ".mp4": "mp4", ".m4v": "mp4", ".webm": "webm", ".mp3": "mp3", ".wav": "wav", ".ogg": "ogg", ".oga": "ogg", ".m4a": "m4a" })[/** @type {string} */ (e)] || null;
}

/** Whether a format is a media format. @param {string} f */
export const isMediaFormat = f => Object.hasOwn(MEDIA, f);

/**
 * One byte range from a Range header, or null for none, or "bad" when it can't be satisfied.
 * Only a single range of bytes is served.
 * @param {string|undefined} header @param {number} size
 * @returns {{ start: number, end: number } | null | "bad"}
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start, end;
  if (m[1] === "") { const n = Number(m[2]); if (!n) return "bad"; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isFinite(start) || start >= size || end < start) return "bad";
  return { start, end };
}
