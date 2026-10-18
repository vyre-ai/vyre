// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { projectChatPlan } from "./project-chat-model.js";

test("what a device does with a project chat's answer: make it, add the missing, drop the extra, wait, or nothing", () => {
  assert.deepEqual(projectChatPlan({ chat: null, id: "chat_pj_1", needs_ring: true, people: ["per_a", "per_b"] }), { do: "make", id: "chat_pj_1", people: ["per_a", "per_b"] });
  assert.deepEqual(projectChatPlan({ chat: null, id: "chat_pj_1", pending: true, missing: ["per_a"] }), { do: "wait" });
  assert.deepEqual(projectChatPlan({ chat: "chat_pj_1", member: false, waiting: true }), { do: "wait" });
  assert.deepEqual(projectChatPlan({ chat: "chat_pj_1", member: true, people: ["per_a"], missing: ["per_b"], extra: [] }), { do: "add", chat: "chat_pj_1", people: ["per_b"] });
  assert.deepEqual(projectChatPlan({ chat: "chat_pj_1", member: true, people: ["per_a", "per_c"], missing: [], extra: ["per_c"] }), { do: "drop", chat: "chat_pj_1", people: ["per_c"], remaining: ["per_a"] });
  assert.deepEqual(projectChatPlan({ chat: "chat_pj_1", member: true, people: ["per_a"], missing: [], extra: [] }), { do: "none" });
  assert.deepEqual(projectChatPlan(null), { do: "none" });
});
