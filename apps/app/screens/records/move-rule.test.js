// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readNeeds, fieldFor, needSentence, needSentenceMany, readyToGo, moveInput, isStageGroup } from "./move-rule.js";

test("what records.move says is still needed, and nothing when the move went through", () => {
  assert.deepEqual(readNeeds({ needs: ["value", "close_date"], stage: "Proposal sent" }), ["value", "close_date"]);
  assert.equal(readNeeds({ record: { urn: "x" } }), null);
  assert.equal(readNeeds({ needs: [] }), null);
  assert.equal(readNeeds(undefined), null);
});

test("a need is drawn from the type's own field, or as plain text when the type has none (the lost reason)", () => {
  const def = { fields: [{ name: "value", label: "Value", kind: "money" }] };
  assert.equal(fieldFor(def, "value").kind, "money");
  assert.deepEqual(fieldFor(def, "lost_reason"), { name: "lost_reason", label: "Lost reason", kind: "text" });
  assert.equal(fieldFor(undefined, "close_date").label, "Close date");
});

test("the sheet's sentence, for one record and for several", () => {
  assert.equal(needSentence("Northwind phase 2", "Proposal sent", ["Value", "Close date"]), "To move Northwind phase 2 to Proposal sent, fill in: Value, Close date.");
  assert.equal(needSentenceMany(3, "deals", "Won", ["Close date"]), "To move 3 deals to Won, fill in: Close date. It is used for any that are missing it.");
});

test("Continue waits until every needed field has a value", () => {
  assert.equal(readyToGo(["a", "b"], { a: 1 }), false);
  assert.equal(readyToGo(["a", "b"], { a: 1, b: "x" }), true);
  assert.equal(readyToGo(["a"], { a: "" }), false);
  assert.equal(readyToGo(["a"], { a: [] }), false);
  assert.equal(readyToGo(["a"], { a: 0 }), true, "zero is a value");
  assert.equal(readyToGo([], {}), true);
});

test("the move input carries a patch only when there is one", () => {
  assert.deepEqual(moveInput("u", "Won"), { urn: "u", stage: "Won" });
  assert.deepEqual(moveInput("u", "Won", {}), { urn: "u", stage: "Won" });
  assert.deepEqual(moveInput("u", "Lost", { lost_reason: "Price" }), { urn: "u", stage: "Lost", patch: { lost_reason: "Price" } });
});

test("only a stage field makes a board move a stage move", () => {
  const def = { fields: [{ name: "stage", kind: "stage" }, { name: "tier", kind: "choice" }] };
  assert.equal(isStageGroup(def, "stage"), true);
  assert.equal(isStageGroup(def, "tier"), false);
  assert.equal(isStageGroup(def, undefined), false);
  assert.equal(isStageGroup(undefined, "stage"), false);
});
