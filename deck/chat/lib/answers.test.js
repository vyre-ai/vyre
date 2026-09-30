// @ts-check
// A question's answers as threads.answer takes them: single, multi-select, Other, and never half-filled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyPick, choose, answerText, answered, buildAnswers, answerInput } from "./answers.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/session-blocks.json", import.meta.url), "utf8"));
const [slots, emails] = fx.asks[0].questions;

test("single-select: the chosen label, a second choice replaces the first", () => {
  let p = choose(slots, emptyPick(), "Mornings only");
  assert.equal(answerText(slots, p), "Mornings only");
  p = choose(slots, p, "All day");
  assert.equal(answerText(slots, p), "All day");
});

test("single-select Other: the typed text, trimmed; empty is no answer", () => {
  let p = choose(slots, emptyPick(), null);
  assert.equal(answered(slots, p), false);
  p = { ...p, text: "  Saturdays 8 to 12  " };
  assert.equal(answerText(slots, p), "Saturdays 8 to 12");
  p = choose(slots, p, "All day");
  assert.equal(answerText(slots, p), "All day", "picking an option leaves Other");
});

test("multi-select: labels joined with a comma in option order, toggled, Other last", () => {
  let p = choose(emails, emptyPick(), "kit");
  p = choose(emails, p, "juno");
  assert.equal(answerText(emails, p), "juno, kit");
  p = choose(emails, p, "kit");
  assert.equal(answerText(emails, p), "juno");
  p = { ...choose(emails, p, null), text: "alex" };
  assert.equal(answerText(emails, p), "juno, alex");
  p = choose(emails, p, null);
  assert.equal(answerText(emails, p), "juno", "Other toggles off in a multi-select");
});

test("buildAnswers keys by the question text and refuses a missing answer", () => {
  const picks = [choose(slots, emptyPick(), "Mornings only"), choose(emails, choose(emails, emptyPick(), "juno"), "kit")];
  assert.deepEqual(buildAnswers([slots, emails], picks), {
    "Which pickup slots should the form offer?": "Mornings only",
    "Who should get the order emails?": "juno, kit",
  });
  assert.throws(() => buildAnswers([slots, emails], [picks[0], emptyPick()]), /Emails/);
  assert.deepEqual(answerInput("ask_q1", [slots], [picks[0]]), {
    ask: "ask_q1", decision: "allow", surface: "deck", answers: { "Which pickup slots should the form offer?": "Mornings only" },
  });
});
