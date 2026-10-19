// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { requiresOf, stageRows, pipelineInput, toggleNeed, toggleLost, askable } from "./stage-rules.js";

test("the stored entry condition reads back as a list of fields, and anything else as none", () => {
  assert.deepEqual(requiresOf("not empty(value) and not empty(close_date)"), ["value", "close_date"]);
  assert.deepEqual(requiresOf("value > 3"), []);
  assert.deepEqual(requiresOf(undefined), []);
});

test("the rows of a type's stages, the lost stage apart from the fields it needs", () => {
  const def = { stages: [{ name: "New" }, { name: "Proposal sent", enter_if: "not empty(close_date)" }, { name: "Lost", enter_if: "not empty(lost_reason)" }] };
  assert.deepEqual(stageRows(def), [{ name: "New", requires: [], lost: false }, { name: "Proposal sent", requires: ["close_date"], lost: false }, { name: "Lost", requires: [], lost: true }]);
  assert.deepEqual(stageRows({}), []);
});

test("editing the rows, and the input that records.pipeline.set takes", () => {
  let rows = [{ name: "New", requires: [], lost: false }, { name: "Won", requires: [], lost: false }];
  rows = toggleNeed(rows, 1, "value");
  rows = toggleNeed(rows, 1, "close_date");
  rows = toggleNeed(rows, 1, "value");
  assert.deepEqual(rows[1].requires, ["close_date"]);
  rows = toggleLost(rows, 0);
  assert.deepEqual(pipelineInput("deal", rows), { type: "deal", stages: [{ name: "New", lost: true }, { name: "Won", requires: ["close_date"] }] });
});

test("a stage may ask for plain fields, never the stage field, a sealed one or the lost reason", () => {
  const def = { fields: [{ name: "value", kind: "money" }, { name: "stage", kind: "stage" }, { name: "ssn", kind: "sealed" }, { name: "lost_reason", kind: "text" }, { name: "close_date", kind: "date" }] };
  assert.deepEqual(askable(def).map((f) => f.name), ["value", "close_date"]);
});
