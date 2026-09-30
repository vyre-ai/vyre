// @ts-check
// Chrome's native messaging framing: each message on stdin/stdout is a 4-byte little-endian
// length prefix followed by that many bytes of UTF-8 JSON (Chrome's own wire format; it refuses
// anything else and closes the pipe on a bad frame). Pure and side-effect free, so it is tested
// without a real host process or a real Chrome.
//
// Chrome also caps a single message at 1 MB from the extension to the host, and unlimited the
// other way, but this host never needs to send more than a short CDP result, so both directions
// are capped here at MAX for one consistent, generous ceiling and one clear error either way.

export const MAX = 1024 * 1024;

/** @param {unknown} value @returns {Buffer} one framed message, ready to write to stdout */
export function encode(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX) throw new Error(`native message too large: ${body.length} bytes (max ${MAX})`);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

/**
 * A stateful reader: feed it chunks as they arrive on stdin, get back every whole message the
 * chunks complete, in order. Never assumes a chunk boundary lines up with a frame boundary,
 * because a pipe never promises that.
 */
export function reader() {
  let buf = Buffer.alloc(0);
  return {
    /** @param {Buffer} chunk @returns {any[]} zero or more decoded messages */
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      /** @type {any[]} */
      const out = [];
      for (;;) {
        if (buf.length < 4) break;
        const len = buf.readUInt32LE(0);
        if (len > MAX) throw new Error(`native message too large: ${len} bytes (max ${MAX})`);
        if (buf.length < 4 + len) break;
        const body = buf.subarray(4, 4 + len);
        out.push(JSON.parse(body.toString("utf8")));
        buf = buf.subarray(4 + len);
      }
      return out;
    },
    /** Bytes held for an incomplete frame, so a test (or a caller closing down) can tell idle from stuck. */
    pending() { return buf.length; },
  };
}
