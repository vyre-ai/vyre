import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow } from "./schema.js";

const flow = (form) => ({ format: 1, name: "askform", label: "Ask form", authorship: "builder", trigger: { on: "manual" }, steps: [{ id: "q", kind: "ask", to: "role:partner", title: "Approve the refund?", form }] });
const problems = (form) => checkFlow(flow(form)).map((p) => `${p.path}: ${p.message}`);

test("an ask's form is a short list of named fields of the kinds the card can show", () => {
  assert.deepEqual(problems([{ name: "amount", label: "Amount", kind: "number", required: true }, { name: "when", kind: "date" }, { name: "ok", kind: "boolean" }, { name: "why" }, { name: "proof", kind: "file" }, { name: "how", kind: "choice", choices: ["Card", "Cash"] }]), []);
});

test("a form that is empty, too long, repeated or mistyped says what is wrong and where", () => {
  assert.ok(problems([]).some((m) => /1 to 20 fields/.test(m)));
  assert.ok(problems(Array.from({ length: 21 }, (_, i) => ({ name: `f${i}` }))).some((m) => /1 to 20 fields/.test(m)));
  assert.ok(problems([{ name: "a" }, { name: "a" }]).some((m) => /named twice/.test(m)));
  assert.ok(problems([{ name: "Bad Name" }]).some((m) => /lowercase letters/.test(m)));
  assert.ok(problems([{ name: "a", kind: "colour" }]).some((m) => /one of text, number/.test(m)));
  assert.ok(problems([{ name: "a", kind: "choice" }]).some((m) => /lists its choices/.test(m)));
  assert.ok(problems([{ name: "a", kind: "choice", choices: ["only"] }]).some((m) => /2 to 20 texts/.test(m)));
  assert.ok(problems([{ name: "a", kind: "text", choices: ["x", "y"] }]).some((m) => /belong to a field of kind choice/.test(m)));
  assert.ok(problems([{ name: "a", required: "yes" }]).some((m) => /true or false/.test(m)));
  assert.ok(problems([{ name: "a", surprise: 1 }]).length > 0);
});
