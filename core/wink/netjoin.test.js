// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createNetJoin } from "./netjoin.js";
import { directKey } from "./directkey.js";
import { authMessage, verifyDevice } from "./node/peer-wire.js";

const SECRET = crypto.randomBytes(32).toString("base64url");
const HAND = { controlUrl: "http://10.0.0.5:7443", authKey: "k", hostname: "w-abc", space: "spc_one", device: "dev1", box: "boxa", peerAddr: "100.99.1.1:8443", peerSecret: SECRET };

const fakeHost = (/** @type {string[]} */ calls, /** @type {any} */ o = {}) => (/** @type {any} */ deps) => {
  calls.push("createHost");
  return {
    deps,
    addSpace: (/** @type {any} */ s) => { calls.push(`add ${s.hostname} ${s.controlUrl} ${s.peerAddr}`); },
    start: async () => { if (o.fail) throw new Error("the node did not come up"); calls.push("start"); return { ips: ["100.99.1.2"] }; },
    connect: () => ({ close: () => calls.push("link.close"), status: () => ({ state: "up", path: "direct" }), call: async (/** @type {string} */ t) => ({ t }) }),
    stopAll: async () => { calls.push("stopAll"); },
  };
};
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "nj-"));

test("the direct key is derived from the peer secret: the home derives the same public key and verifies the server's proof", () => {
  const a = directKey(SECRET), b = directKey(SECRET), c = directKey(crypto.randomBytes(32).toString("base64url"));
  assert.equal(a.pub, b.pub);
  assert.notEqual(a.pub, c.pub);
  const msg = authMessage("n", "nodekey", "boxa", "dev1");
  assert.equal(verifyDevice(a.pub, msg, a.sign(msg)), true);
  assert.equal(verifyDevice(a.pub, msg, c.sign(msg)), false);
});

test("a server that was handed no network stays on the relay: state none, nothing started", async () => {
  const calls = /** @type {string[]} */ ([]);
  const j = createNetJoin({ settleMs: 0, root: root(), ownHandover: () => ({ relay: "x", device: "d" }), deps: { createHost: fakeHost(calls), findBinaries: () => ({ forwarder: "/bin/fwd" }) } });
  await j.start();
  assert.equal(j.status().state, "none");
  assert.deepEqual(calls, []);
});

test("a hand-over with controlUrl, key, node name and door joins as that name and dials the door", async () => {
  const calls = /** @type {string[]} */ ([]);
  const j = createNetJoin({ settleMs: 0, root: root(), ownHandover: () => HAND, deps: { createHost: fakeHost(calls), findBinaries: () => ({ forwarder: "/bin/fwd" }) } });
  await j.start();
  assert.equal(j.status().state, "up");
  assert.deepEqual(calls, ["createHost", "add w-abc http://10.0.0.5:7443 100.99.1.1:8443", "start"]);
  assert.equal(j.status().link.path, "direct");
  assert.deepEqual(await j.call("about.text", {}), { t: "about.text" });
  await j.refresh();
  assert.equal(calls.filter(c => c === "createHost").length, 1, "the same hand-over does not join twice");
  await j.stop();
  assert.ok(calls.includes("stopAll"));
});

test("a release (no hand-over any more) leaves the network", async () => {
  const calls = /** @type {string[]} */ ([]);
  let h = /** @type {any} */ (HAND);
  const j = createNetJoin({ settleMs: 0, root: root(), ownHandover: () => h, deps: { createHost: fakeHost(calls), findBinaries: () => ({ forwarder: "/bin/fwd" }) } });
  await j.start();
  h = null;
  await j.refresh();
  assert.equal(j.status().state, "none");
  assert.ok(calls.includes("stopAll") && calls.includes("link.close"));
  assert.throws(() => j.call("x", {}), /no link/);
});

test("no node program: no-binary, the relay carries everything; a failed join says why and is torn down", async () => {
  const calls = /** @type {string[]} */ ([]);
  const a = createNetJoin({ settleMs: 0, root: root(), ownHandover: () => HAND, deps: { createHost: fakeHost(calls), findBinaries: () => ({ forwarder: null }) } });
  await a.start();
  assert.equal(a.status().state, "no-binary");
  const b = createNetJoin({ settleMs: 0, root: root(), ownHandover: () => HAND, deps: { createHost: fakeHost(calls, { fail: true }), findBinaries: () => ({ forwarder: "/bin/fwd" }) } });
  await b.start();
  assert.equal(b.status().state, "failed");
  assert.match(String(b.status().why), /did not come up/);
  assert.ok(calls.includes("stopAll"));
});

// ---- the relay fallback: the home's route and key in the hand-over, this server's own relay key derived from the peer secret ----
const RELAY = { relay: "wss://relay.example", route: "abcdefghijklmnopqrstuvwxyz".slice(0, 26), box: crypto.randomBytes(32).toString("base64url") };
/** a stand-in relay client: records how it was dialled and answers a peer stream with 200 */
const fakeConnect = (/** @type {any[]} */ dials, /** @type {{ status?: number }} */ o = {}) => (/** @type {any} */ opts) => {
  dials.push(opts);
  return { ready: async () => ({ open: (/** @type {any} */ head) => { dials.push({ head }); const s = /** @type {any} */ ({ write() {}, end() {}, reset() {} }); setTimeout(() => s.onhead && s.onhead({ status: o.status ?? 200 }), 0); return s; } }), close: () => dials.push("close") };
};

test("with a relay way back and no node program, the server links through the relay alone (state up, not no-binary)", async () => {
  const calls = /** @type {string[]} */ ([]);
  /** @type {any[]} */ const hosts = [];
  const mk = (/** @type {any} */ deps) => { hosts.push(deps); return fakeHost(calls)(deps); };
  const j = createNetJoin({ settleMs: 0, root: root(), ownHandover: () => ({ ...HAND, ...RELAY }), deps: { createHost: mk, findBinaries: () => ({ forwarder: null }) } });
  await j.start();
  assert.equal(j.status().state, "up");
  assert.match(String(j.status().why), /relay carries everything/);
  assert.equal(hosts[0].forwarderBin, undefined, "no node program is started");
  assert.equal(typeof hosts[0].relayPeer, "function");
  assert.ok(!calls.includes("start"), "the node is not started");
  await j.stop();
});

test("a hand-over with only the relay (no network address) links through the relay", async () => {
  const calls = /** @type {string[]} */ ([]);
  /** @type {any[]} */ const hosts = [];
  const j = createNetJoin({ settleMs: 0, root: root(), ownHandover: () => ({ space: "spc_one", device: "dev1", peerSecret: SECRET, ...RELAY }), deps: { createHost: (/** @type {any} */ d) => { hosts.push(d); return fakeHost(calls)(d); }, findBinaries: () => ({ forwarder: "/bin/fwd" }) } });
  await j.start();
  assert.equal(j.status().state, "up");
  assert.deepEqual(calls.filter(c => c.startsWith("add")), ["add relay-only http://127.0.0.1:1 undefined"]);
  assert.ok(!calls.includes("start"));
  await j.stop();
});

test("the relay leg dials the home's route with the key derived from the peer secret and opens a wink peer stream on the home door", async () => {
  /** @type {any[]} */ const hosts = [];
  /** @type {any[]} */ const dials = [];
  const j = createNetJoin({ settleMs: 0, root: root(), ownHandover: () => ({ ...HAND, ...RELAY }), deps: { createHost: (/** @type {any} */ d) => { hosts.push(d); return fakeHost([])(d); }, findBinaries: () => ({ forwarder: "/bin/fwd" }), relayConnect: fakeConnect(dials) } });
  await j.start();
  const pipe = await hosts[0].relayPeer("spc_one");
  assert.ok(pipe, "a pipe comes back once the home answered 200");
  const o = dials.find(d => d && d.route);
  assert.equal(o.relay, RELAY.relay);
  assert.equal(o.route, RELAY.route);
  assert.equal(o.box, RELAY.box);
  const keys = await o.keyStore.get();
  const { relayKeyPair } = await import("./directkey.js");
  assert.deepEqual(keys.publicKey, relayKeyPair(SECRET).publicKey, "the home can name this key without being told it");
  assert.deepEqual(dials.find(d => d && d.head).head, { peer: "wink", space: "home" });
  await j.stop();
  assert.ok(dials.includes("close"), "leaving closes the relay connection");
});

test("a home that refuses the peer stream says so (denied), it is not a hang", async () => {
  /** @type {any[]} */ const hosts = [];
  const j = createNetJoin({ settleMs: 0, root: root(), ownHandover: () => ({ ...HAND, ...RELAY }), deps: { createHost: (/** @type {any} */ d) => { hosts.push(d); return fakeHost([])(d); }, findBinaries: () => ({ forwarder: "/bin/fwd" }), relayConnect: fakeConnect([], { status: 403 }) } });
  await j.start();
  await assert.rejects(() => hosts[0].relayPeer("spc_one"), /refused the peer stream \(403\)/);
  await j.stop();
});
