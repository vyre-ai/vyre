import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "../../../../kernel/flows/schema.js";
import { fromDefinition, toDefinition, newStep, stepProblem, stepSummary, placeholderPlan, syncDocumentRows, valueSources, STEP_CHOICES } from "./logic.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const options = { ...O, types: [{ name: "contact", label: "Contact", fields: [{ name: "name", label: "Name", kind: "text" }] }] };

test("what a template asks for splits into values and the records its dotted placeholders read", () => {
  assert.deepEqual(placeholderPlan(["client_name", "contact.name", "contact.spouse.name", "brand.name", "matter_date", "client_name"]), { values: ["client_name", "matter_date"], aliases: ["contact"] });
  const s = { fields: [{ field: "client_name", value: "{name}" }, { field: "gone", value: "x" }], records: [{ alias: "contact", ref: "trigger" }] };
  assert.deepEqual(syncDocumentRows(s, ["client_name", "matter_date", "contact.name"]), { fields: [{ field: "client_name", value: "{name}" }, { field: "matter_date", value: "" }], records: [{ alias: "contact", ref: "trigger" }] }, "kept what was filled in, added the new, dropped what the template no longer asks for");
});

test("Make a document is a palette item, stores as the documents.generate call the engine runs, and opens as the same step", () => {
  assert.ok(STEP_CHOICES.some((c) => c.kind === "document"));
  const d = { name: "Letter", trigger: { kind: "created", type: "contact" }, steps: [] };
  const s = newStep("document", d, options);
  Object.assign(s, { template: "Engagement letter", format: "pdf", fields: [{ field: "client_name", value: "{after.name}" }, { field: "note", value: "Sent by {approver.name}" }], records: [{ alias: "contact", ref: "trigger" }] });
  d.steps.push(s);
  assert.equal(stepProblem(s, options), null);
  const stored = toDefinition(d, options);
  assert.deepEqual(checkFlow(stored), []);
  const call = stored.steps[0];
  assert.deepEqual([call.kind, call.action, call.resource], ["call", "documents.generate", "vyre://space/documents"]);
  assert.equal(call.input.template, "Engagement letter");
  assert.equal(call.input.format, "pdf");
  assert.deepEqual(call.input.values.client_name, { expr: "trigger.after.name" });
  assert.deepEqual(call.input.records, { contact: { expr: "event.subject" } }, "a record is named by its address");
  const back = fromDefinition(stored);
  assert.equal(back.steps[0].kind, "document", "not an Advanced step");
  assert.deepEqual(toDefinition(back, options), stored);
  assert.equal(stepSummary(back.steps[0], options, back), "Make a document from the Engagement letter template as a PDF");
  assert.ok(valueSources({ ...d, steps: [...d.steps, { id: "next", kind: "email", to: "", subject: "", body: "" }] }, "next", options).some(([t]) => t === `{steps.${s.id}.path}`), "a later step can read where it was filed");
});

test("a document step still needs its template and an answer for every placeholder and record", () => {
  assert.equal(stepProblem({ id: "d", kind: "document", template: "", fields: [], records: [] }, options), "Choose the template.");
  assert.match(stepProblem({ id: "d", kind: "document", template: "T", fields: [{ field: "x", value: " " }], records: [] }, options), /every placeholder/);
  assert.match(stepProblem({ id: "d", kind: "document", template: "T", fields: [], records: [{ alias: "contact", ref: "" }] }, options), /record/);
});
