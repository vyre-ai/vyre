import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { KINDS, addField, addStage, buildType, callThemCases, fieldLine, moveStage, pluralOf, rename, renameStage, sealField, typeLine } from "./logic.js";

const matter = { id: "matter", label: "Matter", plural: "Matters", spaces: ["harlow"], work: true, kit: "Estate planning matter", fields: [{ key: "title", label: "Title", kind: "text", required: true }], stages: ["Intake", "Drafting", "Closed"] };

test("there are fifteen field kinds", () => assert.equal(KINDS.length, 15));

test("plurals have a sensible default", () => {
  assert.equal(pluralOf("Order"), "Orders");
  assert.equal(pluralOf("Property"), "Properties");
  assert.equal(pluralOf("Box"), "Boxes");
});

test("Matters can be called Cases and the Kit and id stay", () => {
  const c = callThemCases(matter);
  assert.equal(c.label, "Case");
  assert.equal(c.plural, "Cases");
  assert.equal(c.id, "matter");
  assert.equal(c.kit, "Estate planning matter");
});

test("an empty rename keeps the old name", () => {
  const r = rename(matter, "  ", "");
  assert.equal(r.label, "Matter");
  assert.equal(r.plural, "Matters");
});

test("a type from a template carries its fields and stages", () => {
  const t = buildType("order", "", true, "mine");
  assert.equal(t.label, "Order");
  assert.equal(t.plural, "Orders");
  assert.deepEqual(t.stages, ["New", "Baking", "Ready", "Picked up"]);
  assert.ok(t.fields.some((f) => f.kind === "money"));
  assert.deepEqual(t.spaces, ["mine"]);
});

test("a template name that is taken gets a number", () => {
  assert.equal(buildType("deal", "Deal", false, "mine", ["deal"]).id, "deal-2");
});

test("a new field gets a unique key, and sealed fields start sealed", () => {
  const a = addField(matter, "Title", "text");
  assert.equal(a.fields[1].key, "title-2");
  assert.equal(addField(matter, "SSN", "sealed").fields[1].sealed, true);
  assert.equal(sealField(a, "title", true).fields[0].sealed, true);
});

test("stages move, rename and add", () => {
  assert.deepEqual(moveStage(["a", "b", "c"], 1, -1), ["b", "a", "c"]);
  assert.deepEqual(moveStage(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
  assert.deepEqual(moveStage(["a", "b", "c"], 2, 1), ["a", "b", "c"]);
  assert.deepEqual(renameStage(["a", "b"], 0, "Open"), ["Open", "b"]);
  assert.deepEqual(renameStage(["a", "b"], 0, "b"), ["a", "b"]);
  assert.deepEqual(renameStage(["a", "b"], 0, " "), ["a", "b"]);
  assert.deepEqual(addStage(["a", "b"]), ["a", "b", "Stage 3"]);
});

test("lines say what a field and a type are", () => {
  assert.equal(fieldLine({ key: "t", label: "T", kind: "text", required: true }), "Text · required");
  assert.equal(fieldLine({ key: "r", label: "R", kind: "stage", rule: "Needs a signed engagement" }), "Stage · Needs a signed engagement");
  assert.equal(typeLine(matter), "1 field · holds work · from the Kit Estate planning matter");
});
