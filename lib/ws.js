// @ts-check
// ws: the ONE RFC 6455 framing in the repo (consolidation inventory item 13): the opening handshake's Sec-WebSocket-Accept, and framing for text and binary messages in BOTH directions. Glass, the
// stream router, the terminal, the relay (server and bridge client) and voice all use it. Nothing here knows about RFB or voice; it only turns bytes on a raw socket into whole WebSocket messages and
// back, so glass.js can treat the browser side the same way rfb.js treats a TCP socket: read what you need, write what you have.
//
// No dependency is pulled in for this because the wire format is small: a length-prefixed
// frame, one XOR-mask on the client's side. Client frames must be masked (RFC 6455 5.2); a
// frame from a browser that is not is rejected, since that is not a real WebSocket client.

import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export function acceptKey(key) {
  return crypto.createHash("sha1").update(String(key) + GUID).digest("base64");
}

/** The whole `101 Switching Protocols` answer to a client's upgrade request. `extra` is any further header lines, each ending in \r\n (a negotiated Sec-WebSocket-Protocol). @param {string} key @param {string} [extra] */
export const upgradeHead = (key, extra = "") => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n${extra}\r\n`;

/**
 * One frame, fin=1. A server never masks and a client always does (RFC 6455 5.1), so the caller says which end it is: `mask` false (a server), true (a client, random key) or a 4-byte key.
 * @param {Buffer} payload @param {number} [opcode] 1 = text, 2 = binary, 8 = close, 9 = ping, 0xa = pong @param {boolean|Buffer} [mask]
 */
export function encodeFrame(payload, opcode = 2, mask = false) {
  const len = payload.length;
  const bit = mask ? 0x80 : 0;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, bit | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = bit | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = bit | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  if (!mask) return Buffer.concat([header, payload]);
  const key = Buffer.isBuffer(mask) ? mask : crypto.randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, body]);
}

/**
 * @typedef {{ message: Buffer, opcode: number }} WSMessage
 * @typedef {{ control: "close"|"ping"|"pong", payload: Buffer, code?: number }} WSControl
 */

/**
 * Cuts a byte stream into whole WebSocket frames, unmasks them, and reassembles a fragmented message (continuation frames) into one payload. Control frames (close, ping, pong) are handed back
 * distinct from data so the caller can answer a ping or end on a close (a close carries its status `code`). `masked` is what the OTHER end must do: true when parsing a client (the default; an unmasked
 * client frame is not a real WebSocket client), false when parsing a server (a masked server frame is refused). `max` bounds one frame and one reassembled message.
 */
export class FrameParser {
  /** @param {{ masked?: boolean, max?: number }} [opts] */
  constructor({ masked = true, max = 20_000_000 } = {}) {
    this.expectMasked = masked;
    this.max = max;
    this.buf = Buffer.alloc(0);
    this.fragLen = 0;
    /** @type {Buffer[]} */
    this.fragments = [];
    /** @type {number|null} */
    this.fragOpcode = null;
  }

  /** @param {Buffer} chunk @returns {Array<WSMessage|WSControl>} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    /** @type {Array<WSMessage|WSControl>} */
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = Boolean(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = Boolean(b1 & 0x80);
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("a WebSocket frame that long is not real");
        len = Number(big);
        offset = 10;
      }
      if (len > this.max) throw new Error(`a WebSocket frame of ${len} bytes is over the ${this.max}-byte limit`);
      if (masked !== this.expectMasked) throw new Error(this.expectMasked ? "a WebSocket client frame must be masked (RFC 6455 5.2)" : "a WebSocket server frame must not be masked (RFC 6455 5.1)");
      const keyLen = masked ? 4 : 0;
      if (this.buf.length < offset + keyLen) break;
      const total = offset + keyLen + len;
      if (this.buf.length < total) break;
      const raw = this.buf.subarray(offset + keyLen, total);
      /** @type {Buffer} */ let payload;
      if (masked) {
        const mask = this.buf.subarray(offset, offset + 4);
        payload = Buffer.alloc(len);
        for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3];
      } else payload = Buffer.from(raw);
      this.buf = this.buf.subarray(total);

      if (opcode === 0x8) { out.push({ control: "close", payload, code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005 }); continue; }
      if (opcode === 0x9) { out.push({ control: "ping", payload }); continue; }
      if (opcode === 0xa) { out.push({ control: "pong", payload }); continue; }
      if (opcode === 0x0) {
        if (this.fragOpcode === null) throw new Error("a continuation frame with nothing to continue");
        this.fragments.push(payload);
        this.fragLen += payload.length;
        if (this.fragLen > this.max) throw new Error(`a WebSocket message of over ${this.max} bytes`);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          const op = this.fragOpcode;
          this.fragments = []; this.fragOpcode = null; this.fragLen = 0;
          out.push({ message: full, opcode: op });
        }
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x2) throw new Error(`unknown WebSocket opcode ${opcode}`);
      if (!fin) { this.fragOpcode = opcode; this.fragments = [payload]; this.fragLen = payload.length; continue; }
      out.push({ message: payload, opcode });
    }
    return out;
  }
}

// ---- the mirror of encodeFrame for a client -----------------------------------------------

/** Encode one client-to-server frame, masked, as a real browser would. @param {Buffer} payload @param {number} [opcode] @param {Buffer} [mask] */
export function encodeClientFrame(payload, opcode = 2, mask = crypto.randomBytes(4)) { return encodeFrame(payload, opcode, mask); }
