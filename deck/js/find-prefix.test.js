// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrefix, PREFIX_HINT } from "./find-prefix.js";

test("parsePrefix: a letter and a space narrows; the words after it are the query", () => {
  assert.deepEqual(parsePrefix("p harlow"), { prefix: "p", scope: "projects", rest: "harlow" });
  assert.deepEqual(parsePrefix("t  invoice run"), { prefix: "t", scope: "chats", rest: "invoice run" });
  assert.deepEqual(parsePrefix("U juno"), { prefix: "u", scope: "people", rest: "juno" });
  assert.deepEqual(parsePrefix("  p harlow"), { prefix: "p", scope: "projects", rest: "harlow" }, "leading space is forgiven");
  assert.deepEqual(parsePrefix("p "), { prefix: "p", scope: "projects", rest: "" }, "the prefix alone lists them all");
});

test("parsePrefix: a word that starts with the letter, or no space, is not a prefix", () => {
  for (const q of ["park", "pt harlow", "p", "tuesday", "u", "x harlow", "", "a p b"]) assert.equal(parsePrefix(q), null, q);
  assert.equal(PREFIX_HINT, "p projects, t threads, u people");
});
