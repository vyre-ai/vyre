import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { gateTarget, SETUP_ROUTE } from "./setup-gate.js";

test("an unpaired phone is sent to setup from every shell route", () => {
  for (const path of ["/", "/chats", "/agents", "/places", "/vault", "/u/now", "/session/1"]) assert.equal(gateTarget({ path, paired: false, direct: false }), SETUP_ROUTE);
});
test("setup, pairing and join links stay reachable with no server", () => {
  for (const path of ["/u/install", "/u/install/create", "/u/install/join", "/pair", "/join"]) assert.equal(gateTarget({ path, paired: false, direct: false }), null);
});
test("a paired phone, or a direct address, is never gated", () => {
  assert.equal(gateTarget({ path: "/", paired: true, direct: false }), null);
  assert.equal(gateTarget({ path: "/", paired: false, direct: true }), null);
});

test("after Not now an unpaired phone keeps only the /u landing, and setup stays open", () => {
  assert.equal(gateTarget({ path: "/u/now", paired: false, direct: false, skipped: true }), null);
  assert.equal(gateTarget({ path: "/u/spaces", paired: false, direct: false, skipped: true }), null);
  assert.equal(gateTarget({ path: "/", paired: false, direct: false, skipped: true }), "/u/now");
  assert.equal(gateTarget({ path: "/chats", paired: false, direct: false, skipped: true }), "/u/now");
  assert.equal(gateTarget({ path: "/u/install", paired: false, direct: false, skipped: true }), null);
});

test("the Glass relay proof page is reachable with no server (the emulator job opens it on a phone that is not paired)", () => {
  assert.equal(gateTarget({ path: "/glass-relay-proof", paired: false, direct: false }), null);
  assert.equal(gateTarget({ path: "/notices-proof", paired: false, direct: false }), null);
  assert.equal(gateTarget({ path: "/u/now", paired: false, direct: false }), "/u/install", "any other route still goes to setup");
});
