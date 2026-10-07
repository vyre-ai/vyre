// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "../../../test/scratch.mjs";
import { createHost } from "./host.js";
import { peerSession } from "./peer-wire.js";

const FWD = path.join(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-forwarder.js");
const b64u = b => Buffer.from(b).toString("base64url");
/** A device key as the identity list holds it: an Ed25519 key, `pub` raw base64url. */
function deviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: b64u(publicKey.export({ format: "der", type: "spki" }).subarray(-32)), sign: m => b64u(crypto.sign(null, m, privateKey)) };
}
const HOME_NK = "nodekey:" + "11".repeat(32), SRV_NK = "nodekey:" + "22".repeat(32);

function scratch(name) { return fs.mkdtempSync(path.join(SCRATCH, `h-${name}-`)); }

/** A home host and a server host wired through the fake forwarder, the way two machines would be. */
async function world(t, { entries = new Map(), key = deviceKey(), listed = true,  blackhole = false, graceMs = 150, retryMs = 60_000, peers = null, hostOpts = {}, relayServe = null, serveWith = null } = {}) {
  const homeRoot = scratch("home"), srvRoot = scratch("srv");
  const calls = /** @type {any[]} */ ([]);
  if (listed) entries.set("srv1", { eid: "srv1", kind: "device", pub: key.pub });
  const identity = { entry: async eid => entries.get(eid) || null };
  const home = createHost({ root: homeRoot, forwarderBin: FWD, spawn: (bin, args, o) => spawnFake(bin, args, { ...o.env, FAKE_NODEKEY: HOME_NK }) });
  home.addSpace({ id: "harlow", controlUrl: "http://127.0.0.1:1", hostname: "home", box: "box1", peerPort: 8443 });
  const routes = { "100.64.0.1:8443": home.peerSock("harlow") };
  const relayHooks = { opened: 0, fail: false };
  const server = createHost({ root: srvRoot, forwarderBin: FWD, graceMs, retryMs, ...hostOpts,
    spawn: (bin, args, o) => spawnFake(bin, args, { ...o.env, FAKE_NODEKEY: SRV_NK, FAKE_ROUTES: JSON.stringify(routes), ...(blackhole ? { FAKE_BLACKHOLE: "1" } : {}) }),
    device: { id: "srv1", sign: key.sign },
    relayPeer: async () => {
      relayHooks.opened++;
      if (relayHooks.fail) throw new Error("relay is down");
      // a relay peer stream is a pipe to the home's acceptRelay; model it with a socket pair
      const net = await import("node:net");
      const [a, b] = await pairSockets(net);
      const fakeStream = streamOver(b);
      home.acceptRelay("harlow")(fakeStream, { deviceId: "srv1" });
      return (await import("./peer-wire.js")).socketPipe(a);
    } });
  server.addSpace({ id: "harlow", controlUrl: "http://127.0.0.1:1", hostname: "srv", box: "box1", peerAddr: "100.64.0.1:8443" });
  await home.start("harlow");
  await server.start("harlow");
  const serveFn = async (caller, tool, input) => { calls.push({ caller, tool, input }); if (serveWith) serveWith(caller); return { tool, input, caller }; };
  await home.serveHome("harlow", { identity, ...(peers ? { peers } : {}), serve: serveFn, ...(relayServe ? { relayServe } : {}) });
  t.after(async () => { await server.stopAll(); await home.stopAll(); });
  return { home, server, calls, relayHooks, entries, key };
}

import { spawn } from "node:child_process";
/** A real session pair over a socket pair: `client` is the dialled direct session, `home` answers, and `freeze()` makes the home go silent. */
async function answeringPair() {
  const net = await import("node:net");
  const { socketPipe } = await import("./peer-wire.js");
  const [a, b] = await pairSockets(net);
  const home = peerSession(socketPipe(b), { first: 2, serve: async (tool, input) => ({ tool, input, caller: "device:srv1", via: "direct" }) });
  const client = peerSession(socketPipe(a), { first: 1 });
  return { client, home, freeze: () => b.pause() };
}
function spawnFake(bin, args, env) { return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env }); }
async function pairSockets(net) {
  const srv = net.createServer(); await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const a = net.connect(srv.address().port, "127.0.0.1"); const b = await new Promise(r => srv.once("connection", r));
  await new Promise(r => a.once("connect", r)); srv.close(); return [a, b];
}
/** The slice of a relay Stream that streamPipe uses, over a socket. */
function streamOver(sock) {
  const s = { ch: { transport: {} }, ondata: () => {}, onend: () => {}, onreset: () => {}, write: b => sock.write(b), end: () => sock.end(), reset: () => sock.destroy() };
  sock.on("data", b => s.ondata(b)); sock.on("end", () => s.onend()); sock.on("close", () => s.onreset("closed"));
  return s;
}

test("host: a paired server's call reaches the home over the direct path, as device:<id>", async t => {
  const w = await world(t);
  const link = w.server.connect("harlow");
  const r = await link.call("about.text", { q: 1 });
  assert.deepEqual(r, { tool: "about.text", input: { q: 1 }, caller: "device:srv1" });
  assert.equal(link.status().path, "direct");
  assert.equal(w.relayHooks.opened, 0, "the relay was never opened");
  assert.ok((await link.ping()) !== null);
  link.close();
});

test("host: with the direct path blackholed the relay peer stream starts after the grace time and carries the call", async t => {
  const w = await world(t, { blackhole: true, graceMs: 200 });
  const link = w.server.connect("harlow");
  const t0 = Date.now();
  const r = await link.call("about.text", { via: "relay" });
  assert.equal(r.caller, "device:srv1");
  assert.equal(link.status().path, "relay");
  assert.ok(Date.now() - t0 >= 180 && Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.equal(link.status().direct, "trying", "the direct dial is still being tried");
  link.close();
});

test("host: no path at all fails with a clear error and never hangs past the timeout", async t => {
  const w = await world(t, { blackhole: true, graceMs: 50 });
  w.relayHooks.fail = true;
  const link = w.server.connect("harlow");
  await assert.rejects(link.call("about.text", {}, { timeoutMs: 600 }), e => e.code === "unreachable" && /direct trying, relay failed/.test(e.message));
  link.close();
});

test("host: a failed direct dial starts the relay at once, and the direct path is preferred once it is up", async t => {
  const w = await world(t, { graceMs: 5000, retryMs: 300 });
  // break the direct route first: the dial answers 'no path', so the relay must not wait for the grace time
  const link = w.server.connect("harlow", { dial: async () => { throw Object.assign(new Error("context deadline exceeded"), { code: "unreachable" }); } });
  const t0 = Date.now();
  assert.equal((await link.call("about.text", {})).caller, "device:srv1");
  assert.ok(Date.now() - t0 < 1500, "the relay did not wait for the 5 s grace");
  assert.equal(link.status().path, "relay");
  link.close();
  // and with a good direct path later: a link that starts on the relay moves to direct when it comes up
  let allow = false;
  const real = () => w.server.connect("harlow");
  void real;
  const l2 = w.server.connect("harlow", { dial: async () => { if (!allow) throw new Error("no path"); return (await answeringPair()).client; } });
  await l2.call("about.text", {});
  assert.equal(l2.status().path, "relay");
  allow = true;
  await new Promise(r => setTimeout(r, 900));
  assert.equal(l2.status().path, "direct", "direct is preferred as soon as it is up");
  l2.close();
});

test("host: a device that is not on the identity list, or whose key is not the entry's, is not admitted on the direct path, and a removed one is refused at its next call", async t => {
  // no entry for the device: refused, nothing served
  const w = await world(t, { graceMs: 100, listed: false });
  const link = w.server.connect("harlow", { dial: undefined });
  await assert.rejects(link.call("about.text", {}, { timeoutMs: 1500 }), e => e.code === "unreachable");
  assert.equal(w.calls.length, 0, "nothing was served to a device with no entry");
  link.close();
  // an entry holding another key: the device's signature does not verify
  const w2 = await world(t, { graceMs: 100, listed: false, entries: new Map([["srv1", { eid: "srv1", kind: "device", pub: deviceKey().pub }]]) });
  const l2 = w2.server.connect("harlow");
  // the relay stream is admitted by the channel's own proof of the same eid (the entry exists), so the call may be served there; direct is never up
  await l2.call("about.text", {}).catch(() => {});
  assert.notEqual(l2.status().direct, "up", "a key that is not the entry's proves nothing on the direct path");
  assert.ok(w2.calls.every(c => c.caller === "device:srv1"));
  l2.close();
});

test("host: a device removed from the list after admission is refused at its very next call, direct and relay", async t => {
  const w = await world(t, { graceMs: 5000 });
  const link = w.server.connect("harlow");
  assert.equal((await link.call("about.text", {})).caller, "device:srv1");
  assert.equal(link.status().path, "direct");
  w.entries.delete("srv1");
  await assert.rejects(link.call("about.text", {}, { timeoutMs: 1500 }), e => e.code === "denied" || e.code === "unreachable");
  const n = w.calls.length;
  // the relay door reads the entry on each call as well
  const stream = (await import("node:net"));
  const [x, y] = await pairSockets(stream);
  const { socketPipe } = await import("./peer-wire.js");
  w.home.acceptRelay("harlow")(streamOver(y), { deviceId: "srv1" });
  const c = peerSession(socketPipe(x), { first: 1 });
  await assert.rejects(c.call("about.text", {}), e => e.code === "denied" || e.code === "unreachable");
  assert.equal(w.calls.length, n, "a removed device is served nothing on either path");
  link.close();
});

test("host: no forwarder program is a clear error, and a failing node start reports why", async t => {
  const h = createHost({ root: scratch("nf") });
  h.addSpace({ id: "harlow", controlUrl: "http://127.0.0.1:1", hostname: "x", box: "b" });
  await assert.rejects(h.start("harlow"), e => e.code === "unavailable");
  const f = createHost({ root: scratch("ff"), forwarderBin: FWD, spawn: (bin, args, o) => spawnFake(bin, args, { ...o.env, FAKE_FAIL_START: "1" }) });
  f.addSpace({ id: "harlow", controlUrl: "http://127.0.0.1:1", hostname: "x", box: "b" });
  await assert.rejects(f.start("harlow"), /no control/);
  assert.throws(() => h.addSpace({ id: "../x", controlUrl: "u", hostname: "x", box: "b" }), /space id/);
});

test("host: the dial socket is private (0600 in a 0700 directory)", async t => {
  const w = await world(t);
  const sock = w.server.dialSock("harlow");
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
});

test("host: with the Wink module's peers, the wrapper serves the proven device and the pairing record no longer binds a node key", async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createPairing, MIGRATIONS, PEER_MIGRATIONS } = await import("../pairing.js");
  const db = new DatabaseSync(":memory:");
  for (const m of [...MIGRATIONS, ...PEER_MIGRATIONS]) db.exec(m);
  const ME = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pairing = createPairing({ ctx: { store: { db }, config: {}, log() {}, events: { emit() {} }, tool() {} }, now: Date.now, identity: async () => ME, space: async () => "harlow", directory: { memberships: async () => [] }, ports: {}, openCode: async () => ({}), ack: async () => ({ ok: true }), owner: () => {}, relayUrl: async () => "", spaceNow: () => "harlow" });
  pairing.devices.add({ id: "srv1", identity: ME, kind: "server", name: "juno", target: { kind: "identity", id: ME } });
  const w = await world(t, { peers: pairing.peers });
  const link = w.server.connect("harlow");
  const r = await link.call("about.text", { q: 1 });
  assert.equal(r.caller, "device:srv1");
  const row = pairing.devices.get("srv1");
  assert.equal(row.nodeKey, null, "the node key is signed into the proof now; the pairing record binds nothing");
  link.close();
});

test("host: a call over the relay peer stream is served as the device and binds no node key", async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createPairing, MIGRATIONS, PEER_MIGRATIONS } = await import("../pairing.js");
  const db = new DatabaseSync(":memory:");
  for (const m of [...MIGRATIONS, ...PEER_MIGRATIONS]) db.exec(m);
  const ME = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pairing = createPairing({ ctx: { store: { db }, config: {}, log() {}, events: { emit() {} }, tool() {} }, now: Date.now, identity: async () => ME, space: async () => "harlow", directory: { memberships: async () => [] }, ports: {}, openCode: async () => ({}), ack: async () => ({ ok: true }), owner: () => {}, relayUrl: async () => "", spaceNow: () => "harlow" });
  pairing.devices.add({ id: "srv1", identity: ME, kind: "server", name: "juno", target: { kind: "identity", id: ME } });
  const w = await world(t, { peers: pairing.peers, blackhole: true, graceMs: 100 });
  const link = w.server.connect("harlow");
  assert.equal((await link.call("about.text", {})).caller, "device:srv1");
  assert.equal(link.status().path, "relay");
  assert.equal(pairing.devices.get("srv1").nodeKey, null, "the relay path carries no node key");
  link.close();
});

test("host: direct says up only after a ping round trip; a session that answers nothing is not up and the relay carries the call", async t => {
  const w = await world(t, { graceMs: 5000, retryMs: 60_000, hostOpts: { pingMs: 150 } });
  const silent = () => peerSession({ write() {}, end() {}, destroy() {}, buffered: () => 0, ondata() {}, onclose() {} }, { first: 1 });
  const link = w.server.connect("harlow", { dial: async () => silent() });
  const r = await link.call("about.text", {});
  assert.equal(r.caller, "device:srv1");
  assert.equal(link.status().path, "relay");
  assert.notEqual(link.status().direct, "up");
  assert.match(String(link.status().lastError), /did not answer/);
  link.close();
});

test("host: a direct path that died quietly is noticed by the probe before a call, and the call goes to the relay", async t => {
  const w = await world(t, { graceMs: 5000, retryMs: 60_000, hostOpts: { probeMs: 100, probeWaitMs: 150 } });
  let pair;
  const link = w.server.connect("harlow", { dial: async () => { pair = await answeringPair(); return pair.client; } });
  assert.equal((await link.call("about.text", {})).via, "direct");
  assert.equal(link.status().path, "direct");
  pair.freeze();
  await new Promise(r => setTimeout(r, 130));
  const r = await link.call("about.text", { again: 1 });
  assert.equal(r.caller, "device:srv1");
  assert.equal(link.status().path, "relay", "the call was answered over the relay stream");
  link.close();
});

test("host: a direct call with no answer races to the relay after raceMs and is retried there once", async t => {
  const w = await world(t, { graceMs: 5000, retryMs: 60_000, hostOpts: { probeMs: 3_600_000, raceMs: 250, probeWaitMs: 150 } });
  let pair;
  const link = w.server.connect("harlow", { dial: async () => { pair = await answeringPair(); return pair.client; } });
  await link.call("about.text", {});
  pair.freeze();
  const t0 = Date.now();
  const r = await link.call("about.text", { slow: 1 });
  assert.equal(r.caller, "device:srv1");
  assert.equal(link.status().path, "relay");
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  link.close();
});

test("host: a call that is only slow (the path still answers a ping) is not moved off the direct path", async t => {
  const w = await world(t, { graceMs: 5000, hostOpts: { probeMs: 3_600_000, raceMs: 100, probeWaitMs: 300 } });
  const net = await import("node:net");
  const { socketPipe } = await import("./peer-wire.js");
  const [a, b] = await pairSockets(net);
  peerSession(socketPipe(b), { first: 2, serve: async () => { await new Promise(r => setTimeout(r, 500)); return { slow: true }; } });
  const link = w.server.connect("harlow", { dial: async () => peerSession(socketPipe(a), { first: 1 }) });
  assert.deepEqual(await link.call("about.text", {}), { slow: true });
  assert.equal(link.status().path, "direct");
  assert.equal(w.relayHooks.opened, 0);
  link.close();
});

test("host: the relay door has its own dispatcher, so the chain can record the path as relay", async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createPairing, MIGRATIONS, PEER_MIGRATIONS } = await import("../pairing.js");
  const db = new DatabaseSync(":memory:");
  for (const m of [...MIGRATIONS, ...PEER_MIGRATIONS]) db.exec(m);
  const ME = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pairing = createPairing({ ctx: { store: { db }, config: {}, log() {}, events: { emit() {} }, tool() {} }, now: Date.now, identity: async () => ME, space: async () => "harlow", directory: { memberships: async () => [] }, ports: {}, openCode: async () => ({}), ack: async () => ({ ok: true }), owner: () => {}, relayUrl: async () => "", spaceNow: () => "harlow" });
  pairing.devices.add({ id: "srv1", identity: ME, kind: "server", name: "juno", target: { kind: "identity", id: ME } });
  const w = await world(t, { peers: pairing.peers, blackhole: true, graceMs: 100, relayServe: async (caller, tool, input) => ({ caller, tool, path: "relay" }) });
  const link = w.server.connect("harlow");
  const r = await link.call("about.text", {});
  assert.equal(r.path, "relay");
  assert.equal(w.calls.length, 0, "the direct dispatcher was not used for the relay peer");
  link.close();
});

test("host.pathOf: the leg a call really arrived on, taken from the door: direct is wink, the relay stream is relay, outside any door is relay", async t => {
  const seen = [];
  let h;
  const relayServe = async (c, tool) => { seen.push(["relay-door", h.pathOf(c)]); return { tool, caller: c }; };
  const peers = { serve: inner => async (c, tool, input) => inner(c, tool, input) };
  const w = await world(t, { peers, relayServe, blackhole: true, graceMs: 100 });
  h = w.home;
  assert.equal(h.pathOf("device:srv1"), "relay", "no door around it: unknown is relay");
  assert.equal(w.home.pathOf(), "relay");
  const link = w.server.connect("harlow");
  await link.call("about.text", {});
  assert.equal(link.status().path, "relay");
  assert.deepEqual(seen, [["relay-door", "relay"]]);
  link.close();
});

test("host.pathOf: a call over the direct door reports wink", async t => {
  const seen = [];
  let h;
  const peers = { serve: inner => async (c, tool, input) => inner(c, tool, input) };
  const w = await world(t, { peers, serveWith: c => seen.push(h.pathOf(c)) });
  h = w.home;
  const link = w.server.connect("harlow");
  await link.call("about.text", {});
  assert.equal(link.status().path, "direct");
  assert.deepEqual(seen, ["wink"]);
  link.close();
});

test("host D-1 and D-1b: a storage device's session may call only the exact bridge tools on the home, on the direct door and on the relay door; nothing else reaches the registry", async t => {
  const w = await world(t, { listed: false });
  w.entries.set("srv1", { eid: "srv1", kind: "device", deviceKind: "storage", pub: w.key.pub });
  const link = w.server.connect("harlow");
  assert.equal((await link.call("wink.storage.bridge", { x: 1 })).caller, "device:srv1", "a storage call is served");
  assert.equal(link.status().path, "direct");
  for (const tool of ["about.text", "identity.sign", "wink.server.handover", "wink.pair.server", "wink.storagex.bridge", "chat.send",
    // D-1b: the rest of the wink.storage.* namespace is a person's
    "wink.storage.remove", "wink.storage.pick", "wink.storage.pair", "wink.storage.card", "wink.storage.offers", "wink.storage.status", "wink.storage.discover", "wink.storage.bridge.drive", "wink.storage.bridge.x"]) {
    await assert.rejects(link.call(tool, {}, { timeoutMs: 1500 }), e => e.code === "denied", `${tool} is refused for a storage device`);
  }
  assert.deepEqual(w.calls.map(c => c.tool), ["wink.storage.bridge"], "only the storage call reached the registry");
  const net = await import("node:net");
  const [x, y] = await pairSockets(net);
  const { socketPipe } = await import("./peer-wire.js");
  w.home.acceptRelay("harlow")(streamOver(y), { deviceId: "srv1" });
  const c = peerSession(socketPipe(x), { first: 1 });
  assert.equal((await c.call("wink.storage.bridge", {})).caller, "device:srv1");
  await assert.rejects(c.call("about.text", {}), e => e.code === "denied");
  await assert.rejects(c.call("chat.send", {}), e => e.code === "denied");
  for (const tool of ["wink.storage.remove", "wink.storage.pick", "wink.storage.pair", "wink.storage.bridge.drive"]) await assert.rejects(c.call(tool, {}), e => e.code === "denied", `${tool} is refused on the relay door too`);
  assert.deepEqual(w.calls.map(c => c.tool), ["wink.storage.bridge", "wink.storage.bridge"]);
  // the kind comes from the entry on every call: the same session, a person's device entry, may call anything
  w.entries.set("srv1", { eid: "srv1", kind: "device", pub: w.key.pub });
  assert.equal((await link.call("about.text", {})).caller, "device:srv1");
  c.close(); link.close();
});

test("host P-1: a link that is up creates no recurring timer under 60 s, and a call after a long silence is pinged first (on demand)", async t => {
  const made = [];
  const realSet = globalThis.setInterval;
  globalThis.setInterval = (f, ms, ...a) => { made.push(ms); return realSet(f, ms, ...a); };
  let w;
  try {
    w = await world(t, { graceMs: 5000, retryMs: 60_000, hostOpts: { probeMs: 50, probeWaitMs: 150 } });
    const link = w.server.connect("harlow");
    assert.equal((await link.call("about.text", {})).caller, "device:srv1");
    await new Promise(r => setTimeout(r, 400));
    assert.deepEqual(made.filter(ms => ms < 60_000), [], "no recurring timer under 60 s while the link is up and idle");
    // silent longer than probeMs: the next call pings first, and goes through
    assert.equal((await link.call("about.text", { again: true })).caller, "device:srv1");
    link.close();
  } finally { globalThis.setInterval = realSet; }
});

test("host.status and host.whois: the home sees an admitted peer by id and by address, the server sees its link, and a closed peer is gone", async t => {
  const w = await world(t);
  const link = w.server.connect("harlow");
  await link.call("about.text", {});
  const hs = w.home.status();
  assert.deepEqual([hs[0].id, hs[0].node, hs[0].door], ["harlow", "up", "listening"]);
  assert.deepEqual(hs[0].peers.map(p => [p.eid, p.via]), [["srv1", "direct"]]);
  const who = w.home.whois({ eid: "srv1" });
  assert.deepEqual([who?.eid, who?.space, who?.via], ["srv1", "harlow", "direct"]);
  if (who?.addr) assert.equal(w.home.whois({ addr: `${who.addr}:12345` })?.eid, "srv1", "a port on the address is ignored");
  assert.equal(w.home.whois({ eid: "nobody" }), null);
  assert.equal(w.home.whois({}), null);
  const ss = w.server.status();
  assert.equal(ss[0].links.length, 1);
  assert.equal(ss[0].links[0].path, "direct");
  link.close();
  assert.equal(w.server.status()[0].links.length, 0, "a closed link is not listed");
});
