import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScrollSignal, overlaps } from "./onscreen.js";

test("overlaps: a card in, partly in, above and below an 844 tall view", () => {
  assert.equal(overlaps(300, 220, 0, 844), true);
  assert.equal(overlaps(780, 220, 0, 844), true, "its top shows");
  assert.equal(overlaps(-200, 220, 0, 844), true, "its bottom shows");
  assert.equal(overlaps(-220, 220, 0, 844), false, "scrolled off the top");
  assert.equal(overlaps(844, 220, 0, 844), false, "below the fold");
  assert.equal(overlaps(1200, 220, 0, 844), false);
});

test("overlaps: a box not laid out yet is not on screen", () => {
  assert.equal(overlaps(100, 0, 0, 844), false);
  assert.equal(overlaps(NaN, 220, 0, 844), false);
});

test("scroll signal: every listener hears each scroll until it leaves", () => {
  const s = createScrollSignal();
  let a = 0, b = 0;
  const offA = s.on(() => a++);
  s.on(() => b++);
  s.emit();
  offA();
  s.emit();
  assert.deepEqual([a, b], [1, 2]);
});
