import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { inviteReasonSay, leftOf, phaseOf, redeemSay } from "./typed-model.js";

test("each refusal has its own sentence, none from the box and none naming a server", () => {
  const all = ["bad_input", "refused", "unavailable", "typed_code_off", "relay_old", "presence_required", "other"].map(redeemSay);
  assert.equal(new Set(all).size, all.length);
  for (const s of all) assert.doesNotMatch(s, /server|install/i);
});

test("a pairing's status becomes what the screen does next", () => {
  assert.deepEqual(phaseOf({ state: "waiting", ack: "WINK-AAAA-BBBB" }), { phase: "waiting", ack: "WINK-AAAA-BBBB" });
  assert.deepEqual(phaseOf({ state: "done", invite: { link: "https://h.vyre.run/join/x", space: "Juniper Studio" } }), { phase: "done", invite: { link: "https://h.vyre.run/join/x", space: "Juniper Studio" } });
  assert.equal(phaseOf({ state: "done" }).phase, "done");
  assert.deepEqual(phaseOf({ state: "confirm", words: ["amber", "quilt", "river"] }), { phase: "confirm", words: ["amber", "quilt", "river"] });
  assert.equal(phaseOf({ state: "failed" }).phase, "failed");
  assert.match(phaseOf({ state: "expired" }).say, /ran out of time/);
  assert.equal(phaseOf(null).phase, "waiting");
});

test("each invite redeem reason has its own sentence", () => {
  const all = ["format", "busy", "offline", "expired", "not_an_invite", "refused"].map(inviteReasonSay);
  assert.equal(new Set(all).size, all.length);
});

test("the countdown reads m:ss and goes empty at the deadline", () => {
  assert.equal(leftOf(10 * 60_000, 0), "10:00");
  assert.equal(leftOf(61_500, 0), "1:02");
  assert.equal(leftOf(1000, 1000), "");
  assert.equal(leftOf(null, 0), "");
});
