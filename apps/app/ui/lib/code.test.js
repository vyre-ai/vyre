import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { codeComplete, formatCode } from "./code.js";

test("groups, uppercases and ignores spaces and hyphens", () => {
  assert.equal(formatCode("wink4f7k9qz2", { prefix: "WINK" }), "WINK-4F7K-9QZ2");
  assert.equal(formatCode("wink-4f7k 9q", { prefix: "WINK" }), "WINK-4F7K-9Q");
});
test("the prefix is not doubled when pasted and shows from the first key", () => {
  assert.equal(formatCode("WINK-WINK", { prefix: "WINK" }), "WINK-WINK");
  assert.equal(formatCode("w", { prefix: "WINK" }), "WINK");
  assert.equal(formatCode("", { prefix: "WINK" }), "");
});
test("no prefix, three groups", () => {
  assert.equal(formatCode("abcd1234efgh", { groups: [4, 4, 4] }), "ABCD-1234-EFGH");
  assert.equal(formatCode("abcdefghijklmnop", { groups: [4, 4] }), "ABCD-EFGH");
});
test("complete means every group is full", () => {
  assert.equal(codeComplete("WINK-4F7K-9QZ2", { prefix: "WINK" }), true);
  assert.equal(codeComplete("WINK-4F7K-9Q", { prefix: "WINK" }), false);
  assert.equal(codeComplete("4F7K9QZ2", { prefix: "WINK" }), true);
});
