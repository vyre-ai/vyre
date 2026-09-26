// @ts-check
// rfb: the parts of RFB 3.8 (RFC 6143) that Glass needs, and nothing that draws a pixel.
//
// Glass stands between noVNC in the browser and Xvnc in the agent's container (ADR 0003). To the
// container it is a VNC client that knows the password; to the browser it is a VNC server that
// asks for none, because the browser never holds the container's password. After both
// handshakes, server-to-client bytes pass through untouched and only the client-to-server stream
// is read, message by message, so input from a viewer without the keyboard can be dropped.
//
// Why a parser at all: RFB has no framing, so the only way to find where a KeyEvent starts is to
// know the length of every message before it. A message type we do not know means we have lost
// our place in the stream, and a stream we cannot follow is one we cannot gate. So an unknown
// type is an error, never a pass-through.

import crypto from "node:crypto";

export const VERSION = "RFB 003.008\n";

/** Client-to-server message types that are someone's hands on the agent's screen. */
export const INPUT = new Set([
  4,   // KeyEvent
  5,   // PointerEvent (moves too: a moved cursor changes what the agent's next click hovers)
  6,   // ClientCutText (pasting is typing)
  250, // xvp: shutdown and reboot of the far end
  251, // SetDesktopSize: resizing the agent's screen under it
  255, // QEMU extended key event: a KeyEvent with a scancode
]);

/**
 * noVNC's ExtendedMouseButtons pseudo-encoding. Once a server confirms it, noVNC may send a
 * seven-byte PointerEvent whose length only the server-to-client stream can tell us. Glass does
 * not parse that stream, so it strips this encoding from SetEncodings and every PointerEvent
 * stays six bytes.
 */
export const EXTENDED_MOUSE_BUTTONS = -316;

export const NAMES = /** @type {Record<number, string>} */ ({
  0: "SetPixelFormat", 2: "SetEncodings", 3: "FramebufferUpdateRequest", 4: "KeyEvent", 5: "PointerEvent",
  6: "ClientCutText", 150: "EnableContinuousUpdates", 248: "ClientFence", 250: "xvp", 251: "SetDesktopSize",
  255: "QEMUClientMessage",
});

// ---- DES, for VNC authentication ----------------------------------------------------------
//
// VNC authentication encrypts a 16-byte challenge with single DES, keyed by the password. The
// OpenSSL 3 inside current Node keeps DES in its legacy provider, which is off by default, so
// createCipheriv("des-ecb") throws. This is DES from the FIPS 46-3 tables, written for clarity
// over speed: it runs twice per Glass connection.

const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

/** @param {Uint8Array} bytes @returns {number[]} one entry per bit, most significant first */
const bitsOf = bytes => { const out = []; for (const b of bytes) for (let i = 7; i >= 0; i--) out.push((b >> i) & 1); return out; };
/** @param {number[]} bits */
const bytesOf = bits => { const out = Buffer.alloc(bits.length / 8); for (let i = 0; i < bits.length; i++) out[i >> 3] |= bits[i] << (7 - (i & 7)); return out; };
/** @param {number[]} bits @param {number[]} table 1-based positions */
const permute = (bits, table) => table.map(p => bits[p - 1]);
/** @param {number[]} half @param {number} n */
const rotate = (half, n) => half.slice(n).concat(half.slice(0, n));

/**
 * Encrypt one 8-byte block with single DES. Pure JS, because OpenSSL 3 hides DES.
 * @param {Uint8Array} key 8 bytes (parity bits ignored, as DES does)
 * @param {Uint8Array} block 8 bytes
 * @returns {Buffer}
 */
export function desEncryptBlock(key, block) {
  if (key.length !== 8 || block.length !== 8) throw new Error("DES works on 8-byte keys and blocks");
  const k = permute(bitsOf(key), PC1);
  let c = k.slice(0, 28), d = k.slice(28);
  const subkeys = [];
  for (const s of SHIFTS) { c = rotate(c, s); d = rotate(d, s); subkeys.push(permute(c.concat(d), PC2)); }
  const x = permute(bitsOf(block), IP);
  let l = x.slice(0, 32), r = x.slice(32);
  for (const sk of subkeys) {
    const e = permute(r, E).map((b, i) => b ^ sk[i]);
    const f = [];
    for (let i = 0; i < 8; i++) {
      const six = e.slice(i * 6, i * 6 + 6);
      const v = S[i][((six[0] << 1) | six[5]) * 16 + ((six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4])];
      f.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
    }
    const next = permute(f, P).map((b, i) => b ^ l[i]);
    l = r; r = next;
  }
  return bytesOf(permute(r.concat(l), FP));
}

/** Whether this Node's OpenSSL still has DES; asked once. */
let nativeDes = /** @type {boolean|null} */ (null);

/** @param {Uint8Array} key @param {Uint8Array} data a multiple of 8 bytes */
function desEcb(key, data) {
  if (nativeDes !== false) {
    try {
      const c = crypto.createCipheriv("des-ecb", key, null);
      c.setAutoPadding(false);
      const out = Buffer.concat([c.update(data), c.final()]);
      nativeDes = true;
      return out;
    } catch { nativeDes = false; }
  }
  const out = [];
  for (let i = 0; i < data.length; i += 8) out.push(desEncryptBlock(key, data.subarray(i, i + 8)));
  return Buffer.concat(out);
}

/** Reverse the bits of one byte. VNC's DES key quirk: every password byte goes in mirrored. */
export const reverseBits = (/** @type {number} */ b) => {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
  return r;
};

/**
 * The answer to a VNC authentication challenge: the 16 bytes DES-encrypted with the first eight
 * bytes of the password (zero padded), each key byte bit-reversed.
 * @param {Uint8Array} challenge 16 bytes
 * @param {string} password
 */
export function vncResponse(challenge, password) {
  if (challenge.length !== 16) throw new Error("a VNC challenge is 16 bytes");
  const key = Buffer.alloc(8);
  Buffer.from(String(password), "latin1").subarray(0, 8).forEach((b, i) => { key[i] = reverseBits(b); });
  return desEcb(key, challenge);
}

// ---- reading exact byte counts from a stream ----------------------------------------------

/**
 * A byte queue fed by whatever carries the stream (a TCP socket, a WebSocket's binary messages)
 * that hands out exactly n bytes at a time. The handshakes are sequential reads; after them,
 * rest() returns whatever arrived early, so no byte is lost at the hand-off to the relay.
 */
export class Bytes {
  constructor() {
    /** @type {Buffer[]} */
    this.chunks = [];
    this.length = 0;
    /** @type {{ n: number, resolve: (b: Buffer) => void, reject: (e: Error) => void } | null} */
    this.want = null;
    /** @type {Error|null} */
    this.error = null;
  }

  /** @param {Buffer} b */
  push(b) {
    if (!b.length) return;
    this.chunks.push(b);
    this.length += b.length;
    this.drain();
  }

  /** @param {Error} e */
  fail(e) {
    if (!this.error) this.error = e;
    const w = this.want;
    if (w) { this.want = null; w.reject(e); }
  }

  /** @param {number} n */
  take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const left = all.subarray(n);
    this.chunks = left.length ? [left] : [];
    this.length = left.length;
    return out;
  }

  drain() {
    const w = this.want;
    if (w && this.length >= w.n) { this.want = null; w.resolve(this.take(w.n)); }
  }

  /** @param {number} n @returns {Promise<Buffer>} */
  read(n) {
    if (this.want) return Promise.reject(new Error("one read at a time"));
    if (this.length >= n) return Promise.resolve(this.take(n));
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => { this.want = { n, resolve, reject }; });
  }

  /** Everything buffered and not yet read. */
  rest() { return this.take(this.length); }
}

/** @param {Buffer} v */
function versionOf(v) {
  const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(v.toString("latin1"));
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** A reason string the far end sent (u32 length, then text), capped so it cannot flood us. */
async function reason(/** @type {Bytes} */ r) {
  const n = (await r.read(4)).readUInt32BE(0);
  if (n > 4096) return "(a reason too long to read)";
  return (await r.read(n)).toString("utf8").replace(/[^\x20-\x7e]/g, "?");
}

/**
 * @typedef {{ width: number, height: number, name: string, bytes: Buffer }} ServerInit
 */

/**
 * Be the VNC client to the agent's container: version, VNC authentication (type 2, or None if
 * that is all the server offers), a shared ClientInit, and the ServerInit it answers with.
 * `bytes` is the complete ServerInit message, which the browser gets unchanged.
 * @param {Bytes} r what the server sent
 * @param {(b: Buffer) => void} write to the server
 * @param {string} password never logged, never in an error
 * @returns {Promise<ServerInit>}
 */
export async function clientHandshake(r, write, password) {
  const v = versionOf(await r.read(12));
  if (!v || v.major !== 3 || v.minor < 8) throw new Error("the VNC server does not speak RFB 3.8");
  write(Buffer.from(VERSION, "latin1"));
  const n = (await r.read(1))[0];
  if (n === 0) throw new Error(`the VNC server refused the connection: ${await reason(r)}`);
  const types = [...(await r.read(n))];
  const type = types.includes(2) ? 2 : types.includes(1) ? 1 : 0;
  if (!type) throw new Error(`the VNC server offers no security type Glass can use (offered ${types.join(", ")})`);
  write(Buffer.from([type]));
  if (type === 2) write(vncResponse(await r.read(16), password));
  if ((await r.read(4)).readUInt32BE(0) !== 0) throw new Error(`VNC authentication failed: ${await reason(r)}`);
  write(Buffer.from([1])); // shared: another viewer opening must never disconnect this one
  const head = await r.read(24);
  const nameLen = head.readUInt32BE(20);
  if (nameLen > 4096) throw new Error("the VNC server sent a desktop name too long to be real");
  const name = await r.read(nameLen);
  return { width: head.readUInt16BE(0), height: head.readUInt16BE(2), name: name.toString("utf8"), bytes: Buffer.concat([head, name]) };
}

/**
 * Be the VNC server to the browser: version 3.8, security None (the browser never holds the
 * container's password: the ticket already said who it is), and the container's own ServerInit.
 * @param {Bytes} r what the browser sent
 * @param {(b: Buffer) => void} write to the browser
 * @param {Buffer} serverInit the container's ServerInit bytes
 * @returns {Promise<{ shared: boolean }>}
 */
export async function serverHandshake(r, write, serverInit) {
  write(Buffer.from(VERSION, "latin1"));
  const v = versionOf(await r.read(12));
  if (!v || v.major !== 3 || v.minor < 8) {
    write(Buffer.from([0]));
    const why = Buffer.from("Glass speaks RFB 3.8 only", "latin1");
    const len = Buffer.alloc(4); len.writeUInt32BE(why.length, 0);
    write(Buffer.concat([len, why]));
    throw new Error("the browser does not speak RFB 3.8");
  }
  write(Buffer.from([1, 1])); // one type on offer: None
  const chosen = (await r.read(1))[0];
  if (chosen !== 1) throw new Error(`the browser chose security type ${chosen}, not None`);
  write(Buffer.from([0, 0, 0, 0]));
  const shared = (await r.read(1))[0] !== 0;
  write(serverInit);
  return { shared };
}

// ---- the client-to-server stream ----------------------------------------------------------

/**
 * @typedef {{ type: number, name: string, bytes: Buffer }} ClientMessage
 */

/**
 * Cuts the browser's byte stream into whole RFB client messages. Chunks may split a message or
 * carry several; push() returns the messages completed so far and keeps the remainder.
 * Throws on a type it does not know or a message larger than the caps, after which the stream
 * is lost and the connection must close.
 */
export class ClientParser {
  /** @param {{ maxCutText?: number, maxEncodings?: number }} [o] */
  constructor(o = {}) {
    this.maxCutText = o.maxCutText ?? 1_000_000;
    this.maxEncodings = o.maxEncodings ?? 256;
    this.buf = Buffer.alloc(0);
  }

  /**
   * How long the message at the front of buf is, or 0 when more bytes are needed to tell.
   * @param {Buffer} b
   */
  sizeOf(b) {
    const type = b[0];
    switch (type) {
      case 0: return 20;
      case 2: {
        if (b.length < 4) return 0;
        const n = b.readUInt16BE(2);
        if (n > this.maxEncodings) throw new Error(`SetEncodings with ${n} encodings`);
        return 4 + 4 * n;
      }
      case 3: return 10;
      case 4: return 8;
      case 5: return 6;
      case 6: {
        if (b.length < 8) return 0;
        // noVNC's extended clipboard sends the length negated (a signed 32-bit int).
        const n = Math.abs(b.readInt32BE(4));
        if (n > this.maxCutText) throw new Error(`ClientCutText of ${n} bytes is over the ${this.maxCutText} byte cap`);
        return 8 + n;
      }
      case 150: return 10;
      case 248: {
        if (b.length < 9) return 0;
        const n = b[8];
        if (n > 64) throw new Error(`ClientFence with a ${n} byte payload`);
        return 9 + n;
      }
      case 250: return 4;
      case 251: {
        if (b.length < 7) return 0;
        return 8 + 16 * b[6];
      }
      case 255: {
        if (b.length < 2) return 0;
        if (b[1] !== 0) throw new Error(`QEMU client message subtype ${b[1]}`);
        return 12;
      }
      default: throw new Error(`unknown RFB client message type ${type}`);
    }
  }

  /** @param {Buffer} chunk @returns {ClientMessage[]} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    /** @type {ClientMessage[]} */
    const out = [];
    while (this.buf.length) {
      const n = this.sizeOf(this.buf);
      if (!n || this.buf.length < n) break;
      const type = this.buf[0];
      let bytes = Buffer.from(this.buf.subarray(0, n));
      if (type === 2) bytes = stripEncodings(bytes);
      out.push({ type, name: NAMES[type], bytes });
      this.buf = this.buf.subarray(n);
    }
    return out;
  }
}

/** SetEncodings without the encodings whose replies Glass could not follow. */
function stripEncodings(/** @type {Buffer} */ b) {
  const n = b.readUInt16BE(2);
  const keep = [];
  for (let i = 0; i < n; i++) { const e = b.readInt32BE(4 + 4 * i); if (e !== EXTENDED_MOUSE_BUTTONS) keep.push(e); }
  if (keep.length === n) return b;
  const out = Buffer.alloc(4 + 4 * keep.length);
  out[0] = 2;
  out.writeUInt16BE(keep.length, 2);
  keep.forEach((e, i) => out.writeInt32BE(e, 4 + 4 * i));
  return out;
}
