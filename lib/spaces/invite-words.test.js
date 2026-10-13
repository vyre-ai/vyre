import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWords, sameWords, triesCounter, MAX_TRIES } from "./invite-words.js";

test("words compare after lower case, punctuation and spacing; empty or missing never matches", () => {
  assert.equal(normalizeWords("  Apple,  BRIDGE\tcloud-delta "), "apple bridge cloud delta");
  assert.equal(sameWords("Apple bridge  cloud delta", "apple bridge cloud delta"), true);
  assert.equal(sameWords("apple bridge cloud", "apple bridge cloud delta"), false);
  assert.equal(sameWords("", ""), false);
  assert.equal(sameWords(undefined, "apple bridge cloud delta"), false);
  assert.equal(sameWords("apple bridge cloud delta", null), false);
});

test("an invite stops listening after its wrong tries, and a confirmation clears the count", () => {
  const t = triesCounter();
  for (let i = 0; i < MAX_TRIES - 1; i++) t.miss("inv1");
  assert.equal(t.spent("inv1"), false);
  t.miss("inv1");
  assert.equal(t.spent("inv1"), true);
  assert.equal(t.spent("inv2"), false, "another invite is its own count");
  t.clear("inv1");
  assert.equal(t.spent("inv1"), false);
});
