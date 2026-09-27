// @ts-check
// Interop: the client's channel (WebCrypto) against the box's, core/relay/channel.js, over an
// in-memory wire a test can watch and tamper with, as core/relay/channel.test.js does.
import test from "node:test";
import assert from "node:assert/strict";
import { keyPair } from "../../core/relay/noise.js";
import { boxSide, CHUNK as BOX_CHUNK, REKEY_EVERY as BOX_REKEY, MAX_AGE as BOX_MAX_AGE, prologue as boxPrologue } from "../../core/relay/channel.js";
import { dial, CHUNK, REKEY_EVERY, MAX_AGE, prologue, MAX_NONCE } from "./channel.js";
import { MAX_NONCE as BOX_MAX_NONCE } from "../../core/relay/noise.js";
import { RelaySocket, request } from "./client.js";
import { webCrypto } from "./webcrypto.js";
import { nobleCrypto } from "./noble.js";
import { nodeNoble, ROUTE } from "./testing.js";
import { EMPTY } from "./bytes.js";

const wait = ms => new Promise(r => setTimeout(r, ms));

function wire(tap = (_dir, b) => b) {
  const ends = { device: /** @type {any} */ (null), box: /** @type {any} */ (null) };
  const closes = { device: /** @type {any[]} */ ([]), box: /** @type {any[]} */ ([]) };
  const seen = [];
  const mk = (from, to) => ({
    send(bytes) {
      const b = Buffer.from(bytes);
      seen.push([from, b]);
      const out = tap(from, b);
      for (const x of out === null ? [] : Array.isArray(out) ? out : [out]) setImmediate(() => ends[to]?.receive(to === "device" ? new Uint8Array(x) : x));
    },
    close(code, reason) { closes[from].push({ code, reason }); },
  });
  return { ends, closes, seen, device: mk("device", "box"), box: mk("box", "device") };
}

async function connect(o = {}) {
  const crypto = o.crypto || webCrypto();
  const box = keyPair(), dev = await crypto.generateKeyPair();
  const w = wire(o.tap);
  const b = boxSide(w.box, { s: box, route: ROUTE, admit: async (pub, hello) => ({ v: 1, device: "x", you: pub.toString("hex"), hello }) });
  w.ends.box = b;
  const d = dial(w.device, { crypto, s: dev, box: new Uint8Array(box.pub), route: ROUTE, hello: { v: 1, name: "kit" } });
  w.ends.device = d;
  const [{ channel, reply }, boxEnd] = await Promise.all([d.ready, b.ready]);
  return { w, channel, reply, boxCh: boxEnd.channel, hello: boxEnd.hello, dev };
}

const collect = s => new Promise((resolve, reject) => {
  const parts = [];
  let head;
  s.onhead = h => { head = h; };
  s.ondata = c => parts.push(Buffer.from(c));
  s.onend = () => resolve({ head, body: Buffer.concat(parts) });
  s.onreset = reject;
});

test("channel interop: the constants and prologue match the box's", () => {
  assert.equal(CHUNK, BOX_CHUNK);
  assert.equal(REKEY_EVERY, BOX_REKEY);
  assert.equal(MAX_AGE, BOX_MAX_AGE);
  assert.equal(MAX_NONCE, BOX_MAX_NONCE);
  assert.deepEqual(Buffer.from(prologue(ROUTE)), boxPrologue(ROUTE));
});

for (const [name, crypto] of [["WebCrypto", webCrypto()], ["@noble", nobleCrypto(nodeNoble())]]) {
  test(`channel interop (${name}): the box learns the device's key and hello; both see one handshake hash`, async () => {
    const { channel, reply, boxCh, hello, dev } = await connect({ crypto });
    assert.equal(reply.you, Buffer.from(dev.publicKey).toString("hex"));
    assert.equal(hello.name, "kit");
    assert.deepEqual(Buffer.from(channel.hash), boxCh.hash);
  });
}

test("channel interop: request and response bodies larger than CHUNK, both ways", async () => {
  const { channel, boxCh } = await connect();
  const up = Buffer.alloc(CHUNK * 2 + 5, 3), down = Buffer.alloc(CHUNK * 3 + 17, 7);
  boxCh.onstream = s => {
    const parts = [];
    s.ondata = c => parts.push(c);
    s.onend = () => {
      assert.deepEqual(s.head, { method: "POST", path: "/v1/tools/notes.add", headers: { "content-type": "application/octet-stream" } });
      assert.deepEqual(Buffer.concat(parts), up);
      s.respond({ status: 200, headers: { "x-n": "1" } });
      s.write(down);
      s.end();
    };
  };
  const res = await request(channel, { method: "POST", path: "/v1/tools/notes.add", headers: { "content-type": "application/octet-stream" } }, new Uint8Array(up));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-N"), "1");
  assert.deepEqual(Buffer.from(await res.bytes()), down);
  assert.equal(channel.streams.size, 0, "a finished stream is forgotten");
});

test("channel interop: a stream reset travels both ways", async () => {
  const { channel, boxCh } = await connect();
  const boxReset = new Promise(r => { boxCh.onstream = s => { s.onreset = r; if (s.head.path === "/a") s.reset("no such thing"); }; });
  await assert.rejects(request(channel, { method: "GET", path: "/a", headers: {} }, EMPTY), /request reset: no such thing/);
  const s = channel.open({ method: "GET", path: "/b", headers: {} });
  s.reset("the device gave up");
  assert.equal(await boxReset, "the device gave up");
});

test("channel interop: a WebSocket stream carries text and binary messages", async () => {
  const { channel, boxCh } = await connect();
  boxCh.onstream = s => {
    assert.equal(s.head.ws, "/v1/streams/term/juno");
    s.respond({ status: 101 });
    s.ondata = c => s.write(c);          // echo each [kind][message] frame
    s.onend = () => s.end();
  };
  const sock = new RelaySocket();
  const got = [];
  const opened = new Promise(r => { sock.onopen = r; });
  const two = new Promise(r => { sock.onmessage = e => { got.push(e.data); if (got.length === 2) r(undefined); }; });
  sock.attach(channel, "/v1/streams/term/juno", {});
  await opened;
  sock.send("ls\n");
  sock.send(new Uint8Array([0, 1, 2, 255]));
  await two;
  assert.equal(got[0], "ls\n");
  assert.deepEqual([...new Uint8Array(got[1])], [0, 1, 2, 255]);
  const closed = new Promise(r => { sock.onclose = r; });
  sock.close();
  assert.equal((/** @type {any} */ (await closed)).code, 1000);
});

test("channel interop: frames cross the rekey boundary in both directions", async () => {
  const { channel, boxCh } = await connect();
  // Jump both directions' counters to just before 2^20 on both ends, then talk across it.
  const near = REKEY_EVERY - 3;
  channel.tx.n = boxCh.rx.n = near;
  channel.rx.n = boxCh.tx.n = near;
  let served = 0;
  boxCh.onstream = s => { s.onend = () => { served++; s.respond({ status: 200 }); s.write(Buffer.from(`n${served}`)); s.end(); }; };
  for (let i = 1; i <= 4; i++) {
    const res = await request(channel, { method: "GET", path: "/x", headers: {} }, EMPTY);
    assert.equal(await res.text(), `n${i}`);
  }
  assert.ok(channel.tx.n > REKEY_EVERY && boxCh.tx.n > REKEY_EVERY, "both directions went past the boundary");
  assert.equal(channel.closed, false);
  assert.equal(boxCh.closed, false);
});

test("channel interop: a tampered frame from the relay closes the device's channel", async () => {
  let flip = false;
  const { channel, boxCh, w } = await connect({ tap: (dir, b) => { if (flip && dir === "box") b[b.length - 1] ^= 1; return b; } });
  boxCh.onstream = s => { s.onend = () => { flip = true; s.respond({ status: 200 }); s.end(); }; };
  await assert.rejects(request(channel, { method: "GET", path: "/", headers: {} }, EMPTY), /connection lost/);
  assert.equal(channel.closed, true);
  assert.deepEqual(w.closes.device[0], { code: 4400, reason: "decrypt failed" });
});

test("channel interop: a frame the relay replays to the device closes its channel", async () => {
  let arm = false;
  const { channel, boxCh } = await connect({ tap: (dir, b) => { if (arm && dir === "box") { arm = false; return [b, b]; } return b; } });
  boxCh.onstream = s => { s.onend = () => { arm = true; s.respond({ status: 200 }); s.write(Buffer.from("once")); s.end(); }; };
  const s = channel.open({ method: "GET", path: "/", headers: {} });
  s.end();
  const res = collect(s);
  res.catch(() => {});
  await wait(30);
  assert.equal(channel.closed, true);
});

test("channel interop: the relay sees no plaintext from the client", async () => {
  const { channel, boxCh, w } = await connect();
  boxCh.onstream = s => { s.onend = () => { s.respond({ status: 200 }); s.write(Buffer.from("Northwind Bakery invoice")); s.end(); }; };
  const res = await request(channel, { method: "POST", path: "/v1/tools/vault.reveal", headers: {} }, new TextEncoder().encode("Harlow Legal"));
  await res.text();
  const all = Buffer.concat(w.seen.map(([, b]) => b)).toString("latin1");
  for (const secret of ["kit", "vault.reveal", "Northwind", "Harlow", "POST"]) assert.ok(!all.includes(secret), secret);
});
