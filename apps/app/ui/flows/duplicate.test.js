import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicateDeep, flat } from "./tree.js";
import { flowSentence } from "./logic.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const flow = () => [
  { id: "find1", kind: "find", type: "contact" },
  { id: "decide2", kind: "decide", cond: { mode: "formula", formula: "x" }, then: [{ id: "email3", kind: "email", to: "a", subject: "s", body: "b" }], else: [] },
  { id: "wait4", kind: "wait", amount: 1, unit: "hours" },
];

test("a duplicate sits right after the original with an id nobody uses", () => {
  const r = duplicateDeep(flow(), "find1", flat(flow()).map((s) => s.id));
  assert.deepEqual(r.steps.map((s) => s.id), ["find1", r.id, "decide2", "wait4"]);
  assert.equal(r.steps[1].type, "contact");
  assert.ok(!["find1", "decide2", "email3", "wait4"].includes(r.id));
});

test("a duplicate of a step with lanes copies the steps in them with fresh ids too, and the original is untouched", () => {
  const f = flow();
  const used = flat(f).map((s) => s.id);
  const r = duplicateDeep(f, "decide2", used);
  const ids = flat(r.steps).map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "every id is unique");
  assert.equal(ids.length, used.length + 2, "the decide and its email were copied");
  assert.deepEqual(f[1].then.map((s) => s.id), ["email3"], "the original lane keeps its step");
});

test("a copy inside a lane lands in that lane; an unknown id changes nothing", () => {
  const f = flow();
  const r = duplicateDeep(f, "email3", flat(f).map((s) => s.id));
  assert.equal(r.steps[1].then.length, 2);
  assert.equal(r.steps[1].then[1].kind, "email");
  assert.deepEqual(duplicateDeep(f, "nope", []), { steps: f, id: null });
});

test("the headline sentence reads an If as its branches", () => {
  const d = { name: "T", trigger: { kind: "created", type: "contact" }, steps: [
    { id: "decide1", kind: "decide", cond: { mode: "build", source: "trigger", field: "amount", op: ">", value: "500" }, then: [{ id: "ask2", kind: "ask", to: "role:owner", title: "Approve it" }], else: [{ id: "email3", kind: "email", to: "a@b.c", subject: "s", body: "b" }] },
  ] };
  const s = flowSentence(d, O);
  assert.match(s, /, if amount is more than 500, wait for .* to say yes: approve it, otherwise /i);
});
