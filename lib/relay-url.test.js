// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { relayUrlProblem, publishableRelay } from "./relay-url.js";

test("a wss relay is publishable in every build", () => {
  assert.equal(relayUrlProblem("wss://relay.vyre.run", { release: true }), null);
  assert.equal(relayUrlProblem("wss://relay.vyre.run", { release: false }), null);
  assert.equal(publishableRelay("wss://relay.vyre.run", { release: true }), "wss://relay.vyre.run");
});
test("a plain ws relay is refused in a release build and allowed in a development build", () => {
  assert.match(String(relayUrlProblem("ws://127.0.0.1:8787", { release: true })), /wss:\/\//);
  assert.equal(relayUrlProblem("ws://127.0.0.1:8787", { release: false }), null);
  assert.throws(() => publishableRelay("ws://relay.example", { release: true }), (/** @type {any} */ e) => e.code === "unavailable" && /plain ws/.test(e.message));
});
test("anything that is not a ws or wss address is refused in both", () => {
  for (const u of ["https://relay.vyre.run", "relay.vyre.run", "", "ws://"]) { assert.ok(relayUrlProblem(u, { release: false }), u); assert.ok(relayUrlProblem(u, { release: true }), u); }
});
