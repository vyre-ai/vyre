// @ts-check
// A minimal RFB server: enough of the real handshake for rfb.js's clientHandshake to complete
// against it, offering security type None so DES is not in the loop. Stands in for Xvnc in
// core/computers/glass.test.js (Glass's relay tests) and web/test/glass-world.js (a real browser
// against a real Deck, through a real Glass relay).
import net from "node:net";

/** @param {{ width?: number, height?: number, name?: string }} [o] */
export function fakeXvnc({ width = 800, height = 600, name = "agent's screen" } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    /** @type {Buffer[]} */
    const received = [];
    /** @type {import("node:net").Socket|null} */
    let sock = null;
    server.on("connection", s => {
      sock = s;
      s.write("RFB 003.008\n");
      let stage = 0, buf = Buffer.alloc(0);
      s.on("data", d => {
        buf = Buffer.concat([buf, d]);
        if (stage === 0 && buf.length >= 12) {
          buf = buf.subarray(12);
          s.write(Buffer.from([1, 1])); // one security type: None
          stage = 1;
        }
        if (stage === 1 && buf.length >= 1) {
          buf = buf.subarray(1); // the chosen type
          s.write(Buffer.alloc(4)); // security-result: OK
          stage = 2;
        }
        if (stage === 2 && buf.length >= 1) {
          buf = buf.subarray(1); // ClientInit shared flag
          const nameBuf = Buffer.from(name, "utf8");
          const head = Buffer.alloc(24);
          head.writeUInt16BE(width, 0);
          head.writeUInt16BE(height, 2);
          head.writeUInt32BE(nameBuf.length, 20);
          s.write(Buffer.concat([head, nameBuf]));
          stage = 3;
          return;
        }
        if (stage === 3 && buf.length) { received.push(Buffer.from(buf)); buf = Buffer.alloc(0); }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({
        port: addr.port,
        received,
        send: (/** @type {Buffer} */ b) => sock && sock.write(b),
        /** One small raw-encoded FramebufferUpdate (a solid rect, full frame), so a real client
         * actually decodes and paints a pixel before a test tears the connection down. */
        sendFrame() {
          if (!sock) return;
          const pixels = Buffer.alloc(width * height * 4, 0x80);
          const head = Buffer.alloc(16);
          head.writeUInt8(0, 0); // FramebufferUpdate
          head.writeUInt16BE(1, 2); // one rectangle
          head.writeUInt16BE(0, 4); head.writeUInt16BE(0, 6);
          head.writeUInt16BE(width, 8); head.writeUInt16BE(height, 10);
          head.writeInt32BE(0, 12); // encoding: Raw
          sock.write(Buffer.concat([head, pixels]));
        },
        /** Kills the TCP connection to the backend, as a crashed container would. */
        crash: () => sock && sock.destroy(),
        close: () => new Promise(r => server.close(() => r(undefined))),
      });
    });
    server.on("error", reject);
  });
}
