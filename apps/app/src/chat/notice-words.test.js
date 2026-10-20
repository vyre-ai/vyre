import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { personWords } from "./notice-words.js";

test("a person's model pick reads as their name in the chat, never as an id", () => {
  const names = new Map([["per_sam", "Sam"]]);
  assert.equal(personWords("{person:per_sam} switched to GPT-5.5", (id) => names.get(id) ?? "Someone"), "Sam switched to GPT-5.5");
  assert.equal(personWords("{person:per_zz} switched to Grok 4.7", () => ""), "Someone switched to Grok 4.7");
  assert.equal(personWords("Switched to Codex.", () => "x"), "Switched to Codex.", "a line with no person is left as it is");
});
