import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { blank, missing, submission, isQuestions, labelOf } from "./form-fields-model.js";

const FIELDS = [{ name: "amount", label: "Refund amount", kind: "number", required: true }, { name: "how", kind: "choice", choices: ["Card", "Cash"], required: true }, { name: "ok", kind: "boolean", required: true }, { name: "note" }];

test("blank answers start empty, and a yes or no starts as no", () => {
  assert.deepEqual(blank(FIELDS), { amount: "", how: "", ok: false, note: "" });
});

test("what is missing names the required questions with their own words", () => {
  assert.deepEqual(missing(FIELDS, blank(FIELDS)), ["Refund amount", "how"], "a yes or no is never missing; an unlabelled question uses its name");
  assert.deepEqual(missing(FIELDS, { amount: " 5 ", how: "Card", ok: false, note: "" }), []);
  assert.equal(labelOf({ name: "how" }), "how");
});

test("the submission carries answered questions only, a yes or no as a boolean", () => {
  assert.deepEqual(submission(FIELDS, { amount: " 12.5 ", how: "", ok: true, note: "  " }), { amount: "12.5", ok: true });
});

test("only a list of named questions is a form this card shows", () => {
  assert.equal(isQuestions(FIELDS), true);
  assert.equal(isQuestions([]), false);
  assert.equal(isQuestions({ brief: "x", fyi: true }), false);
  assert.equal(isQuestions([{ label: "no name" }]), false);
});
