// How a turn feels: the words for how long it thought, and when the caret shows.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { thoughtWord, showsCaret } from "./feel.js";

test("thought: Thinking while it thinks, then how long, in seconds or minutes; nothing invented when the time was not seen", () => {
  assert.equal(thoughtWord(true, 0), "Thinking");
  assert.equal(thoughtWord(true, 50_000), "Thinking");
  assert.equal(thoughtWord(false, 12_400), "Thought for 12s");
  assert.equal(thoughtWord(false, 59_400), "Thought for 59s");
  assert.equal(thoughtWord(false, 60_000), "Thought for 1m");
  assert.equal(thoughtWord(false, 125_000), "Thought for 2m 5s");
  assert.equal(thoughtWord(false, 0), "Thought", "a thread loaded from before has no time to quote");
  assert.equal(thoughtWord(false, 400), "Thought", "under a second says nothing");
});

test("caret: shows while a message is arriving and never after", () => {
  assert.equal(showsCaret({ done: false }), true);
  assert.equal(showsCaret({ done: true }), false);
});
