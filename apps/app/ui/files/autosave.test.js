import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSaveDelay, pushHistory, undoOf, redoOf } from "./autosave.js";

test("autosave: 1.5 s after typing stops, and no closer than the spacing to the last save", () => {
  assert.equal(nextSaveDelay(1000, 0, 30000), 1500, "the first save waits only for the pause");
  assert.equal(nextSaveDelay(10_000, 5_000, 30_000), 25_000, "a version-making save waits out the spacing");
  assert.equal(nextSaveDelay(50_000, 5_000, 30_000), 1500, "long since the last save: just the pause");
  assert.equal(nextSaveDelay(10_000, 9_000, 0), 1500, "no spacing: every pause saves");
});

test("undo and redo: a burst of typing is one step; undo then redo returns the text; a new edit clears redo", () => {
  let h = { past: [], future: [], at: 0 };
  h = pushHistory(h, "a", 1000);
  h = pushHistory(h, "ab", 1200);
  h = pushHistory(h, "abc", 1300);
  assert.deepEqual(h.past, ["a"], "typing within a burst adds no step");
  h = pushHistory(h, "abcd", 5000);
  assert.deepEqual(h.past, ["a", "abcd"]);
  let r = undoOf(h, "abcde");
  assert.equal(r.text, "abcd");
  r = undoOf(r.hist, "abcd");
  assert.equal(r.text, "a");
  assert.equal(undoOf(r.hist, "a").text, null, "nothing left to undo");
  const again = redoOf(r.hist, "a");
  assert.equal(again.text, "abcd");
  assert.equal(pushHistory(again.hist, "abcd", 99_000).future.length, 0, "a new edit clears redo");
});
