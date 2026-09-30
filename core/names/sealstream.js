// @ts-check
// sealstream: a passphrase-sealed container that is written and read as a stream, so an export of a
// whole box (state plus every project file) never sits in memory or in the clear on disk, and an
// interrupted export can pick up where it stopped.
//
// Shape (v2; seal.js is still the v1 whole-buffer format, which restore keeps reading):
//   "vyre-box-backup:v2:" + one JSON line (kdf, salt, chunk size, time) + "\n"
//   then records: seg (1 byte), flags (1 byte, bit 0 = last chunk of its segment), length (4 bytes,
//   big endian), a fresh random 12-byte nonce, then `length` bytes of AES-256-GCM ciphertext with its
//   16-byte tag.
//   A segment is one logical stream (the manifest, the state, one project folder). The file ends with
//   an end record (seg 255, last), so a file cut short anywhere is refused rather than half-restored.
// Every record gets its own random nonce, so a resume or a rewind (which write a record at a position
// that may already have held another) can never encrypt two plaintexts under one nonce. The record's
// position is in the additional data with the sha256 of the header line, the segment and the flags, so
// a record moved, dropped or repeated fails its tag, and so does a header edited to change the key cost
// or the chunk size. Every chunk except a
// segment's last is exactly `chunk` bytes long, which is what lets a resume skip whole chunks.

import crypto from "node:crypto";
import fs from "node:fs";
import { checkPassphrase } from "./seal.js";

export const MAGIC2 = "vyre-box-backup:v2:";
export const CHUNK = 1 << 20;
export const END_SEG = 255;
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const TAG = 16;
const MAX_HEADER = 4096;
const NONCE = 12;
const RECORD_HEAD = 6 + NONCE;
/** No chunk size above this is believed: a reader allocates one chunk at a time. */
export const MAX_CHUNK = 16 << 20;

/** @param {string} passphrase @param {Buffer} salt @param {{N:number,r:number,p:number}} c */
function derive(passphrase, salt, { N, r, p }) {
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0) throw new Error("this backup names a scrypt cost that is not allowed");
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) throw new Error("this backup names a scrypt cost that is not allowed");
  return crypto.scryptSync(String(passphrase).normalize("NFKC"), salt, 32, { N, r, p, maxmem: 256 * N * r + 64 * 1024 * 1024 });
}

const aadOf = (headHash, seg, flags, counter) => { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter)); return Buffer.concat([headHash, Buffer.from([seg, flags]), c]); };

/** Is this the start of a v2 file? @param {Buffer} buf */
export const isStream = buf => Buffer.isBuffer(buf) && buf.subarray(0, MAGIC2.length).equals(Buffer.from(MAGIC2));

/** The header of a v2 file, without the passphrase. @param {Buffer} buf at least the file's first 4 KB */
export function inspectStream(buf) {
  if (!isStream(buf)) throw new Error("not a sealed vyre backup");
  const nl = buf.indexOf(0x0a, MAGIC2.length);
  if (nl === -1 || nl > MAX_HEADER) throw new Error("not a sealed vyre backup");
  let header;
  try { header = JSON.parse(buf.subarray(MAGIC2.length, nl).toString("utf8")); } catch { throw new Error("not a sealed vyre backup"); }
  if (!header || header.v !== 2 || header.kdf !== "scrypt" || !header.salt || !Number.isInteger(header.chunk) || header.chunk < 1 || header.chunk > MAX_CHUNK) throw new Error("not a sealed vyre backup");
  return { header, line: buf.subarray(MAGIC2.length, nl), bodyStart: nl + 1 };
}

/**
 * Append sealed records to a file. Start a new one, or continue a partial one from `resumeAt`.
 * Async only where a stream is read; the file writes are sync appends of whole records.
 */
export class SealWriter {
  /** @param {number} fd @param {Buffer} key @param {Buffer} headHash @param {number} counter @param {number} chunk @param {number} pos where the next record goes */
  constructor(fd, key, headHash, counter, chunk, pos) {
    this.pos = pos; this.fd = fd; this.key = key; this.headHash = headHash; this.counter = counter; this.chunk = chunk;
  }

  /** A new file: writes the header. @param {string} file @param {string} passphrase @param {{ params?: {N:number,r:number,p:number}, chunk?: number }} [o] */
  static create(file, passphrase, { params = SCRYPT, chunk = CHUNK } = {}) {
    checkPassphrase(passphrase);
    const salt = crypto.randomBytes(16);
    const line = Buffer.from(JSON.stringify({ v: 2, kdf: "scrypt", N: params.N, r: params.r, p: params.p, chunk, at: Date.now(), salt: salt.toString("base64") }));
    const fd = fs.openSync(file, "wx", 0o600);
    const head = Buffer.concat([Buffer.from(MAGIC2), line, Buffer.from("\n")]);
    fs.writeSync(fd, head, 0, head.length, 0);
    return new SealWriter(fd, derive(passphrase, salt, params), crypto.createHash("sha256").update(line).digest(), 0, chunk, head.length);
  }

  /** Continue a partial file after `scanned` (see scanPartial): truncates the torn tail. */
  static resume(file, passphrase, scanned) {
    // Never through a link: the partial file must be a regular file we can open in place.
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    fs.ftruncateSync(fd, scanned.end);
    const { header, line } = inspectStream(fs.readFileSync(file).subarray(0, MAX_HEADER + MAGIC2.length));
    return new SealWriter(fd, derive(passphrase, Buffer.from(header.salt, "base64"), header), crypto.createHash("sha256").update(line).digest(), scanned.records, header.chunk, scanned.end);
  }

  /** Cut the file back to an earlier whole-record point (a project segment started again). @param {{ end: number, records: number }} at */
  rewind(at) { fs.ftruncateSync(this.fd, at.end); this.counter = at.records; this.pos = at.end; }

  /** @param {number} seg @param {boolean} last @param {Buffer} plain */
  record(seg, last, plain) {
    const flags = last ? 1 : 0;
    const nonce = crypto.randomBytes(NONCE);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(aadOf(this.headHash, seg, flags, this.counter));
    const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const head = Buffer.alloc(6); head[0] = seg; head[1] = flags; head.writeUInt32BE(ct.length, 2);
    const rec = Buffer.concat([head, nonce, ct]);
    fs.writeSync(this.fd, rec, 0, rec.length, this.pos);
    this.pos += rec.length;
    this.counter++;
  }

  /**
   * Write one segment from a byte stream, in chunks. `skipBytes` are read and dropped first (a
   * resume: they are already in the file). Returns the segment's plaintext size and sha256 of the
   * bytes it wrote. @param {number} seg @param {AsyncIterable<Buffer>} source
   * @param {{ skipBytes?: number, onBytes?: (n: number) => void }} [o]
   */
  async segment(seg, source, { skipBytes = 0, onBytes } = {}) {
    if (seg >= END_SEG) throw new Error("bad segment");
    let skip = skipBytes, total = skipBytes;
    const hash = crypto.createHash("sha256");
    /** @type {Buffer[]} */ let parts = [];
    let have = 0;
    /** @type {Buffer|null} */ let pending = null;
    const flush = last => { if (pending) { this.record(seg, last, pending); pending = null; } };
    // Parts gather in a list and are joined once per chunk, so a stream of small pieces costs no more
    // than one copy of each byte.
    const take = n => {
      const out = Buffer.allocUnsafe(n);
      let at = 0;
      while (at < n) {
        const p0 = parts[0], need = n - at;
        if (p0.length <= need) { p0.copy(out, at); at += p0.length; parts.shift(); }
        else { p0.copy(out, at, 0, need); parts[0] = p0.subarray(need); at += need; }
      }
      have -= n;
      return out;
    };
    for await (let part of source) {
      if (skip > 0) { const cut = Math.min(skip, part.length); skip -= cut; part = part.subarray(cut); if (!part.length) continue; }
      parts.push(part); have += part.length;
      while (have > this.chunk) {
        flush(false);
        pending = take(this.chunk);
        total += pending.length; hash.update(pending); onBytes?.(pending.length);
      }
    }
    const held = have ? take(have) : Buffer.alloc(0);
    if (skip > 0) throw new Error("the stream ended before the part already written");
    flush(false);
    // What is left (possibly a full chunk, possibly nothing) is the last record of the segment.
    total += held.length; hash.update(held); onBytes?.(held.length);
    this.record(seg, true, held);
    return { bytes: total, sha256: hash.digest("hex") };
  }

  /** The end record: without it a reader refuses the file. */
  end() { this.record(END_SEG, true, Buffer.alloc(0)); this.close(); }
  close() { try { fs.closeSync(this.fd); } catch { /* closed */ } }
}

/**
 * Read a v2 file record by record. Yields { seg, last, plain }. Throws the one plain error for a wrong
 * passphrase or any damage, and a different one for a file that stops early.
 * @param {string} file @param {string} passphrase
 */
export function* readRecords(file, passphrase) {
  const fd = fs.openSync(file, "r");
  try {
    const first = Buffer.alloc(MAX_HEADER + MAGIC2.length);
    const n = fs.readSync(fd, first, 0, first.length, 0);
    const { header, line, bodyStart } = inspectStream(first.subarray(0, n));
    let key;
    try { key = derive(passphrase, Buffer.from(header.salt, "base64"), header); } catch (e) { if (/not allowed/.test(String(/** @type {Error} */ (e).message))) throw e; throw new Error("that passphrase does not open this backup"); }
    const headHash = crypto.createHash("sha256").update(line).digest();
    const size = fs.fstatSync(fd).size;
    let pos = bodyStart, counter = 0, ended = false;
    const head = Buffer.alloc(RECORD_HEAD);
    while (pos < size) {
      if (size - pos < RECORD_HEAD || fs.readSync(fd, head, 0, RECORD_HEAD, pos) < RECORD_HEAD) throw new Error("this backup file is cut short");
      const seg = head[0], flags = head[1], len = head.readUInt32BE(2);
      if (len < TAG || len > header.chunk + TAG) throw new Error("that passphrase does not open this backup");
      if (size - pos - RECORD_HEAD < len) throw new Error("this backup file is cut short");
      const ct = Buffer.alloc(len);
      fs.readSync(fd, ct, 0, len, pos + RECORD_HEAD);
      let plain;
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", key, head.subarray(6, RECORD_HEAD));
        d.setAAD(aadOf(headHash, seg, flags, counter));
        d.setAuthTag(ct.subarray(len - TAG));
        plain = Buffer.concat([d.update(ct.subarray(0, len - TAG)), d.final()]);
      } catch { throw new Error("that passphrase does not open this backup"); }
      pos += RECORD_HEAD + len; counter++;
      if (seg === END_SEG) { ended = true; if (pos !== size) throw new Error("that passphrase does not open this backup"); break; }
      yield { seg, last: (flags & 1) === 1, plain };
    }
    if (!ended) throw new Error("this backup file is cut short");
  } finally { fs.closeSync(fd); }
}

/**
 * What an unfinished file already holds, for a resume: the byte offset after its last whole, valid
 * record, how many records that is, each finished segment's size, and the size and sha256 of the
 * segment that was in progress. Returns null when it cannot be opened with this passphrase.
 * @param {string} file @param {string} passphrase
 */
export function scanPartial(file, passphrase) {
  const fd = fs.openSync(file, "r");
  try {
    const first = Buffer.alloc(MAX_HEADER + MAGIC2.length);
    const n = fs.readSync(fd, first, 0, first.length, 0);
    let parsed;
    try { parsed = inspectStream(first.subarray(0, n)); } catch { return null; }
    const { header, line, bodyStart } = parsed;
    let key;
    try { key = derive(passphrase, Buffer.from(header.salt, "base64"), header); } catch { return null; }
    const headHash = crypto.createHash("sha256").update(line).digest();
    const size = fs.fstatSync(fd).size;
    let pos = bodyStart, counter = 0;
    /** @type {Record<number, {bytes:number, done:boolean}>} */ const segs = {};
    let openSeg = -1, openHash = crypto.createHash("sha256");
    let end = bodyStart, openAt = { records: 0, end: bodyStart };
    const head = Buffer.alloc(RECORD_HEAD);
    while (size - pos >= RECORD_HEAD) {
      fs.readSync(fd, head, 0, RECORD_HEAD, pos);
      const seg = head[0], flags = head[1], len = head.readUInt32BE(2);
      if (len < TAG || len > header.chunk + TAG || size - pos - RECORD_HEAD < len) break;
      const ct = Buffer.alloc(len);
      fs.readSync(fd, ct, 0, len, pos + RECORD_HEAD);
      let plain;
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", key, head.subarray(6, RECORD_HEAD));
        d.setAAD(aadOf(headHash, seg, flags, counter));
        d.setAuthTag(ct.subarray(len - TAG));
        plain = Buffer.concat([d.update(ct.subarray(0, len - TAG)), d.final()]);
      } catch { if (counter === 0) return null; break; }
      if (seg === END_SEG) return { header, records: counter, end: pos, segments: segs, open: null, complete: true, openAt };
      const s = segs[seg] || (segs[seg] = { bytes: 0, done: false });
      if (openSeg !== seg) { openSeg = seg; openHash = crypto.createHash("sha256"); }
      s.bytes += plain.length; openHash.update(plain);
      pos += RECORD_HEAD + len; counter++; end = pos;
      if ((flags & 1) === 1) { s.done = true; openSeg = -1; openAt = { records: counter, end: pos }; }
    }
    const open = openSeg >= 0 ? { seg: openSeg, bytes: segs[openSeg].bytes, sha256: openHash.digest("hex") } : null;
    return { header, records: counter, end, segments: segs, open, openAt };
  } finally { fs.closeSync(fd); }
}
