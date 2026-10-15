import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "../../../../kernel/flows/schema.js";
import { fromDefinition, toDefinition, newStep, valueSources } from "./logic.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const options = { ...O, types: [{ name: "contact", label: "Contact", fields: [{ name: "name", label: "Name", kind: "text" }] }] };
const flow = (steps) => ({ name: "Options", trigger: { kind: "created", type: "contact" }, steps });
const round = (def) => toDefinition(fromDefinition(def, options), options);

test("an agent step stored with await false stays false when the Flow is saved again", () => {
  const d = flow([{ id: "a1", kind: "agent", agent: "juno", title: "Look", instructions: "Read it", output: { kind: "note" }, record: { expr: "event.subject" }, await: false }]);
  const draft = fromDefinition(d, options);
  assert.equal(draft.steps[0].kind, "agent", "it opens as an agent step, not an advanced one");
  const again = toDefinition(draft, options);
  assert.equal(again.steps[0].await, false);
  assert.deepEqual(checkFlow(again), []);
  const kept = flow([{ ...d.steps[0], await: true }]);
  assert.equal(round(kept).steps[0].await, true, "waiting is the default and stays");
});

test("skills on an agent or an assign step round-trip as a typed list, capped at 20 and 60 characters", () => {
  const d = flow([{ id: "a1", kind: "agent", agent: "juno", title: "Look", instructions: "Read it", output: { kind: "note" }, record: { expr: "event.subject" }, await: true, skills: ["intake", "billing"] }]);
  const draft = fromDefinition(d, options);
  assert.equal(draft.steps[0].skills, "intake, billing");
  draft.steps[0].skills = Array.from({ length: 25 }, (_, i) => `s${i}`).join(", ");
  assert.equal(toDefinition(draft, options).steps[0].skills.length, 20);
  draft.steps[0].skills = "x".repeat(90);
  assert.equal(toDefinition(draft, options).steps[0].skills[0].length, 60);
});

test("an assign step keeps its record, await and skills", () => {
  const d = flow([{ id: "t1", kind: "assign", to: "role:intake", title: "Call back", output: { kind: "note" }, record: { expr: "event.subject" }, await: true, skills: ["phone"] }]);
  const out = round(d);
  assert.equal(out.steps[0].kind, "assign");
  assert.deepEqual([out.steps[0].record, out.steps[0].await, out.steps[0].skills], [{ expr: "event.subject" }, true, ["phone"]]);
});

test("a find step keeps one sort and opens a sort it cannot show as an advanced step", () => {
  const d = flow([{ id: "f1", kind: "find", type: "contact", limit: 5, sort: [{ field: "name", dir: "desc" }] }]);
  const draft = fromDefinition(d, options);
  assert.deepEqual([draft.steps[0].kind, draft.steps[0].sortField, draft.steps[0].sortDir], ["find", "name", "desc"]);
  assert.deepEqual(toDefinition(draft, options).steps[0].sort, [{ field: "name", dir: "desc" }]);
  const two = flow([{ id: "f1", kind: "find", type: "contact", limit: 5, sort: [{ field: "name", dir: "asc" }, { field: "id", dir: "asc" }] }]);
  assert.equal(fromDefinition(two, options).steps[0].kind, "advanced");
});

test("an extract fact keeps its description", () => {
  const d = flow([{ id: "e1", kind: "extract", input: "{message}", fields: [{ name: "amount", kind: "number", description: "The total in dollars" }] }]);
  assert.equal(round(d).steps[0].fields[0].description, "The total in dollars");
});

test("later steps can pick a group or a pulled-out fact from the value list", () => {
  const d = flow([{ id: "c1", kind: "classify", input: "{message}", labels: ["Urgent", "Routine"] }, { id: "e1", kind: "extract", input: "{message}", fields: [{ name: "amount", kind: "number" }] }, { id: "n1", kind: "formula", formula: "1" }]);
  const draft = fromDefinition(d, options);
  const found = valueSources(draft, "n1", options).map((x) => x[0]);
  for (const want of ["{steps.c1.label}", "{steps.e1.fields.amount}"]) assert.ok(found.includes(want), want);
});
