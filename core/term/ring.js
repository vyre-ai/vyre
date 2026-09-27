// @ts-check
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/server/src/terminal/terminal-restore.ts,
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: only the 256 KB output
// frame cap is taken; the byte-offset ring and the holder wire below are Vyre's own (ADR 0029 R4).
//
// ring: what a terminal printed, counted in bytes (ADR 0029 R4), and the small wire vyred and a
// terminal's holder (holder.js) speak over the holder's unix socket.
//
// Every byte a terminal prints has an offset: the first is 0, and `end` is the count so far. The
// ring keeps the last `cap` bytes, [start, end). When it has to drop some, it drops up to the byte
// after a newline when one is near, so a replay starts at the beginning of a line. since(from)
// answers "what came after the byte I last drew": exactly [from, end) while `from` is still in the
// ring, else the whole ring and cut: true.
//
// The wire is frames of [type: 1 byte][length: 4 bytes, big endian][payload]. Nothing in it is
// written anywhere but the socket.

/** Output frames are at most this big, so one huge replay does not become one huge frame. */
export const MAX_FRAME = 256 * 1024;

/** How far past the bytes it must drop the ring looks for a newline to cut after. */
const LINE_WINDOW = 64 * 1024;

export class Ring {
  /** @param {number} cap bytes kept */
  constructor(cap) {
    this.cap = Math.max(1024, Math.floor(Number(cap) || 1024 * 1024));
    /** @type {Buffer[]} */ this.chunks = [];
    this.bytes = 0;
    /** The offset one past the last byte printed. */
    this.end = 0;
  }

  /** The offset of the oldest byte still kept. */
  get start() { return this.end - this.bytes; }

  /** @param {Buffer} b */
  push(b) {
    if (!b.length) return;
    this.chunks.push(b);
    this.bytes += b.length;
    this.end += b.length;
    if (this.bytes > this.cap) this.trim(this.bytes - this.cap);
  }

  /** Drop at least `need` bytes from the front, up to just after a newline if one is within reach. */
  trim(need) {
    let cut = need;
    // Look for a newline at or after `need` (relative to the ring's start), within LINE_WINDOW.
    let pos = 0;
    for (const c of this.chunks) {
      if (pos + c.length <= need) { pos += c.length; continue; }
      const from = Math.max(0, need - pos);
      const to = Math.min(c.length, need + LINE_WINDOW - pos);
      const i = c.subarray(from, to).indexOf(10);
      if (i >= 0) { cut = pos + from + i + 1; break; }
      pos += c.length;
      if (pos >= need + LINE_WINDOW) break;
    }
    // Never drop everything: keep at least the newest byte.
    cut = Math.min(cut, this.bytes - 1);
    let left = cut;
    while (left > 0 && this.chunks.length) {
      const c = this.chunks[0];
      if (c.length <= left) { this.chunks.shift(); left -= c.length; this.bytes -= c.length; }
      else { this.chunks[0] = c.subarray(left); this.bytes -= left; left = 0; }
    }
  }

  /**
   * The bytes after `from`. A missing or out-of-range offset gets the whole ring; cut says the
   * caller asked for (or, with no offset, would have seen) bytes the ring no longer has.
   * @param {number|null|undefined} from
   * @returns {{ from: number, cut: boolean, bytes: Buffer }}
   */
  since(from) {
    const all = () => Buffer.concat(this.chunks, this.bytes);
    const n = from == null ? NaN : Number(from);
    if (!Number.isInteger(n) || n < 0) return { from: this.start, cut: this.start > 0, bytes: all() };
    if (n < this.start || n > this.end) return { from: this.start, cut: true, bytes: all() };
    return { from: n, cut: false, bytes: all().subarray(n - this.start) };
  }
}

/** Frame types on the holder socket. */
export const T = {
  HELLO: 0x48,   // H  client: {mode: "attach"|"control", from?}
  AT: 0x41,      // A  holder: {from, cut, end, cols, rows}, the first frame of an attach
  OUT: 0x4f,     // O  holder: terminal output bytes
  IN: 0x49,      // I  client: keys
  SIZE: 0x53,    // S  client: {cols, rows}
  CLOSE: 0x43,   // C  client (control): end the terminal
  QUERY: 0x51,   // Q  client (control): ask for INFO
  INFO: 0x4e,    // N  holder: {id, pid, cols, rows, end, start, attached, until}
  EXIT: 0x58,    // X  holder: {reason}, then the holder goes away
};

/** @param {number} type @param {Buffer|string|object} payload */
export function frame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Output bytes as OUT frames of at most MAX_FRAME each. @param {Buffer} b @returns {Buffer[]} */
export function outFrames(b) {
  const out = [];
  for (let i = 0; i < b.length; i += MAX_FRAME) out.push(frame(T.OUT, b.subarray(i, i + MAX_FRAME)));
  return out;
}

/** Splits a byte stream back into frames. Anything over 4 MB in one frame is a broken peer. */
export class Reader {
  constructor() { this.buf = Buffer.alloc(0); }
  /** @param {Buffer} chunk @returns {{ type: number, body: Buffer }[]} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (len > 4 * 1024 * 1024) throw new Error("frame too large");
      if (this.buf.length < 5 + len) break;
      out.push({ type: this.buf[0], body: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

/** A frame body as JSON, or null. @param {Buffer} b */
export function json(b) {
  try { return JSON.parse(b.toString("utf8")); } catch { return null; }
}
