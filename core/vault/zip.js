// @ts-check
// vault/zip: read a ZIP archive into memory, with node:zlib and nothing else.
//
// 1Password's .1pux export is a zip (ADR 0001, decision 10). The Vault takes no dependencies, so
// this reads the one shape of zip it needs: a single-disk archive, entries stored or deflated.
// The input is a file the user picked, which makes it untrusted, so the reader is strict:
//   - zip64, multi-disk and encrypted entries are refused rather than half-read;
//   - a name holding a ".." segment, a leading "/" or a drive letter is refused, so no caller can
//     be steered outside a directory by an entry name;
//   - the total size is capped twice, once from the sizes the archive declares and once from the
//     bytes inflate really produces, so a small file cannot expand into gigabytes;
//   - every entry's CRC-32 is checked.
// Errors name the entry and the problem. They never quote entry contents.

import zlib from "node:zlib";

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Read every file entry of a zip archive. Directory entries are left out.
 * @param {Uint8Array} buffer
 * @param {{ maxEntries?: number, maxBytes?: number }} [opts]
 * @returns {Map<string, Buffer>}
 */
export function unzip(buffer, { maxEntries = 10000, maxBytes = 200 * 1024 * 1024 } = {}) {
  if (!(buffer instanceof Uint8Array)) throw new Error("zip: expected the archive as bytes");
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const end = findEOCD(buf);
  const disk = buf.readUInt16LE(end + 4);
  const cdDisk = buf.readUInt16LE(end + 6);
  const onDisk = buf.readUInt16LE(end + 8);
  const total = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || (end >= 20 && buf.readUInt32LE(end - 20) === ZIP64_LOCATOR)) {
    throw new Error("zip: zip64 archives are not supported");
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new Error("zip: archives split across disks are not supported");
  if (total > maxEntries) throw new Error(`zip: ${total} entries is more than the limit of ${maxEntries}`);
  if (cdOffset + cdSize > end) throw new Error("zip: the central directory runs past the end of the archive");

  /** @type {Map<string, Buffer>} */
  const out = new Map();
  let declared = 0;
  let produced = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== CENTRAL) throw new Error(`zip: central directory entry ${n + 1} is damaged`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > cdOffset + cdSize) throw new Error(`zip: central directory entry ${n + 1} is damaged`);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;

    const label = printable(name);
    checkName(name, label);
    if (flags & 0x1) throw new Error(`zip: entry "${label}" is encrypted`);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new Error("zip: zip64 archives are not supported");
    if (out.has(name)) throw new Error(`zip: entry "${label}" appears more than once`);
    declared += usize;
    if (declared > maxBytes) throw new Error(`zip: the archive declares more than ${maxBytes} bytes`);

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new Error(`zip: entry "${label}" has no local header`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw new Error(`zip: entry "${label}" runs past the end of the archive`);
    const raw = buf.subarray(start, start + csize);

    if (name.endsWith("/")) {
      if (usize !== 0) throw new Error(`zip: directory entry "${label}" holds data`);
      continue;
    }
    /** @type {Buffer} */
    let data;
    if (method === 0) {
      if (csize !== usize) throw new Error(`zip: stored entry "${label}" has mismatched sizes`);
      data = Buffer.from(raw);
    } else if (method === 8) {
      const room = maxBytes - produced;
      try {
        // Cap the output at what the entry declares plus one byte, so a lie about the size
        // shows up here without inflating the rest.
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(usize + 1, room + 1)) });
      } catch (e) {
        if (e instanceof RangeError || /** @type {any} */ (e)?.code === "ERR_BUFFER_TOO_LARGE") {
          throw new Error(`zip: entry "${label}" inflates past its declared size or the ${maxBytes}-byte limit`);
        }
        throw new Error(`zip: entry "${label}" could not be inflated`);
      }
    } else {
      throw new Error(`zip: entry "${label}" uses compression method ${method}; only stored and deflate are supported`);
    }
    if (data.length !== usize) throw new Error(`zip: entry "${label}" does not match its declared size`);
    produced += data.length;
    if (produced > maxBytes) throw new Error(`zip: the archive inflates past ${maxBytes} bytes`);
    if (crc32(data) !== crc) throw new Error(`zip: entry "${label}" fails its CRC-32 check`);
    out.set(name, data);
  }
  return out;
}

/** Search back from the end for the end-of-central-directory record, past any comment. @param {Buffer} buf */
function findEOCD(buf) {
  if (buf.length < 22) throw new Error("zip: the file is too short to be a zip archive");
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  throw new Error("zip: no end-of-central-directory record; the file is not a zip archive or is cut short");
}

/** @param {string} name @param {string} label */
function checkName(name, label) {
  if (!name) throw new Error("zip: an entry has an empty name");
  if (name.includes("\0")) throw new Error(`zip: entry "${label}" has a NUL in its name`);
  if (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) throw new Error(`zip: entry "${label}" has an absolute path`);
  if (name.split(/[\\/]/).includes("..")) throw new Error(`zip: entry "${label}" climbs out of the archive with ".."`);
}

/** An entry name for an error: bounded and printable. @param {string} s */
const printable = s => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * CRC-32 (the zip and PNG polynomial, reflected, 0xEDB88320).
 * @param {Uint8Array} data
 * @returns {number}
 */
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
