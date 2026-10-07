import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeLabel, badgeText, elapsed, nextTick } from "./status-words.js";

test("elapsed: seconds under a minute, minutes under an hour, then hours and minutes", () => {
  assert.equal(elapsed(0), "0s");
  assert.equal(elapsed(12_400), "12s");
  assert.equal(elapsed(59_999), "59s");
  assert.equal(elapsed(60_000), "1m");
  assert.equal(elapsed(4 * 60_000 + 30_000), "4m");
  assert.equal(elapsed(3_599_999), "59m");
  assert.equal(elapsed(3_600_000), "1h");
  assert.equal(elapsed(72 * 60_000), "1h 12m");
});

test("elapsed: a clock behind or a bad value reads 0s", () => {
  assert.equal(elapsed(-5000), "0s");
  assert.equal(elapsed(Number.NaN), "0s");
});

test("nextTick: to the next second under a minute, then to the next minute", () => {
  assert.equal(nextTick(0), 1000);
  assert.equal(nextTick(12_400), 600);
  assert.equal(nextTick(59_500), 500);
  assert.equal(nextTick(60_000), 60_000);
  assert.equal(nextTick(90_000), 30_000);
  assert.ok(nextTick(-1) >= 1000, "never faster than once a second");
});

test("badge: 1 to 99, then 99+, named for what waits", () => {
  assert.equal(badgeText(3), "3");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(128), "99+");
  assert.equal(badgeLabel(3), "3 need you");
  assert.equal(badgeLabel(1), "1 needs you");
  assert.equal(badgeLabel(128), "more than 99 need you");
});
