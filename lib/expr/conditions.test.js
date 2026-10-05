import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fieldState, fieldStates, holds, isEmpty, stageNamesOf, stagesFor } from "./conditions.js";

const DEF = {
  name: "matter",
  fields: [
    { name: "area", kind: "choice", options: ["PI", "EP"] },
    { name: "accident_date", kind: "date", visible_if: 'area == "PI"', required_if: 'area == "PI"' },
    { name: "notes", kind: "text", required: true },
    { name: "plain", kind: "text" },
    { name: "stage", kind: "stage", options: ["Intake", "Treating", "Drafting"] },
  ],
  stages: [{ name: "Intake" }],
  stage_sets: [{ name: "pi", when: 'area == "PI"', stages: [{ name: "Intake" }, { name: "Treating" }] }, { name: "ep", when: 'area == "EP"', stages: [{ name: "Intake" }, { name: "Drafting" }] }],
};

test("isEmpty: null, empty text and an empty list hold nothing; zero and false do", () => {
  for (const v of [null, undefined, "", []]) assert.equal(isEmpty(v), true);
  for (const v of [0, false, "a", ["a"]]) assert.equal(isEmpty(v), false);
});

test("holds: true only when the expression is true; one that cannot be read is false", () => {
  assert.equal(holds('a == 1', { a: 1 }), true);
  assert.equal(holds('a == 1', { a: 2 }), false);
  assert.equal(holds("(", {}), false);
  assert.equal(holds("a == 1", undefined), false);
});

test("fieldState: visible and required follow the record's other fields; a hidden field is never required", () => {
  const f = DEF.fields[1];
  assert.deepEqual(fieldState(f, { area: "PI" }), { visible: true, required: true });
  assert.deepEqual(fieldState(f, { area: "EP" }), { visible: false, required: false });
  assert.deepEqual(fieldState(f, {}), { visible: false, required: false });
  assert.deepEqual(fieldState(DEF.fields[2], {}), { visible: true, required: true }, "required: true is always");
  assert.deepEqual(fieldState(DEF.fields[3], {}), { visible: true, required: false });
  assert.deepEqual(Object.keys(fieldStates(DEF, { area: "PI" })), DEF.fields.map((x) => x.name));
});

test("stage sets: the first set that holds gives the stages, else the default; the names are the union", () => {
  assert.deepEqual(stagesFor(DEF, { area: "PI" }), { set: "pi", stages: DEF.stage_sets[0].stages });
  assert.equal(stagesFor(DEF, { area: "EP" }).set, "ep");
  assert.deepEqual(stagesFor(DEF, {}), { set: null, stages: DEF.stages });
  assert.deepEqual(stageNamesOf(DEF), ["Intake", "Treating", "Drafting"]);
  assert.deepEqual(stageNamesOf({ stages: [{ name: "A" }] }), ["A"]);
});
