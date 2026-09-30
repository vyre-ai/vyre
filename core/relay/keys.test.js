// @ts-check
// loadKeys(root), on its own: made on first use, 0600/0700, round-trips, and a genuinely
// unreadable file (not just missing) fails loudly rather than minting a fresh identity over it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadKeys, keyHandle } from "./keys.js";
import { dh } from "./noise.js";
import { authMessage } from "./wire.js";
import { fakeCoreKeys } from "../../test/fake-core-keys.js";
import { tempHome } from "../../test/helpers.js";

test("relay keys: made on first use, 0600/0700, and the same root loads the same keys back", t => {
  const root = tempHome(t);
  const first = loadKeys(root);
  const file = path.join(root, "relay", "keys.json");
  assert.equal(fs.statSync(path.join(root, "relay")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = loadKeys(root);
  assert.deepEqual(again.box.priv, first.box.priv);
  assert.deepEqual(again.box.pub, first.box.pub);
  assert.deepEqual(again.route.priv, first.route.priv);
  assert.deepEqual(again.route.pub, first.route.pub);
});

test("relay keys: two different roots never share a key", t => {
  const a = loadKeys(tempHome(t)), b = loadKeys(tempHome(t));
  assert.notDeepEqual(a.box.priv, b.box.priv);
});

test("relay keys: a file that exists but is not readable fails loudly, never minting a fresh identity silently", t => {
  const root = tempHome(t);
  const dir = path.join(root, "relay");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "keys.json"), "not json", { mode: 0o600 });
  assert.throws(() => loadKeys(root), /relay keys unreadable/);
});

test("key handle, file-backed: pubs throw before ready, then match the file; dh and sign agree with the bytes", async t => {
  const root = tempHome(t);
  const h = keyHandle({ root });
  assert.equal(h.core, false);
  assert.equal(await h.exists(), false);
  assert.throws(() => h.box.pub, /not loaded/);
  await h.ready();
  const k = loadKeys(root);
  assert.deepEqual(h.box.pub, k.box.pub);
  assert.deepEqual(h.route.pub, k.route.pub);
  assert.equal(await h.exists(), true);
  const other = crypto.generateKeyPairSync("x25519");
  const remote = other.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  assert.deepEqual(await h.box.dh(remote), dh(k.box.priv, remote));
  const msg = authMessage("route", Buffer.from("n"));
  const spki = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), h.route.pub]), format: "der", type: "spki" });
  assert.ok(crypto.verify(null, msg, spki, await h.route.sign(msg)));
});

test("key handle, core-backed: nothing is written under the root, keys are made only by ready(), and every operation goes to core", async t => {
  const root = tempHome(t);
  const core = fakeCoreKeys({ made: false });
  const h = keyHandle({ root, core });
  assert.equal(h.core, true);
  assert.equal(await h.exists(), false);
  assert.equal(core.calls.ensure, 0, "asking whether keys exist makes none");
  await Promise.all([h.ready(), h.ready()]);
  assert.equal(core.calls.ensure, 1, "concurrent readies make one call");
  assert.equal(h.loaded, true);
  assert.equal(fs.existsSync(path.join(root, "relay")), false, "no key file at the person's uid");
  const other = crypto.generateKeyPairSync("x25519");
  const remote = other.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  assert.equal((await h.box.dh(remote)).length, 32);
  const msg = Buffer.from("m");
  const spki = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), h.route.pub]), format: "der", type: "spki" });
  assert.ok(crypto.verify(null, msg, spki, await h.route.sign(msg)));
  assert.deepEqual([core.calls.boxDh, core.calls.routeSign], [1, 1]);
});

test("device key in core: the relay client runs Noise as the initiator with a marker private key, and core answers the DH", async t => {
  const { coreDeviceKey } = await import("./devicekey.js");
  const core = fakeCoreKeys({ made: false });
  const { crypto: c, keyStore } = coreDeviceKey(core);
  const kp = /** @type {any} */ (await keyStore.get());
  assert.equal(kp.publicKey.length, 32);
  assert.ok(!Buffer.isBuffer(kp.privateKey) && !(kp.privateKey instanceof Uint8Array), "the private key is a marker, never bytes");
  const other = crypto.generateKeyPairSync("x25519");
  const remote = other.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const a = await c.dh(kp.privateKey, new Uint8Array(remote));
  const b = crypto.diffieHellman({ privateKey: other.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(kp.publicKey)]), format: "der", type: "spki" }) });
  assert.deepEqual(Buffer.from(a), b, "core's DH is the same X25519 the peer computes");
  assert.equal(core.calls.deviceDh, 1);
  // a raw private key still goes to the ordinary provider
  const fresh = await c.generateKeyPair();
  assert.equal((await c.dh(fresh.privateKey, new Uint8Array(remote))).length, 32);
});

test("the test fake has the real client's surface, so a change to one shows in the other", async () => {
  const real = await import("../../lib/vyre-core-keys.js");
  const a = Object.keys(real.fakeCoreKeys("x")).filter(k => k !== "created").sort();
  const mine = Object.keys(fakeCoreKeys()).filter(k => k !== "calls").sort();
  assert.deepEqual(mine, a);
});
