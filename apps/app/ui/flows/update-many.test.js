import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "../../../../kernel/flows/schema.js";
import { fromDefinition, toDefinition, stepSummary } from "./logic.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const options = { ...O, types: [{ name: "contact", label: "Contact", fields: [{ name: "status", label: "Status", kind: "text" }, { name: "note", label: "Note", kind: "text" }, { name: "owner", label: "Owner", kind: "text" }] }] };
const stored = { format: 1, name: "u", label: "U", authorship: "builder", trigger: { on: "record", event: "created", type: "contact" }, steps: [{ id: "u1", kind: "update", type: "contact", record: { expr: "event.subject" }, set: { status: "Open", note: "Hi {after.name}", owner: "alex" } }] };

test("an Update step with several fields opens as that step and saves back the same", () => {
  const d = fromDefinition(stored, options);
  assert.equal(d.steps[0].kind, "update");
  assert.deepEqual(d.steps[0].more.map((x) => x.field), ["note", "owner"]);
  assert.match(stepSummary(d.steps[0], options, d), /Set status to Open and 2 more/);
  const out = toDefinition(d, options);
  assert.deepEqual(out.steps[0].set, stored.steps[0].set);
  assert.deepEqual(checkFlow(out), []);
});

test("an Update step with one field has no extra rows", () => {
  const one = { ...stored, steps: [{ ...stored.steps[0], set: { status: "Open" } }] };
  assert.equal(fromDefinition(one, options).steps[0].more, undefined);
});
