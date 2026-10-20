// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { binLine, settableFields, patchFor, bulkLine } from "./bin-model.js";

const DAY = 86_400_000, NOW = 1_800_000_000_000;

test("the bin says when a record went there, in days", () => {
  assert.equal(binLine(NOW - 1000, NOW), "Deleted today");
  assert.equal(binLine(NOW - DAY - 1, NOW), "Deleted yesterday");
  assert.equal(binLine(NOW - 4 * DAY, NOW), "Deleted 4 days ago");
  assert.equal(binLine(undefined, NOW), "Deleted");
});

test("ticked rows: only a choice, a stage or a yes or no can be set for all of them, never a sealed or computed field", () => {
  const def = { fields: [{ name: "name", kind: "text" }, { name: "status", kind: "choice", label: "Status", options: ["Open", "Done"] }, { name: "stage", kind: "stage", options: ["New", "Won"] }, { name: "vip", kind: "boolean", label: "VIP" }, { name: "score", kind: "choice", options: ["A"], computed: { expr: "x" } }, { name: "pin", kind: "choice", options: ["x"], seal: { class: "c" } }] };
  assert.deepEqual(settableFields(def).map((f) => f.name), ["status", "stage", "vip"]);
  assert.deepEqual(settableFields(def)[2].options, ["Yes", "No"]);
  assert.deepEqual(patchFor({ name: "vip", kind: "boolean" }, "No"), { vip: false });
  assert.deepEqual(patchFor({ name: "status", kind: "choice" }, "Done"), { status: "Done" });
  assert.deepEqual(settableFields(undefined), []);
});

test("a run over several records says how many did not go through", () => {
  assert.equal(bulkLine({ done: 3, failed: 0 }, "Status set for 3 people"), "Status set for 3 people.");
  assert.equal(bulkLine({ done: 2, failed: 1 }, "Deleted"), "Deleted: 2 done, 1 did not go through.");
});
