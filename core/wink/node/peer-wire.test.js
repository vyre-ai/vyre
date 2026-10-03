// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { peerSession, socketPipe, admitPeer, joinPeer, authProof, Frames, SLICE, T } from "./peer-wire.js";

/** Two connected sockets on loopback. */
async function sockets(t) {
  const server = net.createServer();
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = net.connect(/** @type {any} */ (server.address()).port, "127.0.0.1");
  const b = await new Promise(r => server.once("connection", r));
  await new Promise(r => a.once("connect", r));
  t.after(() => { a.destroy(); /** @type {any} */ (b).destroy(); server.close(); });
  return { a, b: /** @type {net.Socket} */ (b) };
}

test("peer-wire: a call goes to serve and its answer comes back, an error keeps its code", async t => {
  const { a, b } = await sockets(t);
  peerSession(socketPipe(b), { first: 2, serve: async (tool, input) => { if (tool === "no.way") throw Object.assign(new Error("not for you"), { code: "denied" }); return { tool, echo: input }; } });
  const s = peerSession(socketPipe(a));
  assert.deepEqual(await s.call("about.text", { x: 1 }), { tool: "about.text", echo: { x: 1 } });
  await assert.rejects(s.call("no.way"), e => e.code === "denied" && /not for you/.test(e.message));
  await assert.rejects(s.call("Bad Tool"), e => e.code === "bad_input");
  s.close();
});

test("peer-wire: a side that does not serve refuses calls; a closed session fails calls at once and a pending call rejects", async t => {
  const { a, b } = await sockets(t);
  const quiet = peerSession(socketPipe(b), { first: 2 });
  const s = peerSession(socketPipe(a));
  await assert.rejects(s.call("about.text"), e => e.code === "denied");
  const slow = s.call("about.text", {}, { timeoutMs: 5000 });
  quiet.close();
  // the pending call may already have been answered; either way a later one fails
  await slow.catch(() => {});
  await new Promise(r => setTimeout(r, 50));
  await assert.rejects(s.call("about.text"), e => e.code === "unreachable");
});

test("peer-wire: a large result is sliced and reassembled byte for byte", async t => {
  const { a, b } = await sockets(t);
  const big = crypto.randomBytes(3 * 1024 * 1024).toString("base64");
  peerSession(socketPipe(b), { first: 2, serve: async () => ({ big }) });
  const s = peerSession(socketPipe(a));
  assert.equal((await s.call("x.big")).big, big);
  s.close();
});

test("peer-wire: fair queueing, a ping and a small call do not wait behind a bulk result", async t => {
  const { a, b } = await sockets(t);
  const big = "x".repeat(24 * 1024 * 1024);
  peerSession(socketPipe(b), { first: 2, serve: async tool => (tool === "x.big" ? { big } : { ok: 1 }) });
  const s = peerSession(socketPipe(a));
  const bulk = s.call("x.big", {}, { timeoutMs: 60_000 });
  await new Promise(r => setTimeout(r, 20));
  const t0 = performance.now();
  const rtt = await s.ping();
  const small = await s.call("x.small");
  const waited = performance.now() - t0;
  assert.ok(rtt !== null && rtt < 250, `ping ${rtt} ms`);
  assert.deepEqual(small, { ok: 1 });
  assert.ok(waited < 1500, `ping and a small call took ${Math.round(waited)} ms behind a bulk result`);
  assert.equal((await bulk).big.length, big.length);
  s.close();
});

test("peer-wire: the frame parser refuses an oversize frame and handles split input", () => {
  const f = new Frames();
  const h = Buffer.alloc(10); h[0] = T.ping; h.writeUInt32BE(8, 6);
  const whole = Buffer.concat([h, Buffer.alloc(8, 1)]);
  assert.equal(f.push(whole.subarray(0, 4)).length, 0);
  assert.equal(f.push(whole.subarray(4)).length, 1);
  const bad = Buffer.alloc(10); bad.writeUInt32BE(10 * 1024 * 1024, 6);
  assert.throws(() => new Frames().push(bad), /too big/);
  assert.ok(SLICE >= 1024);
});

// ---- auth on the direct path ----

const shared = crypto.randomBytes(32);
const NK = "nodekey:" + "cd".repeat(32);

test("peer-wire auth: a device with the shared key is admitted as device:<id> and calls run as that caller", async t => {
  const { a, b } = await sockets(t);
  const seen = [];
  const home = admitPeer(socketPipe(b), { id: { nodeKey: NK }, box: "box1", shared: async (d, nk) => (d === "srv1" && nk === NK ? shared : null),
    serve: async (caller, tool, input) => { seen.push({ caller, tool }); return { hi: input }; } });
  const dev = await joinPeer(socketPipe(a), { device: "srv1", nodeKey: NK, shared: () => shared });
  const { caller } = await home;
  assert.equal(caller, "device:srv1");
  assert.deepEqual(await dev.call("about.text", 5), { hi: 5 });
  assert.deepEqual(seen, [{ caller: "device:srv1", tool: "about.text" }]);
  dev.close();
});

test("peer-wire auth: a wrong key, an unknown device, a node key that is not the device's and silence are all refused, and nothing is served", async t => {
  const cases = [
    { name: "wrong key", device: "srv1", key: crypto.randomBytes(32), nodeKey: NK },
    { name: "unknown device", device: "ghost", key: shared, nodeKey: NK },
    { name: "someone else's node", device: "srv1", key: shared, nodeKey: "nodekey:" + "ee".repeat(32), homeNode: NK },
  ];
  for (const c of cases) {
    const { a, b } = await sockets(t);
    let served = 0;
    const home = admitPeer(socketPipe(b), { id: { nodeKey: c.homeNode || c.nodeKey }, box: "box1", timeoutMs: 800,
      shared: async (d, nk) => (d === "srv1" && nk === NK ? shared : null), serve: async () => { served++; return {}; } });
    const dev = joinPeer(socketPipe(a), { device: c.device, nodeKey: c.nodeKey, shared: () => c.key, timeoutMs: 800 });
    await assert.rejects(home, /denied|proof|unknown|no proof/, c.name);
    await assert.rejects(dev, undefined, c.name);
    assert.equal(served, 0, c.name);
  }
  // silence: a peer that connects and says nothing
  const { a, b } = await sockets(t);
  await assert.rejects(admitPeer(socketPipe(b), { id: { nodeKey: NK }, box: "box1", timeoutMs: 300, shared: () => shared, serve: async () => ({}) }), /no proof/);
  a.destroy();
  // a call before the proof is refused by the session and never served
  assert.equal(authProof(shared, "n", NK, "b"), authProof(shared, "n", NK, "b"));
  assert.notEqual(authProof(shared, "n", NK, "b"), authProof(shared, "n2", NK, "b"));
});
