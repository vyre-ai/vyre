import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "../../../../kernel/flows/schema.js";
import { toDefinition } from "./logic.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const options = { ...O, types: [{ name: "matter", label: "Matter", fields: [{ name: "links", label: "Links", kind: "urls" }, { name: "emails", label: "Emails", kind: "emails" }, { name: "due", label: "Due", kind: "date" }, { name: "title", label: "Title", kind: "text" }] }] };
const draft = { name: "Text", trigger: { kind: "created", type: "matter" }, steps: [
  { id: "pick1", kind: "pick", type: "matter", where: "" },
  { id: "create1", kind: "create", type: "matter", fields: [{ field: "title", value: "Links {after.links}, mail {after.emails}, due {steps.pick1.record.data.due}" }] },
] };

test("a list field in text prints its main item, not the list as JSON, and a date of a looked-up record reads as a date", () => {
  const stored = toDefinition(draft, options);
  assert.deepEqual(checkFlow(stored), []);
  const text = stored.steps[1].set.title.expr;
  assert.match(text, /first\(trigger\.after\.links\)/, "a URL list prints one address");
  assert.match(text, /first\(trigger\.after\.emails\)/, "an email list prints one address");
  assert.match(text, /date\(steps\.pick1\.record\.data\.due\)/, "a date of a record a step looked up is written as people read it, not as ISO");
  assert.ok(!/text\(trigger\.after\.links\)/.test(text));
});
