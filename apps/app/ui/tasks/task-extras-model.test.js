import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { detailLines, escalateWords, extrasOf } from "./task-extras-model.js";

test("details are drawn as key and value text, nested values pretty-printed, never markup", () => {
  assert.deepEqual(detailLines({ to: "<b>x</b>", n: 3, o: { a: 1 } }), [{ key: "to", value: "<b>x</b>" }, { key: "n", value: "3" }, { key: "o", value: '{\n  "a": 1\n}' }]);
  assert.deepEqual(detailLines(null), []);
  assert.deepEqual(detailLines("plain"), [{ key: "", value: "plain" }]);
});

test("escalation reads in days or hours", () => {
  assert.equal(escalateWords({ due_ms: 172_800_000, role: "Designers" }), "Passed to the Designers after 2 days with no answer");
  assert.equal(escalateWords({ due_ms: 7_200_000 }), "Passed to someone else after 2 hours with no answer");
  assert.equal(escalateWords({}), "");
});

test("a task shows only the slots that have something, and nothing when card_extras is absent", () => {
  assert.equal(extrasOf({}), null);
  const t = { card_extras: { guides: { untrusted: true, instructions: { reviewer: "Plain words" }, skills: { reviewer: [{ id: "s1", name: "Voice", hash: "h", checklist: ["No jargon"] }] } }, task_data: { untrusted: true, details: { note: "hi" }, outputs: ["draft:1"] } } };
  const x = extrasOf(t);
  assert.deepEqual(x.slots.map((s) => s.key), ["reviewer"]);
  assert.deepEqual(x.slots[0].skills, [{ name: "Voice", checklist: ["No jargon"] }]);
  assert.deepEqual(x.data.outputs, ["draft:1"]);
  assert.equal(extrasOf({ card_extras: { task_data: { untrusted: true, details: null, outputs: [] } } }), null);
});
