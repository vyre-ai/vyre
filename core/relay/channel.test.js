// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { keyPair } from "./noise.js";
import { deviceSide, boxSide, CHUNK } from "./channel.js";

const ROUTE = "abcdefghijklmnopqrstuvwxyz";

/**
 * Two ends joined by a "relay" that a test can watch and tamper with. Delivery is async, like a
 * socket. `tap(dir, bytes)` may return replacement bytes, an array of them, or null to drop.
 */
function wire(tap = (_dir, b) => b) {
  const ends = { device: /** @type {any} */ (null), box: /** @type {any} */ (null) };
  const closes = { device: /** @type {any[]} */ ([]), box: /** @type {any[]} */ ([]) };
  const seen = [];
  const mk = (from, to) => ({
    send(bytes) {
      seen.push([from, Buffer.from(bytes)]);
      const out = tap(from, Buffer.from(bytes));
      for (const b of out === null ? [] : Array.isArray(out) ? out : [out]) setImmediate(() => ends[to]?.receive(b));
    },
    close(code, reason) { closes[from].push({ code, reason }); },
  });
  return { ends, closes, seen, device: mk("device", "box"), box: mk("box", "device") };
}

async function connect(o = {}) {
  const box = keyPair(), dev = keyPair();
  const w = wire(o.tap);
  const b = boxSide(w.box, { s: box, route: ROUTE, admit: o.admit || (async (pub, hello) => ({ ok: true, you: pub.toString("hex").slice(0, 8), hello })) });
  w.ends.box = b;
  const d = deviceSide(w.device, { s: dev, box: o.wrongBox || box.pub, route: ROUTE, hello: { v: 1, name: "alex's phone" } });
  w.ends.device = d;
  return { w, b, d, box, dev };
}

test("the box learns the device's key and hello, and the device gets the box's reply", async () => {
  const { b, d, dev } = await connect();
  const [{ channel, reply }, box] = await Promise.all([d.ready, b.ready]);
  assert.equal(reply.ok, true);
  assert.equal(reply.you, dev.pub.toString("hex").slice(0, 8));
  assert.equal(box.hello.name, "alex's phone");
  assert.deepEqual(box.channel.peer, dev.pub);
  assert.deepEqual(channel.hash, box.channel.hash);
});

test("a request and a chunked response travel on one stream", async () => {
  const { b, d } = await connect();
  const [{ channel }, { channel: boxCh }] = await Promise.all([d.ready, b.ready]);
  const big = Buffer.alloc(CHUNK * 2 + 17, 7);
  boxCh.onstream = s => {
    assert.deepEqual(s.head, { method: "GET", path: "/v1/health" });
    s.onend = () => { s.respond({ status: 200 }); s.write(big); s.end(); };
  };
  const s = channel.open({ method: "GET", path: "/v1/health" });
  s.end();
  const got = await new Promise(resolve => {
    const parts = [];
    let head;
    s.onhead = h => { head = h; };
    s.ondata = c => parts.push(c);
    s.onend = () => resolve({ head, body: Buffer.concat(parts) });
  });
  assert.equal(got.head.status, 200);
  assert.deepEqual(got.body, big);
  assert.equal(channel.streams.size, 0, "a finished stream is forgotten");
});

test("the wrong box key never opens a channel", async () => {
  const { b, d, w } = await connect({ wrongBox: keyPair().pub });
  await assert.rejects(b.ready, /decrypt failed/);
  assert.equal(w.closes.box[0]?.code, 4401);
  d.gone("closed by the box");
  await assert.rejects(d.ready, /closed by the box/);
});

test("a refused device is closed with the reason and gets nothing", async () => {
  const { b, d, w } = await connect({ admit: async () => { throw new Error("not a paired device"); } });
  await assert.rejects(b.ready, /not a paired device/);
  assert.deepEqual(w.closes.box, [{ code: 4401, reason: "not a paired device" }]);
  assert.equal(w.seen.filter(([from]) => from === "box").length, 0, "the box sent nothing");
  d.ready.catch(() => {});
});

test("a frame the relay replays closes the channel", async () => {
  let replay = null;
  const tap = (dir, bytes) => {
    if (dir === "device" && replay === "arm") { replay = bytes; return [bytes, bytes]; }
    return bytes;
  };
  const { b, d, w } = await connect({ tap });
  const [{ channel }, { channel: boxCh }] = await Promise.all([d.ready, b.ready]);
  let opened = 0;
  boxCh.onstream = () => { opened++; };
  replay = "arm";
  channel.open({ method: "POST", path: "/v1/tools/gate.approve" });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(opened, 1, "the call ran once");
  assert.equal(boxCh.closed, true);
  assert.equal(w.closes.box[0]?.code, 4400);
});

test("a flipped bit closes the channel", async () => {
  let flip = false;
  const tap = (dir, bytes) => { if (flip && dir === "device") { bytes[bytes.length - 1] ^= 1; } return bytes; };
  const { b, d } = await connect({ tap });
  const [{ channel }, { channel: boxCh }] = await Promise.all([d.ready, b.ready]);
  let opened = 0;
  boxCh.onstream = () => { opened++; };
  flip = true;
  channel.open({ method: "GET", path: "/" });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(opened, 0);
  assert.equal(boxCh.closed, true);
});

test("the relay sees no plaintext", async () => {
  const { b, d, w } = await connect();
  const [{ channel }, { channel: boxCh }] = await Promise.all([d.ready, b.ready]);
  boxCh.onstream = s => { s.respond({ status: 200 }); s.write(Buffer.from("Northwind Bakery invoice")); s.end(); };
  const s = channel.open({ method: "GET", path: "/v1/tools/vault.reveal" });
  s.end();
  await new Promise(r => { s.onend = r; });
  const all = Buffer.concat(w.seen.map(([, b]) => b)).toString("latin1");
  for (const secret of ["alex's phone", "vault.reveal", "Northwind", "GET"]) assert.ok(!all.includes(secret), secret);
});
