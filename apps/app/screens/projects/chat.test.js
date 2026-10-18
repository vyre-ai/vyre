import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chatAnswer, chatPath } from "./chat.js";

test("the project chat answers as open, missing (the tool is not there yet) or failed, and never throws", () => {
  assert.deepEqual(chatAnswer({ data: { chat: "chat_1", missing: [], extra: [] } }), { state: "open", chat: "chat_1", missing: [], extra: [] });
  assert.deepEqual(chatAnswer({ data: { chat: "chat_1", missing: ["per_a"], extra: ["per_b"] } }), { state: "open", chat: "chat_1", missing: ["per_a"], extra: ["per_b"] });
  for (const code of ["unknown_tool", "no_such_tool", "not_found"]) assert.equal(chatAnswer({ error: { code, message: "no such tool work.project.chat" } }).state, "missing", code);
  assert.equal(chatAnswer({ error: { code: "not_found", message: "no such project" } }).state, "failed", "a project that is not there is a failure, not a missing tool");
  assert.deepEqual(chatAnswer({ error: { code: "denied", message: "you cannot open it" } }), { state: "failed", why: "you cannot open it" });
  assert.equal(chatAnswer({ data: {} }).state, "failed");
  assert.equal(chatAnswer(undefined).state, "failed");
});

test("the chat opens at its own page", () => {
  assert.equal(chatPath("chat_1"), "/u/chats/chat_1");
  assert.equal(chatPath("a b"), "/u/chats/a%20b");
});
