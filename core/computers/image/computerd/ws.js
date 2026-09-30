// @ts-check
// A copy of core/computers/ws.js, the same code below this note:
// computerd is copied alone into the image at /opt/computerd, so it cannot import from outside
// its own folder. Change the original first, then copy it here.
//
// ws: the sliver of RFC 6455 Glass needs: the opening handshake's Sec-WebSocket-Accept, and
// framing for a binary stream. Nothing here knows about RFB; it only turns bytes on a raw
// socket into whole WebSocket messages and back, so glass.js can treat the browser side the
// same way rfb.js treats a TCP socket: read what you need, write what you have.
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

/**
 * One server-to-client frame: fin=1, unmasked (RFC 6455 5.1: a server never masks).
 * @param {Buffer} payload @param {number} [opcode] 2 = binary, 0xa = pong
 */
export function encodeFrame(payload, opcode = 2) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

/**
 * @typedef {{ message: Buffer, opcode: number }} WSMessage
 * @typedef {{ control: "close"|"ping"|"pong", payload: Buffer }} WSControl
 */

/**
 * Cuts a client's byte stream into whole WebSocket frames, unmasks them, and reassembles a
 * fragmented message (continuation frames) into one payload. Control frames (close, ping, pong)
 * are handed back distinct from data so the caller can answer a ping or end on a close, exactly
 * as ClientParser in rfb.js hands back distinct RFB message types.
 */
export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
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
      if (len > 20_000_000) throw new Error(`a WebSocket frame of ${len} bytes is over what Glass will buffer`);
      if (!masked) throw new Error("a WebSocket client frame must be masked (RFC 6455 5.2)");
      if (this.buf.length < offset + 4) break;
      const mask = this.buf.subarray(offset, offset + 4);
      const total = offset + 4 + len;
      if (this.buf.length < total) break;
      const maskedPayload = this.buf.subarray(offset + 4, total);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = maskedPayload[i] ^ mask[i & 3];
      this.buf = this.buf.subarray(total);

      if (opcode === 0x8) { out.push({ control: "close", payload }); continue; }
      if (opcode === 0x9) { out.push({ control: "ping", payload }); continue; }
      if (opcode === 0xa) { out.push({ control: "pong", payload }); continue; }
      if (opcode === 0x0) {
        if (this.fragOpcode === null) throw new Error("a continuation frame with nothing to continue");
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          const op = this.fragOpcode;
          this.fragments = []; this.fragOpcode = null;
          out.push({ message: full, opcode: op });
        }
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x2) throw new Error(`unknown WebSocket opcode ${opcode}`);
      if (!fin) { this.fragOpcode = opcode; this.fragments = [payload]; continue; }
      out.push({ message: payload, opcode });
    }
    return out;
  }
}

// ---- test-only helper: a client (masked) frame, the mirror of encodeFrame ------------------

/** Encode one client-to-server frame, masked, as a real browser would. Used by tests only. */
export function encodeClientFrame(payload, opcode = 2, mask = crypto.randomBytes(4)) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
