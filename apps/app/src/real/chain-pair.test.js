// @ts-check
// Pairing a listed server with no typed code (chain-pair.js): dial the pinned box with a chain hello, and the reply's device id makes the pairing. A fake connection stands in for the relay client.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chainPair } from "./chain-pair.js";

const entry = { kind: "server", id: "b".repeat(43), name: "my droplet", relay: "wss://r", route: "r".repeat(26), box: "b".repeat(43) };

function deps(/** @type {any} */ over = {}) {
  /** @type {any} */ const seen = { closed: 0, hello: null };
  const d = {
    seen,
    who: { id: "id1", eid: "e1", sign: async () => new Uint8Array([1, 2]) },
    crypto: { sha256: async (/** @type {Uint8Array} */ b) => b }, keyStore: {}, about: { kind: "web" }, name: "this browser",
    chainHello: async (/** @type {any} */ o) => { seen.hello = o; return { sig: "s" }; },
    connect: (/** @type {any} */ o) => { seen.opts = o; return { reply: { device: "dev123" }, ready: async () => { await o.chainHello(new Uint8Array([9])); }, close: () => { seen.closed++; }, ...over.conn }; },
    ...over.d,
  };
  return d;
}

test("dials the pinned box with a chain hello built from this device's identity, then returns the pairing the reply names", async () => {
  const d = deps();
  const p = await chainPair(entry, d);
  assert.deepEqual(p, { relay: "wss://r", route: entry.route, box: entry.box, name: "my droplet", device: "dev123", presence: null });
  assert.equal(d.seen.opts.box, entry.box);
  assert.equal(d.seen.hello.box, entry.box);
  assert.deepEqual([d.seen.hello.identity, d.seen.hello.entry], ["id1", "e1"]);
  assert.equal(d.seen.closed, 1);
});

test("an entry with no pin is never dialled", async () => {
  const d = deps();
  await assert.rejects(() => chainPair({ ...entry, box: "short" }, d), (e) => /** @type {any} */ (e).code === "unpinned");
  assert.equal(d.seen.opts, undefined);
});

test("a device with no identity says so and dials nothing", async () => {
  const d = deps({ d: { who: null } });
  await assert.rejects(() => chainPair(entry, d), (e) => /** @type {any} */ (e).code === "no_identity");
  assert.equal(d.seen.opts, undefined);
});

test("a refusal comes back in words with the next step, and the connection is closed", async () => {
  const d = deps({ conn: { ready: async () => { throw new Error("bad_proof"); } } });
  await assert.rejects(() => chainPair(entry, d), (e) => /** @type {any} */ (e).code === "refused" && /one you already use/.test(/** @type {any} */ (e).message));
  assert.equal(d.seen.closed, 1);
});

test("a reply with no device id is not a pairing", async () => {
  const d = deps({ conn: { reply: {} } });
  await assert.rejects(() => chainPair(entry, d), (e) => /** @type {any} */ (e).code === "refused");
});
