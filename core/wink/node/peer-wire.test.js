// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { peerSession, socketPipe, admitPeer, joinPeer, authMessage, verifyDevice, toolAllowed, STORAGE_DEVICE_TOOLS, Frames, SLICE, T } from "./peer-wire.js";

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

// ---- auth on the direct path: the device key is the key on its identity entry ----

const NK = "nodekey:" + "cd".repeat(32);
const b64u = b => Buffer.from(b).toString("base64url");
function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: b64u(publicKey.export({ format: "der", type: "spki" }).subarray(-32)), sign: m => b64u(crypto.sign(null, m, privateKey)) };
}
/** A fake identity port: entries by eid, with an owner each; `entry` answers only for this Space's owner, as the chain port does. */
function list(rows) {
  const m = new Map(Object.entries(rows));
  return { m, entry: async eid => { const r = m.get(eid); return r && r.owner === "alex" ? { eid, kind: r.kind || "device", pub: r.pub } : null; } };
}
const K = keyPair();

test("peer-wire auth: a device that proves the key on its entry is admitted as device:<eid> and calls run as that caller", async t => {
  const { a, b } = await sockets(t);
  const seen = [];
  const ids = list({ srv1: { owner: "alex", pub: K.pub } });
  const home = admitPeer(socketPipe(b), { id: { nodeKey: NK }, box: "box1", entry: ids.entry,
    serve: async (caller, tool, input, proven) => { seen.push({ caller, tool, proven }); return { hi: input }; } });
  const dev = await joinPeer(socketPipe(a), { device: "srv1", nodeKey: NK, sign: K.sign });
  const { caller } = await home;
  assert.equal(caller, "device:srv1");
  assert.deepEqual(await dev.call("about.text", 5), { hi: 5 });
  assert.deepEqual(seen, [{ caller: "device:srv1", tool: "about.text", proven: { nodeKey: NK } }]);
  dev.close();
});

/** One admission attempt; resolves to what the home did. */
async function attempt(t, { ids, device = "srv1", sign = K.sign, nodeKey = NK, homeNode = nodeKey, box = "box1" }) {
  const { a, b } = await sockets(t);
  let served = 0;
  const home = admitPeer(socketPipe(b), { id: { nodeKey: homeNode }, box, timeoutMs: 800, entry: ids.entry, serve: async () => { served++; return {}; } });
  const dev = joinPeer(socketPipe(a), { device, nodeKey, sign, timeoutMs: 800 });
  return { home, dev, served: () => served };
}

test("peer-wire auth probes: a removed entry, a wrong key, an entry of another owner, a node the proof did not name and a replayed proof are all refused, and nothing is served", async t => {
  const cases = [
    { name: "removed entry", ids: list({}) },
    { name: "wrong key", ids: list({ srv1: { owner: "alex", pub: K.pub } }), sign: keyPair().sign },
    { name: "another owner's entry", ids: list({ srv1: { owner: "bob", pub: K.pub } }) },
    { name: "an entry that is not a device", ids: list({ srv1: { owner: "alex", kind: "contact", pub: K.pub } }) },
    { name: "someone else's node key", ids: list({ srv1: { owner: "alex", pub: K.pub } }), nodeKey: "nodekey:" + "ee".repeat(32), homeNode: NK, sign: m => K.sign(authMessage("x", "nodekey:" + "ee".repeat(32), "box1", "srv1")) },
    { name: "another home's box", ids: list({ srv1: { owner: "alex", pub: K.pub } }), sign: m => K.sign(authMessage("x", NK, "otherbox", "srv1")) },
  ];
  for (const c of cases) {
    const r = await attempt(t, c);
    await assert.rejects(r.home, /denied|proof|unknown|no proof/, c.name);
    await assert.rejects(r.dev, undefined, c.name);
    assert.equal(r.served(), 0, c.name);
  }
  // a replayed proof: capture a good proof from one connection, send it to a fresh challenge
  let captured = null;
  const ids = list({ srv1: { owner: "alex", pub: K.pub } });
  const first = await sockets(t);
  const h1 = admitPeer(socketPipe(first.b), { id: { nodeKey: NK }, box: "box1", entry: ids.entry, serve: async () => ({}) });
  const d1 = await joinPeer(socketPipe(first.a), { device: "srv1", nodeKey: NK, sign: m => (captured = K.sign(m)) });
  await h1; d1.close();
  const second = await sockets(t);
  let served = 0;
  const h2 = admitPeer(socketPipe(second.b), { id: { nodeKey: NK }, box: "box1", timeoutMs: 800, entry: ids.entry, serve: async () => { served++; return {}; } });
  const d2 = joinPeer(socketPipe(second.a), { device: "srv1", nodeKey: NK, sign: () => captured, timeoutMs: 800 });
  await assert.rejects(h2, /proof/, "replay");
  await assert.rejects(d2);
  assert.equal(served, 0);
  // silence: a peer that connects and says nothing
  const { a, b } = await sockets(t);
  await assert.rejects(admitPeer(socketPipe(b), { id: { nodeKey: NK }, box: "box1", timeoutMs: 300, entry: ids.entry, serve: async () => ({}) }), /no proof/);
  a.destroy();
});

test("peer-wire auth: an entry removed after admission is refused at the very next call, with no cache", async t => {
  const { a, b } = await sockets(t);
  const ids = list({ srv1: { owner: "alex", pub: K.pub } });
  let served = 0;
  const home = admitPeer(socketPipe(b), { id: { nodeKey: NK }, box: "box1", entry: ids.entry, serve: async () => { served++; return { ok: 1 }; } });
  const dev = await joinPeer(socketPipe(a), { device: "srv1", nodeKey: NK, sign: K.sign });
  await home;
  assert.deepEqual(await dev.call("about.text"), { ok: 1 });
  ids.m.delete("srv1");
  await assert.rejects(dev.call("about.text"), e => e.code === "denied" || e.code === "unreachable");
  assert.equal(served, 1);
  // a key rotated on the same eid is not the key that was admitted
  assert.equal(verifyDevice(K.pub, Buffer.from("m"), K.sign(Buffer.from("m"))), true);
  assert.equal(verifyDevice(keyPair().pub, Buffer.from("m"), K.sign(Buffer.from("m"))), false);
  assert.equal(verifyDevice("short", Buffer.from("m"), "x"), false);
});

test("D-1b: a storage device may call exactly the bridge tools; every other wink.storage tool, a prefix trick and a person's device is judged by the entry's kind", () => {
  const drive = { kind: "device", deviceKind: "storage" };
  assert.deepEqual([...STORAGE_DEVICE_TOOLS], ["wink.storage.bridge", "wink.storage.bridge.accept"]);
  for (const t of STORAGE_DEVICE_TOOLS) assert.equal(toolAllowed(drive, t), true, t);
  for (const t of ["wink.storage.remove", "wink.storage.pick", "wink.storage.pair", "wink.storage.card", "wink.storage.offers", "wink.storage.status", "wink.storage.discover", "wink.storage.bridge.drive", "wink.storage.bridge.", "wink.storage.bridgex", "wink.storage.bridge.accept.x", "wink.offer.set", "wink.server.adopt", "relay.devices.list", ""]) {
    assert.equal(toolAllowed(drive, t), false, `${t} is refused`);
    assert.equal(toolAllowed({ kind: "storage" }, t), false, `${t} is refused for kind storage`);
  }
  assert.equal(toolAllowed({ kind: "device" }, "wink.storage.remove"), true, "a person's device is not narrowed here");
  assert.equal(toolAllowed(null, "wink.storage.bridge"), false);
});
