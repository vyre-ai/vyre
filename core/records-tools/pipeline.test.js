// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { conditionOf, requiresOf, isLost, stagesFrom, missingFor } from "./pipeline.js";

test("a stage's required fields become an entry condition and read back", () => {
  assert.equal(conditionOf(["amount", "close_date"]), "not empty(amount) and not empty(close_date)");
  assert.deepEqual(requiresOf("not empty(amount) and not empty(close_date)"), ["amount", "close_date"]);
  assert.deepEqual(requiresOf("amount > 5"), [], "a hand-written condition is not read as a list");
  assert.deepEqual(requiresOf(undefined), []);
});

test("a person's stage list is checked and turned into stages; a lost stage asks for the reason", () => {
  const fields = new Set(["amount", "close_date", "lost_reason"]);
  const s = stagesFrom([{ name: "Lead" }, { name: "Proposal", requires: ["amount"] }, { name: "Lost", lost: true }], fields);
  assert.deepEqual(s, [{ name: "Lead" }, { name: "Proposal", enter_if: "not empty(amount)" }, { name: "Lost", enter_if: "not empty(lost_reason)" }]);
  assert.equal(isLost(s[2]), true); assert.equal(isLost(s[1]), false);
  assert.throws(() => stagesFrom([{ name: "A" }, { name: "a" }], fields), /Two stages are called a/);
  assert.throws(() => stagesFrom([{ name: "A", requires: ["nope"] }], fields), /does not have/);
  assert.throws(() => stagesFrom([], fields), /between 1 and 30/);
  assert.throws(() => stagesFrom([{ name: "A", requires: ["x y"] }], fields), /not a field name/);
});

test("a move lists the fields still empty after the patch", () => {
  const stage = { name: "Proposal", enter_if: "not empty(amount) and not empty(close_date)" };
  assert.deepEqual(missingFor(stage, { amount: 5 }, {}), ["close_date"]);
  assert.deepEqual(missingFor(stage, { amount: 5 }, { close_date: "2026-11-01" }), []);
  assert.deepEqual(missingFor(stage, {}, {}), ["amount", "close_date"]);
  assert.deepEqual(missingFor({ name: "Lead" }, {}, {}), []);
});
