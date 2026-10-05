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
  const j = createNetJoin({ root: root(), ownHandover: () => ({ relay: "x", device: "d" }), deps: { createHost: fakeHost(calls), findBinaries: () => ({ forwarder: "/bin/fwd" }) } });
  await j.start();
  assert.equal(j.status().state, "none");
  assert.deepEqual(calls, []);
});

test("a hand-over with controlUrl, key, node name and door joins as that name and dials the door", async () => {
  const calls = /** @type {string[]} */ ([]);
  const j = createNetJoin({ root: root(), ownHandover: () => HAND, deps: { createHost: fakeHost(calls), findBinaries: () => ({ forwarder: "/bin/fwd" }) } });
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
  const j = createNetJoin({ root: root(), ownHandover: () => h, deps: { createHost: fakeHost(calls), findBinaries: () => ({ forwarder: "/bin/fwd" }) } });
  await j.start();
  h = null;
  await j.refresh();
  assert.equal(j.status().state, "none");
  assert.ok(calls.includes("stopAll") && calls.includes("link.close"));
  assert.throws(() => j.call("x", {}), /no link/);
});

test("no node program: no-binary, the relay carries everything; a failed join says why and is torn down", async () => {
  const calls = /** @type {string[]} */ ([]);
  const a = createNetJoin({ root: root(), ownHandover: () => HAND, deps: { createHost: fakeHost(calls), findBinaries: () => ({ forwarder: null }) } });
  await a.start();
  assert.equal(a.status().state, "no-binary");
  const b = createNetJoin({ root: root(), ownHandover: () => HAND, deps: { createHost: fakeHost(calls, { fail: true }), findBinaries: () => ({ forwarder: "/bin/fwd" }) } });
  await b.start();
  assert.equal(b.status().state, "failed");
  assert.match(String(b.status().why), /did not come up/);
  assert.ok(calls.includes("stopAll"));
});
