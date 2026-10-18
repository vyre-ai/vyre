// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { keptMentions } from "./draft-mentions.js";

const file = { kind: "drive", id: "docs:report.pdf", name: "report.pdf" };

test("a draft keeps the tags whose word is still in its text", () => {
  assert.deepEqual(keptMentions("Read #report.pdf now", [file]), [file]);
  assert.deepEqual(keptMentions("Read it now", [file]), []);
});

test("a malformed tag is dropped", () => {
  assert.deepEqual(keptMentions("#x", [{ kind: "drive", id: "", name: "x" }, /** @type {any} */ (null)]), []);
});
