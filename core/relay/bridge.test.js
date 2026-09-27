// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { keyPair } from "./noise.js";
import { deviceSide, boxSide } from "./channel.js";
import { bridge } from "./bridge.js";
import { acceptKey, encodeFrame, FrameParser } from "../computers/ws.js";

const ROUTE = "abcdefghijklmnopqrstuvwxyz";

async function pair() {
  const box = keyPair(), dev = keyPair();
  const ends = { device: /** @type {any} */ (null), box: /** @type {any} */ (null) };
  const mk = to => ({ send: bytes => setImmediate(() => ends[to]?.receive(Buffer.from(bytes))), close() {} });
  ends.box = boxSide(mk("device"), { s: box, route: ROUTE, admit: async () => ({ ok: true }) });
  ends.device = deviceSide(mk("box"), { s: dev, box: box.pub, route: ROUTE, hello: { v: 1 } });
  const [{ channel: device }, { channel: boxCh }] = await Promise.all([ends.device.ready, ends.box.ready]);
  return { device, boxCh };
}

test("the bridge passes Idempotency-Key and Last-Event-ID, and drops what a device may not set", async () => {
  const { device, boxCh } = await pair();
  /** @type {any[]} */
  const seen = [];
  bridge(boxCh, {
    caller: "device:kit",
    peer: {},
    handler: (req, res, caller) => {
      seen.push({ caller, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  });
  const s = device.open({ method: "POST", path: "/v1/tools/threads.send", headers: {
    "idempotency-key": "8f14e45f-ceea-467a-9575-8f2b2d7e3a1c",
    "last-event-id": "42",
    "x-vyre-agent-key": "not yours",
    "content-type": "application/json",
  } });
  const status = new Promise(resolve => { s.onhead = h => resolve(h.status); });
  s.end();
  assert.equal(await status, 200);
  assert.equal(seen[0].caller, "device:kit");
  assert.equal(seen[0].headers["idempotency-key"], "8f14e45f-ceea-467a-9575-8f2b2d7e3a1c");
  assert.equal(seen[0].headers["last-event-id"], "42");
  assert.equal(seen[0].headers["x-vyre-agent-key"], undefined);
  device.close();
});

/** A stand-in for vyred's stream router: echoes, pings once, and sends one big message. */
function echoRouter(log) {
  return () => (req, socket, head, caller) => {
    log.push({ caller, url: req.url });
    if (!req.url.startsWith("/v1/streams/computers/glass")) { socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n"); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${acceptKey(req.headers["sec-websocket-key"])}\r\n\r\n`);
    socket.write(encodeFrame(Buffer.from("are you there"), 0x9));
    const parser = new FrameParser();
    const take = chunk => {
      for (const f of parser.push(chunk)) {
        if ("control" in f) { log.push(f.control); if (f.control === "close") socket.end(); continue; }
        if (f.message.toString() === "big") socket.write(encodeFrame(Buffer.alloc(200_000, 7), 2));
        else socket.write(encodeFrame(Buffer.concat([Buffer.from("echo: "), f.message]), f.opcode));
      }
    };
    if (head.length) take(head);
    socket.on("data", take);
  };
}

test("a WebSocket stream crosses the bridge as whole messages, and the bridge answers pings", async () => {
  const { device, boxCh } = await pair();
  const log = [];
  bridge(boxCh, { caller: "device:kit", peer: {}, handler: () => {}, upgrade: echoRouter(log) });
  const s = device.open({ ws: "/v1/streams/computers/glass?ticket=t1", headers: {} });
  const got = [];
  let wake;
  s.ondata = d => { got.push(d); wake?.(); };
  const next = () => new Promise(r => { wake = r; });
  const head = await new Promise(r => { s.onhead = r; });
  assert.equal(head.status, 101);
  s.write(Buffer.concat([Buffer.from([1]), Buffer.from("hello")]));
  await next();
  assert.equal(got[0][0], 1);
  assert.equal(got[0].subarray(1).toString(), "echo: hello");
  s.write(Buffer.concat([Buffer.from([1]), Buffer.from("big")]));
  await next();
  assert.equal(got[1][0], 2);
  assert.equal(got[1].length, 200_001, "one message, one data frame, never split");
  assert.equal(log[0].caller, "device:kit");
  assert.ok(log.includes("pong"), "the bridge answered the router's ping");
  const ended = new Promise(r => { s.onend = r; });
  s.end();
  await ended;
  assert.ok(log.includes("close"));
  device.close();
});

test("a refused stream reaches the device as its status, and a bad path never reaches the router", async () => {
  const { device, boxCh } = await pair();
  const log = [];
  bridge(boxCh, { caller: "device:kit", peer: {}, handler: () => {}, upgrade: echoRouter(log) });
  const a = device.open({ ws: "/v1/streams/term/shell", headers: {} });
  assert.equal((await new Promise(r => { a.onhead = r; })).status, 404);
  const b = device.open({ ws: "/v1/tools/../streams", headers: {} });
  assert.equal((await new Promise(r => { b.onhead = r; })).status, 400);
  assert.equal(log.length, 1);
  device.close();
});
