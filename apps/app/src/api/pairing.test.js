// @ts-check
// A stored pairing checked on load, and the relay base a request's proof ignores (pairing.ts).
// The old offer link is refused in wink-code.test.js.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./pairing.ts");

test("pairing: a stored pairing is checked on load, and the relay base carries the route", { skip: !strip }, async () => {
  const { readPairing, relayBase } = await load();
  const p = { relay: "wss://relay.example.net", route: "abcdefghijklmnopqrstuvwxyz", box: "Bw", name: "Juniper Studio", device: "dev1", presence: null };
  assert.deepEqual(readPairing(JSON.stringify(p)), p);
  assert.equal(readPairing("{"), null);
  assert.equal(readPairing(JSON.stringify({ ...p, relay: "https://relay.example.net" })), null);
  assert.equal(readPairing(null), null);
  assert.equal(relayBase(p), "https://relay.example.net/abcdefghijklmnopqrstuvwxyz");
  assert.equal(relayBase({ relay: "ws://127.0.0.1:9/", route: "r" }), "http://127.0.0.1:9/r");
});
