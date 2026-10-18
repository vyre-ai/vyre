// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { forwardText } from "./forward-model.js";

test("a forward says where it came from and quotes every line, blank ones too", () => {
  assert.equal(forwardText("Three who are free.\n\nMira Holt, $900", "Spring launch"), "Forwarded from Spring launch\n\n> Three who are free.\n>\n> Mira Holt, $900");
  assert.equal(forwardText("one line  ", ""), "Forwarded from a chat\n\n> one line");
});
