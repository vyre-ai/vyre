// @ts-check
// wsclient: the client half of RFC 6455 that the bridge needs to stand in for a device's
// WebSocket (ADR 0026, section 4). vyred's stream router speaks the server half (core/computers/
// ws.js); here frames going in are masked and frames coming out are not. Fragmented messages are
// reassembled, so each whole message becomes one data frame in the channel.

import crypto from "node:crypto";

export const OP = Object.freeze({ text: 1, binary: 2, close: 8, ping: 9, pong: 10 });
/** A message bigger than the relay's frame limit could not cross the channel whole. */
export const MAX_MESSAGE = (1 << 20) - 64;

/** One masked client frame, fin=1. @param {Buffer} payload @param {number} opcode */
export function clientFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

/** Cuts a server's byte stream into whole messages and control frames. Throws on a protocol error. */
export class ServerFrames {
  constructor() {
    this.buf = Buffer.alloc(0);
    /** @type {Buffer[]} */
    this.parts = [];
    this.partsLen = 0;
    this.partOp = 0;
  }

  /** @param {Buffer} chunk @returns {Array<{ op: number, payload: Buffer }>} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const fin = Boolean(this.buf[0] & 0x80), op = this.buf[0] & 0x0f;
      if (this.buf[1] & 0x80) throw new Error("a server frame must not be masked");
      let len = this.buf[1] & 0x7f, at = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); at = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) throw new Error("message too big for the relay");
        len = Number(big); at = 10;
      }
      if (this.buf.length < at + len) break;
      const payload = Buffer.from(this.buf.subarray(at, at + len));
      this.buf = this.buf.subarray(at + len);
      if (op >= 8) { out.push({ op, payload }); continue; }
      if (op !== 0) { this.parts = []; this.partsLen = 0; this.partOp = op; }
      this.parts.push(payload);
      this.partsLen += len;
      if (this.partsLen > MAX_MESSAGE) throw new Error("message too big for the relay");
      if (fin) {
        out.push({ op: this.partOp, payload: Buffer.concat(this.parts) });
        this.parts = []; this.partsLen = 0;
      }
    }
    return out;
  }
}
