// @ts-check
// vyre-core phase 5: the relay's keys live in core. The private halves never leave; the client gets
// the public halves, the Noise DH and a route signature, and a model gets none of it.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startCore, notModelOf } from "./server.js";
import { openKeys } from "./keys.js";
import { createCoreKeys, fakeCoreKeys, xPrivateKey, pubRaw } from "../../lib/vyre-core-keys.js";
import { coreTool, coreCall } from "../../lib/vyre-core-client.js";
const coreCallEvents = async (/** @type {string} */ socket) => (await coreCall({ socket, method: "GET", path: "/v1/events?after=0" })).data.events;
import { SCRATCH } from "../../test/scratch.mjs";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;

/** @param {import("node:test").TestContext} t @param {Record<string, any>} [o] */
async function core(t, o = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "c.sock");
  const c = await startCore({ socket, dataDir: path.join(dir, "data"), ownerUid: uid, version: "test", peerCred: async () => ({ pid: process.pid, uid }), notModel: () => true, ...o });
  t.after(() => c.close());
  return { ...c, socket, dir, dataDir: path.join(dir, "data") };
}
const peerKeys = () => crypto.generateKeyPairSync("x25519");
const rawPub = (/** @type {crypto.KeyObject} */ k) => pubRaw(k);

test("keys: ensure makes both once, the file is 0600, and a second store finds the same keys", t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = openKeys(dir);
  assert.equal(a.exists(), false);
  assert.throws(() => a.boxPub(), /keys.ensure first/);
  assert.deepEqual(a.ensure(), { created: true });
  assert.deepEqual(a.ensure(), { created: false });
  assert.equal(fs.statSync(path.join(dir, "keys.json")).mode & 0o777, 0o600);
  const b = openKeys(dir);
  assert.equal(b.exists(), true);
  assert.equal(b.boxPub(), a.boxPub());
  assert.equal(b.routePub(), a.routePub());
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith(".tmp")).length, 0, "no temp file left");
});

test("keys: the DH agrees with the other side's, and a signature verifies under the route pub", t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const k = openKeys(dir); k.ensure();
  const peer = peerKeys();
  const ours = k.boxDh(rawPub(peer.publicKey).toString("base64url"));
  const theirs = crypto.diffieHellman({ privateKey: peer.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(k.boxPub(), "base64url")]), format: "der", type: "spki" }) });
  assert.equal(ours, Buffer.from(theirs).toString("base64url"));
  const msg = Buffer.from("vyre-names-v1\nalex");
  const sig = k.routeSign(msg.toString("base64url"));
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(k.routePub(), "base64url")]), format: "der", type: "spki" });
  assert.ok(crypto.verify(null, msg, pub, Buffer.from(sig, "base64url")));
  assert.ok(!crypto.verify(null, Buffer.from("other"), pub, Buffer.from(sig, "base64url")));
});

test("keys: a low-order public key, a wrong length and an empty message are refused", t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const k = openKeys(dir); k.ensure();
  assert.throws(() => k.boxDh(Buffer.alloc(32).toString("base64url")), /no shared secret/);
  assert.throws(() => k.boxDh(Buffer.alloc(31, 1).toString("base64url")), /32 bytes/);
  assert.throws(() => k.boxDh("not base64!"), /base64url/);
  assert.throws(() => k.routeSign(""), /1 to 4096/);
  assert.throws(() => k.routeSign(Buffer.alloc(4097).toString("base64url")), /1 to 4096/);
});

test("keys: over the socket, a process outside every Claude session gets pubs, dh and signatures; the private bytes are nowhere in an answer", async t => {
  const c = await core(t);
  const keys = createCoreKeys({ socket: c.socket, coreUid: uid });
  assert.equal(await keys.exists(), false);
  assert.equal(await keys.ensure(), true);
  assert.equal(await keys.ensure(), false);
  assert.equal(await keys.exists(), true);
  const pub = await keys.boxPub();
  assert.equal(pub.length, 32);
  assert.deepEqual(await keys.boxPub(), pub);
  const peer = peerKeys();
  const s = await keys.boxDh(rawPub(peer.publicKey));
  const theirs = crypto.diffieHellman({ privateKey: peer.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), pub]), format: "der", type: "spki" }) });
  assert.deepEqual(s, Buffer.from(theirs));
  const rp = await keys.routePub();
  const sig = await keys.routeSign(Buffer.from("hello"));
  assert.equal(sig.length, 64);
  assert.ok(crypto.verify(null, Buffer.from("hello"), crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rp]), format: "der", type: "spki" }), sig));
  // The uses of the key are counted and shown as events.
  const ev = await coreCallEvents(c.socket);
  assert.deepEqual(ev.filter(e => e.type === "keys.used").map(e => [e.payload.tool, e.payload.uses]), [["keys.box.dh", 1], ["keys.route.sign", 2]]);
  // What the store holds never appears in what core said.
  const stored = JSON.parse(fs.readFileSync(path.join(c.dataDir, "keys.json"), "utf8"));
  for (const tool of ["keys.box.pub", "keys.route.pub", "keys.exists"]) {
    const r = await coreTool(tool, {}, { socket: c.socket });
    assert.ok(!JSON.stringify(r).includes(stored.box) && !JSON.stringify(r).includes(stored.route));
  }
});

test("keys: a model's process gets nothing, and there is no tool that returns a private half", async t => {
  const c = await core(t, { notModel: () => false });
  for (const tool of ["keys.exists", "keys.ensure", "keys.box.pub", "keys.box.dh", "keys.route.pub", "keys.route.sign"]) {
    const r = await coreTool(tool, { remote: "AA", message: "AA" }, { socket: c.socket });
    assert.equal(r.status, 403, tool);
    assert.equal(r.error?.code, "not_person_side");
  }
  assert.ok(!fs.existsSync(path.join(c.dataDir, "keys.json")), "a refused ensure made nothing");
  for (const bad of ["keys.box.priv", "keys.export", "keys.route.priv"]) assert.equal((await coreTool(bad, {}, { socket: c.socket })).status, 404);
});

test("keys: a socket someone else owns is not asked for keys, and no core.json means no keys", async t => {
  const c = await core(t);
  const wrongUid = createCoreKeys({ socket: c.socket, coreUid: uid + 12345 });
  await assert.rejects(() => wrongUid.boxPub(), /belongs to uid/);
  await assert.rejects(() => createCoreKeys().boxPub(), /isn't installed here|core_untrusted|no trusted core.json/);
});

test("keys: the fake has the client's shape and the same maths", async () => {
  const f = fakeCoreKeys("alex");
  assert.equal(await f.exists(), false);
  assert.equal(await f.ensure(), true);
  const peer = peerKeys();
  const s = await f.boxDh(rawPub(peer.publicKey));
  const theirs = crypto.diffieHellman({ privateKey: peer.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), await f.boxPub()]), format: "der", type: "spki" }) });
  assert.deepEqual(s, Buffer.from(theirs));
  assert.deepEqual(await fakeCoreKeys("alex").boxPub(), await f.boxPub(), "the seed fixes the identity");
  assert.notDeepEqual(await fakeCoreKeys("kit").boxPub(), await f.boxPub());
  assert.equal((await f.routeSign(Buffer.from("x"))).length, 64);
});

test("keys: notModelOf refuses a claude ancestor and an unreadable chain, and allows a launchd job's leader", () => {
  const table = { 10: { ppid: 1, args: "/usr/local/bin/vyre-serve", pgid: 10, sid: 10 }, 11: { ppid: 10, args: "node main.js", pgid: 10, sid: 10 },
    20: { ppid: 1, args: "claude", pgid: 20, sid: 20 }, 21: { ppid: 20, args: "-zsh", pgid: 20, sid: 20 }, 22: { ppid: 21, args: "node x.js", pgid: 20, sid: 20 },
    30: { ppid: 99, args: "orphan", pgid: 30, sid: 30 } };
  const look = (/** @type {number} */ pid) => /** @type {any} */ (table)[pid] || null;
  assert.equal(notModelOf(22, { look }), false, "inside a claude session");
  assert.equal(notModelOf(11, { look }), true, "a launchd job's own child");
  assert.equal(notModelOf(30, { look }), false, "a chain that can't be read to the top");
});

test("keys: the device key is a separate X25519 key, made once, used through core, and refused to a model", async t => {
  const c = await core(t);
  const keys = createCoreKeys({ socket: c.socket, coreUid: uid });
  assert.equal(await keys.deviceExists(), false);
  await assert.rejects(() => keys.devicePub(), /device key yet/);
  assert.equal(await keys.deviceEnsure(), true);
  assert.equal(await keys.deviceEnsure(), false);
  assert.equal(await keys.deviceExists(), true);
  await keys.ensure();
  const dpub = await keys.devicePub();
  assert.notDeepEqual(dpub, await keys.boxPub(), "not the box's key");
  const peer = peerKeys();
  const s = await keys.deviceDh(rawPub(peer.publicKey));
  const theirs = crypto.diffieHellman({ privateKey: peer.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), dpub]), format: "der", type: "spki" }) });
  assert.deepEqual(s, Buffer.from(theirs));
  assert.equal(fs.statSync(path.join(c.dataDir, "device-key.json")).mode & 0o777, 0o600);
  assert.ok(!(await coreTool("keys.device.pub", {}, { socket: c.socket })).data.pub.includes(JSON.parse(fs.readFileSync(path.join(c.dataDir, "device-key.json"), "utf8")).device));
  const uses = (await coreCallEvents(c.socket)).filter(e => e.type === "keys.used").map(e => e.payload.tool);
  assert.deepEqual(uses, ["keys.device.dh"], "the device DH is counted like the box's");
  const m = await core(t, { notModel: () => false });
  for (const tool of ["keys.device.exists", "keys.device.ensure", "keys.device.pub", "keys.device.dh"]) assert.equal((await coreTool(tool, { remote: "AA" }, { socket: m.socket })).status, 403, tool);
  const f = fakeCoreKeys("alex");
  assert.equal(await f.deviceEnsure(), true);
  assert.equal((await f.devicePub()).length, 32);
  assert.notDeepEqual(await f.devicePub(), await f.boxPub());
  assert.equal((await f.deviceDh(rawPub(peer.publicKey))).length, 32);
});
