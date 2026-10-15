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

test("a brace written as \\{ is a brace: it prints as typed, fills nothing, and survives opening and saving the Flow", async () => {
  const { fromDefinition } = await import("./logic.js");
  const d = { name: "Text", trigger: { kind: "created", type: "matter" }, steps: [{ id: "create1", kind: "create", type: "matter", fields: [{ field: "title", value: "Write \\{name} where the client's name goes, for {after.title}" }] }] };
  const stored = toDefinition(d, options);
  assert.deepEqual(checkFlow(stored), []);
  const e = stored.steps[0].set.title.expr;
  assert.match(e, /"Write \{name\} where the client's name goes, for "/, "the escaped brace is literal text");
  assert.match(e, /trigger\.after\.title/, "the real token still fills");
  const back = fromDefinition(stored);
  assert.equal(back.steps[0].fields[0].value, "Write \\{name} where the client's name goes, for {after.title}", "read back as typed");
  assert.deepEqual(toDefinition(back, options), stored, "saving again changes nothing");
});

test("plain text stored before the escape existed keeps meaning plain text when the Flow is opened and saved", async () => {
  const { fromDefinition } = await import("./logic.js");
  const stored = { format: 1, name: "old", label: "Old", authorship: "builder", trigger: { on: "manual" }, steps: [{ id: "a1", kind: "agent", assistant: "teammate:juno", title: "Reply", instructions: "Greet them as {client} says, then ask about {topic}.", output: { kind: "note" }, record: { expr: "event.subject" }, await: true }] };
  const d = fromDefinition(stored);
  assert.equal(d.steps[0].instructions, "Greet them as \\{client} says, then ask about \\{topic}.", "shown escaped: these braces were never tokens");
  assert.equal(toDefinition(d, options).steps[0].instructions, "Greet them as {client} says, then ask about {topic}.", "and saved as the plain text it was");
});
