import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { inviteReasonSay, leftOf, phaseOf, redeemSay, serverPairError } from "./typed-model.js";

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

test("a server's typed code that did not finish throws a coded error with real words, never the bare one the screens turn into \"Something went wrong.\"", () => {
  const lost = serverPairError({ reason: "offline", code: "unreachable", message: "The other device did not answer." });
  assert.equal(lost.code, "unreachable");
  assert.match(lost.message, /stopped answering before the pairing finished/);
  const refused = serverPairError({ reason: "closed", code: "not_hardware", message: "This identity's key is not held in hardware." });
  assert.deepEqual([refused.code, refused.message], ["not_hardware", "This identity's key is not held in hardware."]);
  const late = serverPairError({ reason: "expired" });
  assert.deepEqual([late.code, late.message], ["expired", inviteReasonSay("expired")]);
  for (const r of [{ reason: "closed" }, { reason: "needs_identity" }, { reason: "format" }, { reason: "busy" }]) {
    const e = serverPairError(r);
    assert.equal(typeof e.code, "string");
    assert.ok(e.message && e.message !== "Something went wrong.", JSON.stringify(r));
  }
});
