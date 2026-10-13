// @ts-check
// The home hint: the one route (and the server's pinned box key) a brand-new device needs before it can read the list in the vault. It rides beside the Secret Key in the GitHub escrow bundle and on the kit, and comes from
// the approving device on the approve path. Small, versioned, and refused if it is not a pinned route.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { HINT_MAX, homeHintOf, offersChainSignIn, parseHomeHint, serializeHomeHint } from "./home-hint.js";

const KEY = "k".repeat(43);
const pairing = { relay: "wss://relay.example.net", route: "r".repeat(26), box: KEY, name: "my droplet", device: "dev_secret", presence: { enrolled: true } };

test("the hint is made from a pairing and carries only where to connect and the pin", () => {
  const h = homeHintOf(pairing);
  assert.deepEqual(h, { v: 1, relay: "wss://relay.example.net", route: "r".repeat(26), box: KEY, name: "my droplet" });
  assert.ok(!/dev_secret|presence/.test(JSON.stringify(h)));
});

test("serialize and parse give the same hint, and stay small", () => {
  const text = serializeHomeHint(homeHintOf(pairing));
  assert.ok(text.length <= HINT_MAX);
  assert.deepEqual(parseHomeHint(text), homeHintOf(pairing));
});

test("a hint without a pin, with a wrong version, a relay that is not wss, or junk is refused as null", () => {
  for (const bad of [null, undefined, "", "not json", JSON.stringify({ v: 2, relay: "wss://r", route: "r".repeat(26), box: KEY }), JSON.stringify({ v: 1, relay: "https://r", route: "r".repeat(26), box: KEY }),
    JSON.stringify({ v: 1, relay: "wss://r", route: "r".repeat(26), box: "short" }), JSON.stringify({ v: 1, relay: "wss://r", box: KEY }), JSON.stringify({ v: 1, relay: "wss://r", route: "", box: KEY })]) {
    assert.equal(parseHomeHint(/** @type {any} */ (bad)), null, String(bad));
  }
});

test("a pairing with no usable box key makes no hint", () => {
  assert.equal(homeHintOf({ ...pairing, box: "x" }), null);
});

test("the hint says whether the server admits chain devices; no flag means no chain sign-in", () => {
  assert.equal(offersChainSignIn(homeHintOf(pairing)), false, "an old server's hint has no flag");
  const on = homeHintOf({ ...pairing, chainHello: 1 });
  assert.equal(offersChainSignIn(on), true);
  assert.equal(offersChainSignIn(parseHomeHint(serializeHomeHint(/** @type {any} */ (on)))), true, "and it survives the escrow bundle");
  assert.equal(offersChainSignIn(homeHintOf({ ...pairing, chainHello: 2 })), false, "only the version this app knows");
  assert.equal(offersChainSignIn(null), false);
});

import { makeHintStore } from "./home-hint.js";

const kvOf = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } }; };
const GOOD = { v: 1, relay: "wss://r.example", route: "r".repeat(26), box: "b".repeat(43), name: "my droplet" };

test("hint store: a good hint is kept and read back; the first vault read can name its server", async () => {
  const s = makeHintStore(kvOf());
  assert.equal(await s.load(), null);
  assert.equal(await s.store(GOOD), true);
  assert.deepEqual(await s.load(), GOOD);
});

test("hint store: a hint with no pin, a bad relay or junk is refused and nothing is kept", async () => {
  const kv = kvOf();
  const s = makeHintStore(kv);
  for (const bad of [{ ...GOOD, box: "short" }, { ...GOOD, relay: "http://x" }, "junk", null, { ...GOOD, route: "" }]) assert.equal(await s.store(/** @type {any} */ (bad)), false);
  assert.equal(kv.m.size, 0);
});

test("hint store: a string hint (as a bundle or a kit carries it) is parsed; a store that throws is no hint", async () => {
  const s = makeHintStore(kvOf());
  assert.equal(await s.store(JSON.stringify(GOOD)), true);
  const broken = makeHintStore({ get: async () => { throw new Error("x"); }, set: async () => { throw new Error("x"); }, del: async () => {} });
  assert.equal(await broken.load(), null);
  assert.equal(await broken.store(GOOD), false);
});
