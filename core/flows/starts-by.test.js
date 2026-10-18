// @ts-check
// How a Flow starts, for the member rule (a member approves only a Flow that starts by hand): manual only when every trigger it has is manual, whichever way the triggers are stored.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startsBy } from "./member.js";

const manual = { on: "manual" }, timer = { on: "time", every_ms: 3_600_000 }, ev = { on: "event", event: "payment.received" };

test("a Flow is manual only when every trigger it has is manual, in either stored shape and in both together", () => {
  assert.equal(startsBy({ trigger: manual }), "manual");
  assert.equal(startsBy({ triggers: [manual] }), "manual");
  assert.equal(startsBy({ triggers: [manual, manual] }), "manual");
  assert.equal(startsBy({}), "manual");
  assert.equal(startsBy({ trigger: timer }), "time");
  assert.equal(startsBy({ triggers: [manual, ev] }), "event", "one that starts by itself is enough");
  assert.equal(startsBy({ triggers: [timer, ev] }), "time");
});

test("a stored Flow that has a list and a single trigger together, or an empty list beside a trigger, reads as the one that starts by itself", () => {
  assert.equal(startsBy({ triggers: [], trigger: timer }), "time", "an empty list does not hide the trigger");
  assert.equal(startsBy({ triggers: [manual], trigger: ev }), "event");
  assert.equal(startsBy({ triggers: [ev], trigger: manual }), "event");
});
