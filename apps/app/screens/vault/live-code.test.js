// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupDigits, secondsLeft } from "./live-code.js";

test("a six-digit code is grouped, and the seconds count down from the answer", () => {
  assert.equal(groupDigits("492039"), "492 039");
  assert.equal(groupDigits("492 039"), "492 039");
  assert.equal(groupDigits("12345678"), "1234 5678");
  assert.equal(groupDigits(""), "");
  const at = 1_800_000_000_000;
  assert.equal(secondsLeft({ remaining: 10, at }, at + 4_200), 6);
  assert.equal(secondsLeft({ remaining: 10, at }, at + 10_000), 0);
  assert.equal(secondsLeft({ remaining: 10, at }, at + 15_000), 0);
});
