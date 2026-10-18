// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { engineerChatPlan, engineerThreadPeople } from "./engineer-chat-model.js";

test("work.engineer.chat: a person who may not see it gets nothing; the rest follows the project chat's plan", () => {
  assert.deepEqual(engineerChatPlan(null), { do: "none" });
  assert.deepEqual(engineerChatPlan({ chat: null, needs_ring: true, id: "chat_eng_1", people: ["per_a"] }), { do: "make", id: "chat_eng_1", people: ["per_a"] });
  assert.deepEqual(engineerChatPlan({ chat: "chat_eng_1", member: true, people: ["per_a"], missing: ["per_b"], extra: [] }), { do: "add", chat: "chat_eng_1", people: ["per_b"] });
  assert.deepEqual(engineerChatPlan({ chat: "chat_eng_1", member: true, people: ["per_a"], missing: [], extra: [] }), { do: "none" });
});

test("a new Engineer thread goes to the chat's people, as work.chat.thread.new takes them", () => {
  assert.deepEqual(engineerThreadPeople({ chat: "c", people: ["per_a", "per_b"] }, "per_a"), ["per_b"]);
  assert.deepEqual(engineerThreadPeople({ chat: "c", people: ["per_a"] }, "per_a"), []);
  assert.deepEqual(engineerThreadPeople(null, "per_a"), []);
});
