// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isShelvedTool, SHELVED_TOOLS } from "../lib/tools-shelved.js";

test("shelved tools: glass.files, term.open and threads.shell are hidden from catalogs", () => {
  assert.ok(isShelvedTool("glass.files.list"));
  assert.ok(isShelvedTool("term.open"));
  assert.ok(isShelvedTool("threads.shell"));
  assert.ok(!isShelvedTool("chrome.snapshot"));
  assert.equal(SHELVED_TOOLS.size >= 3, true);
});
