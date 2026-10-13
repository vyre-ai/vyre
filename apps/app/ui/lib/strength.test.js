import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { passwordStrength } from "./strength.js";

test("empty has no level", () => assert.equal(passwordStrength("").score, 0));
test("short and common are weak and say what to do", () => {
  assert.equal(passwordStrength("abc123").score, 1);
  assert.match(passwordStrength("abc123").hint, /at least 8/);
  assert.equal(passwordStrength("password123").score, 1);
});
test("a four word phrase is strong", () => assert.equal(passwordStrength("river amber stone quiet").score, 4));
test("length and variety raise the level", () => {
  assert.equal(passwordStrength("abcdefgh").score, 2);
  assert.equal(passwordStrength("Abcdef12ghij").score, 3);
});
