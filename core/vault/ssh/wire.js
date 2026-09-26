// @ts-check
// wire: the SSH binary encoding (RFC 4251 section 5): uint32, string, mpint, bool, byte.
//
// The key parser, the agent protocol and the SSHSIG reader all speak this, so it lives once
// here. A Reader throws on every short read: the agent reads bytes from any local process, and a
// truncated or lying length must end that message, never read past it.

export class Reader {
  /** @param {Buffer} buf */
  constructor(buf) { this.buf = buf; this.at = 0; }

  get left() { return this.buf.length - this.at; }

  /** @param {number} n */
  take(n) {
    if (n < 0 || this.at + n > this.buf.length) throw new Error("truncated ssh message");
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  byte() { return this.take(1)[0]; }
  bool() { return this.byte() !== 0; }
  uint32() { return this.take(4).readUInt32BE(0); }
  string() { return this.take(this.uint32()); }
  text() { return this.string().toString("utf8"); }

  /** An mpint as unsigned big-endian bytes, leading zeros removed. */
  mpint() {
    const b = this.string();
    if (b.length && b[0] & 0x80) throw new Error("negative mpint in an ssh key");
    let i = 0;
    while (i < b.length && b[i] === 0) i++;
    return b.subarray(i);
  }
}

export const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
/** @param {Buffer|string} v */
export const str = v => { const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8"); return Buffer.concat([u32(b.length), b]); };
export const byte = n => Buffer.from([n & 0xff]);

/** An unsigned big-endian integer as an mpint: minimal, with a 0 byte when the top bit is set. */
export function mpint(bytes) {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  let b = bytes.subarray(i);
  if (b.length && b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return str(b);
}

/** Left-pad unsigned bytes to a fixed width (JWK coordinates and scalars are fixed width). */
export function pad(bytes, len) {
  if (bytes.length > len) throw new Error("integer too large for its field");
  return bytes.length === len ? bytes : Buffer.concat([Buffer.alloc(len - bytes.length), bytes]);
}
