// @ts-check
// Pairing a listed server by the identity chain (chain-pairer.js): dial it with a signed chain hello, wait for it to admit this device, and hand back the pairing. A server that does not admit it gets a plain
// refusal that says what to do, never a hang.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeChainPairer } from "./chain-pairer.js";

const entry = { relay: "wss://relay.example.net", route: "r".repeat(26), box: "k".repeat(43), name: "my droplet" };

/** A fake relay client: `outcome` decides how the dial ends. */
function fake(/** @type {"admit" | "refuse" | "hang"} */ outcome) {
  /** @type {any[]} */ const dials = [];
  let closed = 0;
  return {
    dials, get closed() { return closed; },
    connect: (/** @type {any} */ o) => {
      dials.push(o);
      return {
        reply: outcome === "admit" ? { v: 1, box: { name: "b" }, device: "devicedevicedevi" } : null,
        lastError: outcome === "refuse" ? new Error("box closed the connection") : null,
        ready: () => (outcome === "admit" ? Promise.resolve({}) : outcome === "refuse" ? new Promise((_, rej) => setTimeout(() => rej(new Error("box closed the connection")), 5)) : new Promise(() => {})),
        close: () => { closed++; },
      };
    },
  };
}
const deps = (/** @type {any} */ f, over = {}) => ({ connect: f.connect, crypto: {}, keyStore: {}, about: { kind: "app" }, deviceName: () => "my laptop", chainHelloFor: async (/** @type {Uint8Array} */ pub, /** @type {string} */ box, /** @type {string | undefined} */ presencePublicKey) => ({ identity: "per_x", entry: "e", box, pubLen: pub.length, presencePublicKey }), presenceKey: async () => ({ public_key: "PK-SPKI" }), timeoutMs: 60, ...over });

test("a server that admits the device gives back the pairing, with the device id it answered, and the dial is closed", async () => {
  const f = fake("admit");
  const p = await makeChainPairer(deps(f))(entry);
  assert.deepEqual(p, { relay: entry.relay, route: entry.route, box: entry.box, name: "my droplet", device: "devicedevicedevi", presence: null });
  assert.equal(f.closed, 1);
});

test("the dial pins the entry's box key and carries a chain hello made for that box", async () => {
  const f = fake("admit");
  await makeChainPairer(deps(f))(entry);
  const o = f.dials[0];
  assert.equal(o.box, entry.box);
  assert.equal(o.route, entry.route);
  const h = await o.chainHello(new Uint8Array(32));
  assert.equal(h.box, entry.box);
  assert.equal(h.pubLen, 32);
});

test("a server that closes the connection is refused in words that say what to do, and the dial is closed", async () => {
  const f = fake("refuse");
  await assert.rejects(makeChainPairer(deps(f))(entry), (/** @type {any} */ e) => e.code === "server_not_ready" && /code from that server/.test(e.message));
  assert.equal(f.closed, 1);
});

test("a server that never answers does not hang: it is refused after the time", async () => {
  const f = fake("hang");
  const t0 = Date.now();
  await assert.rejects(makeChainPairer(deps(f))(entry), (/** @type {any} */ e) => e.code === "server_not_ready");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(f.closed, 1);
});

test("an entry with no pin is never dialled", async () => {
  const f = fake("admit");
  await assert.rejects(makeChainPairer(deps(f))({ ...entry, box: "short" }), (/** @type {any} */ e) => e.code === "server_not_ready");
  assert.equal(f.dials.length, 0);
});

test("this device having no identity is a refusal that names it, and nothing is dialled", async () => {
  const f = fake("admit");
  await assert.rejects(makeChainPairer(deps(f, { chainHelloFor: null }))(entry), (/** @type {any} */ e) => e.code === "no_identity");
  assert.equal(f.dials.length, 0);
});

test("the presence key rides in the hello and its hash is bound by the chain hello, so the device can open a session", async () => {
  const f = fake("admit");
  await makeChainPairer(deps(f))(entry);
  const o = f.dials[0];
  assert.deepEqual(o.presenceKey, { public_key: "PK-SPKI" });
  const h = await o.chainHello(new Uint8Array(32));
  assert.equal(h.presencePublicKey, "PK-SPKI");
});

test("a device with no presence key still dials (it is admitted without a session)", async () => {
  const f = fake("admit");
  await makeChainPairer(deps(f, { presenceKey: async () => undefined }))(entry);
  assert.equal(f.dials[0].presenceKey, undefined);
});
