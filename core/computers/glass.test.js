// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { Glass, Pacer } from "./glass.js";
import { encodeClientFrame } from "./ws.js";

const PASSWORD = "s3cr3t8!";

/** A minimal RFB server: enough of the real handshake for rfb.js's clientHandshake to complete
 * against it, offering security type None so DES is not in the loop (that belongs to rfb.js's
 * own tests, not Glass's). After the handshake it hands the test raw access to what arrives and
 * a way to push bytes toward Glass, standing in for Xvnc. */
function fakeXvnc({ width = 800, height = 600, name = "agent's screen" } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
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
        send: b => sock && sock.write(b),
        close: () => new Promise(r => server.close(() => r(undefined))),
      });
    });
    server.on("error", reject);
  });
}

/** A raw TCP client standing in for the browser's WebSocket, so it can send masked frames and
 * read unmasked ones the way noVNC's transport actually does. */
function fakeBrowser(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    // Attached before 'connect', not after: on a warm process Glass can reject and destroy the
    // socket fast enough that a listener added post-await would miss the close entirely.
    const closed = new Promise(r => sock.once("close", r));
    // A socket with no 'data' listener and no resume() is paused: it never drains, so it never
    // notices the far end closing and 'close' would wait forever. Tests that read frames put it
    // in flowing mode themselves (frameQueue); this covers the ones that only wait for a close.
    sock.resume();
    sock.once("connect", () => resolve({ sock, closed }));
    sock.once("error", reject);
  });
}

/** Waits for the "HTTP/1.1 101 ..." header to arrive and returns bytes after it. */
function readUpgrade(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      const head = buf.subarray(0, i).toString("latin1");
      sock.removeListener("data", onData);
      resolve({ status: head.split(" ")[1], rest: buf.subarray(i + 4) });
    };
    sock.on("data", onData);
    sock.on("close", () => reject(new Error("closed before the upgrade response")));
    sock.on("error", reject);
  });
}

/** Decodes unmasked server->client WebSocket frames (no masking, as Glass sends them), stateful
 * across chunks the same way ws.js's FrameParser is for the client direction. */
class ServerFrameParser {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) break; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) break;
      out.push(this.buf.subarray(off, off + len));
      this.buf = this.buf.subarray(off + len);
    }
    return out;
  }
}

/** A queue of decoded server frames, fed as bytes arrive; collect() waits for the next one. */
function frameQueue(sock, initial = Buffer.alloc(0)) {
  const parser = new ServerFrameParser();
  const pending = parser.push(initial);
  /** @type {Array<() => void>} */
  const waiters = [];
  sock.on("data", d => {
    pending.push(...parser.push(d));
    while (pending.length && waiters.length) waiters.shift()();
  });
  return {
    collect: () => new Promise(resolve => {
      if (pending.length) return resolve(pending.shift());
      waiters.push(() => resolve(pending.shift()));
    }),
  };
}

/** A fake pool implementing only what Glass calls: redeem, viewer, vnc. */
function fakePool({ port, host = "127.0.0.1", password = PASSWORD, running = true }) {
  const tickets = new Map();
  return {
    tickets,
    viewerCalls: [],
    issue(agent, surface, slow = false) { const t = crypto.randomBytes(8).toString("hex"); tickets.set(t, { agent, surface, slow }); return t; },
    redeem(t) { const v = tickets.get(t); if (!v) return null; tickets.delete(t); return v; },
    async viewer(agent, delta) { this.viewerCalls.push([agent, delta]); },
    vnc(agent) { return running ? { host, port, password } : null; },
  };
}

function req(key = "dGhlIHNhbXBsZSBub25jZQ==") {
  return { headers: { upgrade: "websocket", "sec-websocket-key": key, "sec-websocket-protocol": "binary" } };
}

test("glass: an unknown or already-spent ticket is refused before any WebSocket handshake", async () => {
  const pool = fakePool({ port: 0 });
  const glass = new Glass({ pool, keyboard: { canType: () => false }, log: () => {} });
  const upgradeServer = net.createServer(sock => glass.handle(req(), sock, Buffer.alloc(0), { url: new URL("http://vyred/v1/streams/computers/glass?ticket=nope") }));
  await new Promise(r => upgradeServer.listen(0, "127.0.0.1", r));
  const addr = /** @type {import("node:net").AddressInfo} */ (upgradeServer.address());
  const { sock } = await fakeBrowser(addr.port);
  const head = await new Promise(resolve => {
    let buf = Buffer.alloc(0);
    sock.on("data", d => { buf = Buffer.concat([buf, d]); if (buf.includes("403")) resolve(buf.toString("latin1")); });
  });
  assert.match(head, /^HTTP\/1\.1 403/);
  assert.equal(pool.viewerCalls.length, 0);
  await new Promise(r => upgradeServer.close(r));
  sock.destroy();
});

test("glass: a ticket is spent once; reusing it is refused the same way", async () => {
  const pool = fakePool({ port: 0 });
  const ticket = pool.issue("kit", "glass:laptop");
  assert.ok(pool.redeem(ticket));
  assert.equal(pool.redeem(ticket), null);
});

/** Runs a full connection end to end: real fake-Xvnc server, real Glass, real browser socket. */
async function connected({ canType = () => true, renew = undefined, width = 800, height = 600, slow = false } = {}) {
  const xvnc = await fakeXvnc({ width, height });
  const pool = fakePool({ port: xvnc.port });
  const ticket = pool.issue("kit", "glass:laptop", slow);
  const logs = [];
  const glass = new Glass({ pool, keyboard: /** @type {any} */ ({ canType, renew }), log: m => logs.push(m) });
  const upgradeServer = net.createServer(sock => glass.handle(req(), sock, Buffer.alloc(0), { url: new URL(`http://vyred/v1/streams/computers/glass?ticket=${ticket}`) }));
  await new Promise(r => upgradeServer.listen(0, "127.0.0.1", r));
  const addr = /** @type {import("node:net").AddressInfo} */ (upgradeServer.address());
  const { sock } = await fakeBrowser(addr.port);
  const { status, rest } = await readUpgrade(sock);
  assert.equal(status, "101");
  const frames = frameQueue(sock, rest);

  // The RFB 3.8 handshake, Glass as the server, per rfb.js's serverHandshake and ADR 0003.
  const version = await frames.collect();
  assert.equal(version.toString("latin1"), "RFB 003.008\n");
  sock.write(encodeClientFrame(Buffer.from("RFB 003.008\n", "latin1")));

  const secTypes = await frames.collect();
  assert.deepEqual(secTypes, Buffer.from([1, 1])); // one type on offer: None
  sock.write(encodeClientFrame(Buffer.from([1])));

  const secResult = await frames.collect();
  assert.deepEqual(secResult, Buffer.alloc(4)); // OK
  sock.write(encodeClientFrame(Buffer.from([1]))); // shared flag

  const serverInit = await frames.collect();
  assert.equal(serverInit.readUInt16BE(0), width);
  assert.equal(serverInit.readUInt16BE(2), height);

  return { xvnc, pool, glass, sock, logs, frames, upgradeServer, teardown: async () => { sock.destroy(); await xvnc.close(); await new Promise(r => upgradeServer.close(r)); } };
}

test("glass: the container's ServerInit reaches the browser unchanged, and pool.viewer holds the screen", async () => {
  const c = await connected({ width: 1440, height: 900 });
  assert.deepEqual(c.pool.viewerCalls, [["kit", 1]]);
  await c.teardown();
});

test("glass: server-to-client bytes pass through untouched after the handshake", async () => {
  const c = await connected();
  const payload = Buffer.from([0, 0, 0, 1, 5, 5, 100, 100, 1, 1, 0, 0]); // an arbitrary FramebufferUpdate-shaped blob
  c.xvnc.send(payload);
  const got = await c.frames.collect();
  assert.deepEqual(got, payload);
  await c.teardown();
});

test("glass: input is dropped when the surface does not hold the keyboard", async () => {
  const c = await connected({ canType: () => false });
  const keyEvent = Buffer.concat([Buffer.from([4, 1]), Buffer.alloc(2), Buffer.from([0, 0, 0, 65])]); // KeyEvent 'A'
  c.sock.write(encodeClientFrame(keyEvent));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(c.xvnc.received.length, 0);
  await c.teardown();
});

test("glass: input reaches the container when the surface holds the keyboard", async () => {
  const c = await connected({ canType: () => true });
  const keyEvent = Buffer.concat([Buffer.from([4, 1]), Buffer.alloc(2), Buffer.from([0, 0, 0, 65])]);
  c.sock.write(encodeClientFrame(keyEvent));
  await new Promise(resolve => {
    const check = () => (c.xvnc.received.length ? resolve(undefined) : setTimeout(check, 10));
    check();
  });
  assert.deepEqual(Buffer.concat(c.xvnc.received), keyEvent);
  await c.teardown();
});

test("glass: the holder's input renews its take-over; dropped input does not", async () => {
  const renewed = [];
  const keyEvent = Buffer.concat([Buffer.from([4, 1]), Buffer.alloc(2), Buffer.from([0, 0, 0, 65])]);
  const held = await connected({ canType: () => true, renew: (a, s) => renewed.push([a, s]) });
  held.sock.write(encodeClientFrame(keyEvent));
  await new Promise(resolve => { const check = () => (held.xvnc.received.length ? resolve(undefined) : setTimeout(check, 10)); check(); });
  assert.deepEqual(renewed, [["kit", "glass:laptop"]]);
  await held.teardown();
  renewed.length = 0;
  const other = await connected({ canType: () => false, renew: (a, s) => renewed.push([a, s]) });
  other.sock.write(encodeClientFrame(keyEvent));
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(renewed, []);
  await other.teardown();
});

test("glass: a non-input message (FramebufferUpdateRequest) reaches the container even without the keyboard", async () => {
  const c = await connected({ canType: () => false });
  const req3 = Buffer.from([3, 0, 0, 0, 0, 0, 1, 0, 200, 0]); // FramebufferUpdateRequest (10 bytes)
  c.sock.write(encodeClientFrame(req3));
  await new Promise(resolve => {
    const check = () => (c.xvnc.received.length ? resolve(undefined) : setTimeout(check, 10));
    check();
  });
  assert.deepEqual(Buffer.concat(c.xvnc.received), req3);
  await c.teardown();
});

test("glass: an unknown client message type ends the connection instead of guessing at the stream", async () => {
  const c = await connected();
  c.sock.write(encodeClientFrame(Buffer.from([99, 0, 0, 0])));
  await new Promise(resolve => c.sock.on("close", resolve));
  assert.equal(c.pool.viewerCalls.filter(([, d]) => d === -1).length, 1);
  await c.xvnc.close();
  await new Promise(r => c.upgradeServer.close(r));
});

test("glass: closing the browser's socket releases the viewer hold", async () => {
  const c = await connected();
  c.sock.destroy();
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(c.pool.viewerCalls, [["kit", 1], ["kit", -1]]);
  await c.xvnc.close();
  await new Promise(r => c.upgradeServer.close(r));
});

test("glass: no password ever appears in a log line, even on a failed connection", async () => {
  const pool = fakePool({ port: 1, running: true }); // nothing listens on port 1: the connect will fail or refuse
  const ticket = pool.issue("kit", "glass:laptop");
  const logs = [];
  const glass = new Glass({ pool, keyboard: { canType: () => true }, log: m => logs.push(m) });
  const upgradeServer = net.createServer(sock => glass.handle(req(), sock, Buffer.alloc(0), { url: new URL(`http://vyred/v1/streams/computers/glass?ticket=${ticket}`) }));
  await new Promise(r => upgradeServer.listen(0, "127.0.0.1", r));
  const addr = /** @type {import("node:net").AddressInfo} */ (upgradeServer.address());
  const { closed } = await fakeBrowser(addr.port);
  await closed;
  await new Promise(r => setTimeout(r, 50));
  for (const line of logs) assert.doesNotMatch(line, new RegExp(PASSWORD));
  await new Promise(r => upgradeServer.close(r));
});

test("glass: a request with no Sec-WebSocket-Key is refused as a bad request, ticket still spent", async () => {
  const pool = fakePool({ port: 0 });
  const ticket = pool.issue("kit", "glass:laptop");
  const glass = new Glass({ pool, keyboard: { canType: () => false }, log: () => {} });
  const upgradeServer = net.createServer(sock => glass.handle({ headers: {} }, sock, Buffer.alloc(0), { url: new URL(`http://vyred/v1/streams/computers/glass?ticket=${ticket}`) }));
  await new Promise(r => upgradeServer.listen(0, "127.0.0.1", r));
  const addr = /** @type {import("node:net").AddressInfo} */ (upgradeServer.address());
  const { sock } = await fakeBrowser(addr.port);
  const head = await new Promise(resolve => {
    let buf = Buffer.alloc(0);
    sock.on("data", d => { buf = Buffer.concat([buf, d]); if (buf.includes("400")) resolve(buf.toString("latin1")); });
  });
  assert.match(head, /^HTTP\/1\.1 400/);
  assert.equal(pool.redeem(ticket), null); // already spent, even though the upgrade itself failed
  await new Promise(r => upgradeServer.close(r));
  sock.destroy();
});

// ---- the slow-link pacer --------------------------------------------------------------------

/** A fake clock and one-shot timers the test fires by hand. */
function fakeTimers() {
  const clock = { t: 1000 };
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  let id = 0;
  return {
    clock, timers,
    now: () => clock.t,
    setTimer: /** @type {any} */ ((fn, ms) => { const k = ++id; timers.set(k, { at: clock.t + ms, fn }); return k; }),
    clearTimer: /** @type {any} */ (k => { timers.delete(k); }),
    advance(ms) {
      clock.t += ms;
      for (const [k, x] of [...timers]) if (x.at <= clock.t) { timers.delete(k); x.fn(); }
    },
  };
}

const fbur = (n, incremental = 1) => Buffer.from([3, incremental, 0, 0, 0, 0, 1, 0, n, 0]);

test("glass pacer: the first request goes at once, then at most one per 200 ms, keeping only the latest", () => {
  const ft = fakeTimers();
  const sent = [];
  const p = new Pacer(b => sent.push(b[8]), ft);
  p.push(fbur(1));
  assert.deepEqual(sent, [1], "nothing waits for the first request");
  p.push(fbur(2)); p.push(fbur(3)); p.push(fbur(4));
  assert.deepEqual(sent, [1]);
  assert.equal(ft.timers.size, 1, "one timer at a time, however many requests wait");
  ft.advance(199);
  assert.deepEqual(sent, [1]);
  ft.advance(1);
  assert.deepEqual(sent, [1, 4], "the waiting requests collapse into the latest");
  assert.equal(ft.timers.size, 0);
  ft.advance(500);
  p.push(fbur(5));
  assert.deepEqual(sent, [1, 4, 5], "after a quiet spell the next one goes straight out");
});

test("glass pacer: close clears the timer and drops what waits", () => {
  const ft = fakeTimers();
  const sent = [];
  const p = new Pacer(b => sent.push(b[8]), ft);
  p.push(fbur(1)); p.push(fbur(2));
  assert.equal(ft.timers.size, 1);
  p.close();
  assert.equal(ft.timers.size, 0);
  ft.advance(1000);
  p.push(fbur(3));
  assert.deepEqual(sent, [1]);
});

/** Wait until the fake Xvnc has received n bytes. */
const bytesAt = (c, n) => new Promise(resolve => { const check = () => (Buffer.concat(c.xvnc.received).length >= n ? resolve(undefined) : setTimeout(check, 5)); check(); });

test("glass: on a slow ticket, incremental update requests are paced; full requests and input are not", async () => {
  const c = await connected({ slow: true, canType: () => true });
  const keyEvent = Buffer.concat([Buffer.from([4, 1]), Buffer.alloc(2), Buffer.from([0, 0, 0, 65])]);
  // Three incremental requests, a full-frame one and a key, all in one burst.
  c.sock.write(encodeClientFrame(Buffer.concat([fbur(1), fbur(2), fbur(3), fbur(9, 0), keyEvent])));
  await bytesAt(c, 10 + 10 + 8);
  const first = Buffer.concat(c.xvnc.received);
  assert.deepEqual(first, Buffer.concat([fbur(1), fbur(9, 0), keyEvent]), "the first incremental, the full request and the key go at once");
  await bytesAt(c, 38);
  const all = Buffer.concat(c.xvnc.received);
  assert.deepEqual(all.subarray(28), fbur(3), "then only the latest incremental request, once the window opens");
  await new Promise(r => setTimeout(r, 250));
  assert.equal(Buffer.concat(c.xvnc.received).length, 38, "the middle request was never sent");
  await c.teardown();
});

test("glass: without the slow mark, every update request passes straight through", async () => {
  const c = await connected({ canType: () => false });
  c.sock.write(encodeClientFrame(Buffer.concat([fbur(1), fbur(2), fbur(3)])));
  await bytesAt(c, 30);
  assert.deepEqual(Buffer.concat(c.xvnc.received), Buffer.concat([fbur(1), fbur(2), fbur(3)]));
  await c.teardown();
});

/** Connect with a pool whose viewer fails as given; resolves to the raw bytes after the 101. */
async function failedViewer(fail) {
  const pool = { ...fakePool({ port: 0 }), async viewer() { throw fail; } };
  const ticket = pool.issue("kit", "glass:laptop");
  const glass = new Glass({ pool, keyboard: /** @type {any} */ ({ canType: () => false }), log: () => {} });
  const server = net.createServer(sock => glass.handle(req(), sock, Buffer.alloc(0), { url: new URL(`http://vyred/v1/streams/computers/glass?ticket=${ticket}`) }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { sock, closed } = await fakeBrowser(/** @type {any} */ (server.address()).port);
  const chunks = [];
  sock.on("data", d => chunks.push(d));
  await closed;
  await new Promise(r => server.close(r));
  const all = Buffer.concat(chunks);
  const i = all.indexOf("\r\n\r\n");
  assert.match(all.subarray(0, i).toString("latin1"), /^HTTP\/1\.1 101/);
  return all.subarray(i + 4);
}

test("glass: a computer that did not boot closes the stream with 4001 and the reason, so Glass can say why", async () => {
  const short = "kit's computer stopped as soon as it started (exit code 127)";
  const frame = await failedViewer(Object.assign(new Error(`${short}; see docker logs x on the box`), { boot: true, short }));
  assert.equal(frame[0], 0x88, "a final close frame");
  const len = frame[1] & 0x7f;
  assert.equal(frame.readUInt16BE(2), 4001);
  assert.equal(frame.subarray(4, 2 + len).toString("utf8"), short);
});

test("glass: any other checkout failure closes with 1011 and no reason, and Glass tries again", async () => {
  const frame = await failedViewer(new Error("every screen is in use (juno (working)); try again when one is released"));
  assert.equal(frame[0], 0x88);
  assert.equal(frame[1] & 0x7f, 2, "a code and no reason");
  assert.equal(frame.readUInt16BE(2), 1011);
});

test("glass: a close reason is cut to the 123 bytes a close frame allows, never mid-character", async () => {
  const { closeWith } = await import("./glass.js");
  let out = Buffer.alloc(0);
  closeWith(/** @type {any} */ ({ write: b => { out = b; } }), 4001, "é".repeat(100));
  const len = out[1] & 0x7f;
  assert.ok(len <= 125);
  assert.equal(out.subarray(4, 2 + len).toString("utf8"), "é".repeat(61));
});
