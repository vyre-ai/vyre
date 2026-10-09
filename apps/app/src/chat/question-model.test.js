// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickChoice, typeOwn, ready, toAnswers, progress, answerOf } from "./question-model.js";
import { normalizeBlock } from "./blocks.js";

const qs = [
  { id: "file", prompt: "Is this the file?", choices: [{ label: "report-final.pdf", detail: "Downloads, 2 MB" }, { label: "report-v2.pdf" }], allowText: true, optional: false },
  { id: "who", prompt: "Which Sam?", choices: [{ label: "Sam Lee, Slack" }], allowText: true, optional: false },
  { id: "note", prompt: "A note?", choices: [], allowText: true, optional: true },
];

test("a card is ready when every question that is not optional has an answer, by a choice or by the person's own words", () => {
  let p = {};
  assert.deepEqual(progress(qs, p), { done: 0, of: 2 });
  assert.equal(ready(qs, p), false);
  p = pickChoice(p, "file", "report-final.pdf");
  assert.equal(ready(qs, p), false);
  p = typeOwn(p, "who", "the one in sales");
  assert.equal(ready(qs, p), true);
  assert.deepEqual(toAnswers(qs, p), { file: { choice: "report-final.pdf" }, who: { text: "the one in sales" } });
  assert.deepEqual(progress(qs, p), { done: 2, of: 2 });
});

test("tapping a picked choice lets it go; typing replaces a choice and choosing replaces typing; blank typing is nothing", () => {
  let p = pickChoice({}, "file", "report-v2.pdf");
  p = pickChoice(p, "file", "report-v2.pdf");
  assert.deepEqual(p, {});
  p = typeOwn(p, "file", "  mine  ");
  assert.deepEqual(toAnswers(qs, p), { file: { text: "mine" } });
  p = pickChoice(p, "file", "report-final.pdf");
  assert.deepEqual(p.file, { choice: "report-final.pdf" });
  assert.deepEqual(typeOwn(p, "file", "   "), {});
});

test("the answered card says each answer, and Skipped for an optional one left blank", () => {
  assert.equal(answerOf(qs[0], { file: { choice: "report-final.pdf" } }), "report-final.pdf");
  assert.equal(answerOf(qs[2], {}), "Skipped");
});

test("a questions block keeps its questions and answers; a malformed one degrades to text", () => {
  const b = normalizeBlock({ block: "questions", id: "0a1b2c3d4e5f", title: "Before I send it", state: "answered", questions: [{ id: "file", prompt: "Is this the file?", choices: [{ label: "report-final.pdf" }], allowText: true }], answers: { file: { choice: "report-final.pdf" } } });
  assert.equal(b.block, "questions");
  assert.equal(b.block === "questions" && b.state, "answered");
  assert.deepEqual(b.block === "questions" && b.answers, { file: { choice: "report-final.pdf" } });
  assert.equal(normalizeBlock({ block: "questions", id: "bad", questions: [] }).block, "text");
});
