// One table of what a person types and what a run prints, driven through BOTH halves: the editor writes the stored value (logic.js val/toDefinition), the engine's own evaluator (kernel/flows/expr.js) prints it,
// and the editor reads the stored value back to the text that was typed. Doubled braces are the literal escape; everything else in braces that looks like a token fills.
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "../../../../kernel/flows/schema.js";
import { parse, evaluate } from "../../../../kernel/flows/expr.js";
import { fromDefinition, toDefinition } from "./logic.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const options = { ...O, types: [{ name: "matter", label: "Matter", fields: [{ name: "title", label: "Title", kind: "text" }] }] };
const scope = { trigger: { after: { title: "Refund" }, name: "Jane" }, now: Date.UTC(2026, 9, 28, 9, 0), tz: "UTC", steps: {}, run: { number: 7, flow_name: "Refunds", approver_name: "Alex", starter_name: "Alex", space_name: "Harlow Legal" } };

// [what is typed, what the run prints]
const CASES = [
  ["Write {{name}} for {after.title}", "Write {name} for Refund"],
  ["{{after.title}}", "{after.title}"],
  ["Hello {name}", "Hello Jane"],
  ["Run {run.number} of {flow.name}", "Run 7 of Refunds"],
  ["{{run.number}} is the number, {run.number} is this run's", "{run.number} is the number, 7 is this run's"],
  ["Not a token: {not a token} or {\"a\": 1}", "Not a token: {not a token} or {\"a\": 1}"],
  ["Plain text, no braces", "Plain text, no braces"],
];

const printed = (v) => (v && typeof v === "object" && typeof v.expr === "string" ? evaluate(parse(v.expr), scope) : v);

for (const [typed, prints] of CASES) {
  test(`typed ${JSON.stringify(typed)} prints ${JSON.stringify(prints)} and reads back as typed`, () => {
    const d = { name: "Cases", trigger: { kind: "created", type: "matter" }, steps: [{ id: "create1", kind: "create", type: "matter", fields: [{ field: "title", value: typed }] }] };
    const stored = toDefinition(d, options);
    assert.deepEqual(checkFlow(stored), []);
    assert.equal(printed(stored.steps[0].set.title), prints, "what the engine prints");
    assert.equal(fromDefinition(stored).steps[0].fields[0].value, typed, "what the editor shows when it is opened again");
    assert.deepEqual(toDefinition(fromDefinition(stored), options), stored, "and saving it again changes nothing");
  });
}
