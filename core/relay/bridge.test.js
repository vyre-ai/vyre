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
    "authorization": "Vyre k1.s1",
    "x-vyre-proof": "t n sig",
    "content-type": "application/json",
  } });
  const status = new Promise(resolve => { s.onhead = h => resolve(h.status); });
  s.end();
  assert.equal(await status, 200);
  assert.equal(seen[0].caller, "device:kit");
  assert.equal(seen[0].headers["idempotency-key"], "8f14e45f-ceea-467a-9575-8f2b2d7e3a1c");
  assert.equal(seen[0].headers["last-event-id"], "42");
  assert.equal(seen[0].headers["x-vyre-agent-key"], undefined);
  assert.equal(seen[0].headers.authorization, "Vyre k1.s1", "a person session passes untouched");
  assert.equal(seen[0].headers["x-vyre-proof"], "t n sig");
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

// ---- the wink peer stream (lead's ruling, 3 Oct 2026) ----

import { resetPeerLimits, PEER_PER_MIN } from "./bridge.js";

/** A bridge whose peer door records what it accepts. */
async function peerWorld(extra = {}, caller = "device:srv1") {
  resetPeerLimits();
  const { device, boxCh } = await pair();
  /** @type {any[]} */
  const accepted = [];
  bridge(boxCh, { caller, peer: {}, handler: () => {},
    peers: { space: "harlow", allow: () => true, accept: (s, who) => { accepted.push({ s, who }); s.ondata = c => s.write(c); s.onend = () => s.end(); }, ...extra } });
  return { device, accepted };
}
const answer = s => new Promise(resolve => { s.onhead = h => resolve(h); });

test("peer stream: an authenticated paired server's stream reaches the peer door as that device, and bytes echo", async () => {
  const { device, accepted } = await peerWorld();
  const s = device.open({ peer: "wink", space: "harlow" });
  const got = new Promise(r => { s.ondata = c => r(c.toString()); });
  assert.equal((await answer(s)).status, 200);
  s.write(Buffer.from("kernel bytes"));
  assert.equal(await got, "kernel bytes");
  assert.deepEqual(accepted[0].who, { via: "relay", deviceId: "srv1", space: "harlow" });
  device.close();
});

test("peer stream: no peers option, a refusing allow(), a wrong space, a stranger caller and a stray head field are all refused", async () => {
  resetPeerLimits();
  { const { device, boxCh } = await pair(); bridge(boxCh, { caller: "device:srv1", peer: {}, handler: () => {} });
    assert.equal((await answer(device.open({ peer: "wink", space: "harlow" }))).status, 403, "a box with no peer door"); device.close(); }
  { const { device } = await peerWorld({ allow: () => false });
    assert.equal((await answer(device.open({ peer: "wink", space: "harlow" }))).status, 403, "unauthenticated for peers"); device.close(); }
  { const { device } = await peerWorld({ allow: () => { throw new Error("db down"); } });
    assert.equal((await answer(device.open({ peer: "wink", space: "harlow" }))).status, 403, "a throwing check refuses"); device.close(); }
  { const { device, accepted } = await peerWorld();
    assert.equal((await answer(device.open({ peer: "wink", space: "other" }))).status, 403, "another space");
    assert.equal((await answer(device.open({ peer: "wink", space: "harlow", device: "someone-else" }))).status, 400, "a head cannot name an identity");
    assert.equal((await answer(device.open({ peer: "tcp", space: "harlow" }))).status, 400);
    assert.equal(accepted.length, 0); device.close(); }
  { const { device, accepted } = await peerWorld({}, "tailnet:alex@example.com");
    assert.equal((await answer(device.open({ peer: "wink", space: "harlow" }))).status, 403, "only paired devices");
    assert.equal(accepted.length, 0); device.close(); }
});

test("peer stream: per device, perMin new streams a minute and open at once, counted across channels, and a slot frees on end", async () => {
  let t = 1_000_000;
  const { device } = await peerWorld({ perMin: 3, open: 2, now: () => t });
  const a = device.open({ peer: "wink", space: "harlow" }), b = device.open({ peer: "wink", space: "harlow" });
  assert.equal((await answer(a)).status, 200); assert.equal((await answer(b)).status, 200);
  assert.equal((await answer(device.open({ peer: "wink", space: "harlow" }))).status, 429, "two are open");
  a.end(); await new Promise(r => setTimeout(r, 30));
  const c = device.open({ peer: "wink", space: "harlow" });
  assert.equal((await answer(c)).status, 200, "a closed stream frees its slot");
  c.end(); await new Promise(r => setTimeout(r, 30));
  assert.equal((await answer(device.open({ peer: "wink", space: "harlow" }))).status, 429, "three in the minute");
  t += 61_000;
  assert.equal((await answer(device.open({ peer: "wink", space: "harlow" }))).status, 200, "the window moved on");
  device.close();
  assert.ok(PEER_PER_MIN > 0);
});
