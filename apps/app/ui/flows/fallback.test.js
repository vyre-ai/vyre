import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { val, toDefinition, fromDefinition } from "./logic.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

test("a token with a fallback inside text compiles to coalesce and reads back the same", () => {
  const e = val("Hi {steps.big.n | someone}, welcome").expr;
  assert.equal(e, '"Hi " + text(coalesce(steps.big.n, "someone")) + ", welcome"');
  const d = { name: "T", trigger: { kind: "form", path: "contact" }, steps: [{ id: "email1", kind: "email", to: "a@b.c", subject: "Hi {steps.big.n | someone}", body: "b" }] };
  const back = fromDefinition(toDefinition(d, O), O);
  assert.equal(back.steps[0].kind, "email");
  assert.equal(back.steps[0].subject, "Hi {steps.big.n | someone}");
});

test("quotes are allowed and stripped, and a fallback with a space at an end is shown quoted", () => {
  assert.equal(val('{steps.big.n | "someone"}').expr, 'coalesce(steps.big.n, "someone")');
  assert.equal(val("{steps.big.n | someone}").expr, 'coalesce(steps.big.n, "someone")');
  assert.equal(val('{steps.big.n | " a "}').expr, 'coalesce(steps.big.n, " a ")');
  const d = { name: "T", trigger: { kind: "form", path: "contact" }, steps: [{ id: "email1", kind: "email", to: "a@b.c", subject: 'x {steps.big.n | " a "} y', body: "b" }] };
  assert.equal(fromDefinition(toDefinition(d, O), O).steps[0].subject, 'x {steps.big.n | " a "} y');
});

test("a fallback applies to a plain path only; plain tokens and doubled braces are unchanged", () => {
  assert.deepEqual(val("{steps.big.n}"), { expr: "steps.big.n" });
  assert.equal(val("{now | x}").expr === undefined, false);
  assert.ok(!val("{now | x}").expr.includes("coalesce"));
  assert.equal(val("{{steps.big.n | x}}"), "{steps.big.n | x}");
});
