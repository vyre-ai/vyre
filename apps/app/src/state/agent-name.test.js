// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentWords, displayName } from "./agent-name.js";

test("an agent id is said in words, and a name that is already someone's words is left alone", () => {
  assert.equal(agentWords("engineer"), "Engineer");
  assert.equal(agentWords("ads-writer"), "Ads Writer");
  assert.equal(agentWords("Juno Two"), "Juno Two");
  assert.equal(agentWords("per_abc"), "per_abc", "an id that is not an agent's is not touched");
  assert.equal(agentWords(""), "");
});

test("the assistant is shown as the person typed it when that is its id's; any other agent as its id in words", () => {
  assert.equal(displayName({ name: "qi", kind: "assistant", instructions: "Your name is Qi. You work for Sam." }), "Qi");
  assert.equal(displayName({ name: "qi", kind: "assistant", instructions: "Your name is Zed." }), "Qi");
  assert.equal(displayName({ name: "engineer", kind: "agent", builtin: true }), "Engineer");
});
