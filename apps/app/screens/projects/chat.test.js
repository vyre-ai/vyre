import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chatAnswer, chatNote, chatPath, chatState } from "./chat.js";

const full = (o = {}) => ({ data: { chat: "chat_pj_ab12", id: "chat_pj_ab12", member: true, people: ["per_a"], missing: [], extra: [], readonly: [], readonly_for_you: false, ...o } });

test("the project chat answers as open, waiting, pending, missing (the tool is not there yet) or failed, and never throws", () => {
  assert.deepEqual(chatAnswer(full()), { state: "open", chat: "chat_pj_ab12", adding: 0, readOnly: false });
  assert.deepEqual(chatAnswer(full({ missing: ["per_a", "per_b"], extra: ["per_c"], readonly_for_you: true })), { state: "open", chat: "chat_pj_ab12", adding: 2, readOnly: true });
  assert.deepEqual(chatAnswer({ data: { chat: "chat_pj_ab12", member: false, waiting: true } }), { state: "waiting" }, "on the team, not in the chat yet");
  assert.deepEqual(chatAnswer({ data: { chat: null, pending: true } }), { state: "pending" }, "a viewer, and nobody has made it");
  assert.deepEqual(chatAnswer({ data: { chat: null, id: "chat_pj_ab12", needs_ring: true, people: ["per_a"] } }), { state: "making" }, "a writer, and no device has made the ring yet");
  for (const code of ["unknown_tool", "no_such_tool", "not_found"]) assert.equal(chatAnswer({ error: { code, message: "no such tool work.project.chat" } }).state, "missing", code);
  assert.equal(chatAnswer({ error: { code: "not_found", message: "no such project" } }).state, "failed", "a project the person cannot read is a failure, not a missing tool");
  assert.deepEqual(chatAnswer({ error: { code: "denied", message: "you cannot open it" } }), { state: "failed", why: "you cannot open it" });
  assert.equal(chatAnswer({ data: {} }).state, "failed");
  assert.equal(chatAnswer(undefined).state, "failed");
});

test("the line under the button says what is happening, or nothing", () => {
  assert.equal(chatNote(chatAnswer(full())), null);
  assert.equal(chatNote(chatAnswer(full({ missing: ["per_a"] }))), "Adding 1 person to the group chat...");
  assert.equal(chatNote(chatAnswer(full({ missing: ["per_a", "per_b", "per_c"] }))), "Adding 3 people to the group chat...");
  assert.equal(chatNote(chatAnswer(full({ readonly_for_you: true }))), "You can read the group chat. Only the team writes in it.");
  assert.match(chatNote(chatAnswer({ data: { chat: "x", member: false, waiting: true } })), /teammate.s device first/);
  assert.match(chatNote(chatAnswer({ data: { chat: null, pending: true } })), /Nobody has made/);
  assert.equal(chatNote(chatAnswer({ error: { code: "unknown_tool", message: "" } })), null);
  assert.equal(chatNote({ state: "making" }), null, "a team member is never shown that nobody has made it");
});

test("the chat opens at its own page", () => {
  assert.equal(chatPath("chat_1"), "/u/chats/chat_1");
  assert.equal(chatPath("a b"), "/u/chats/a%20b");
});

test("ensureProjectChat and the read together: open with what the read adds, waiting, pending for a viewer, nothing without the tool, else a failure with the keys' line", () => {
  const open = chatAnswer(full({ missing: ["per_a"], readonly_for_you: true }));
  assert.deepEqual(chatState({ chat: "chat_pj_ab12", state: "ready" }, open), { state: "open", chat: "chat_pj_ab12", adding: 1, readOnly: true });
  assert.deepEqual(chatState({ chat: "chat_pj_ab12", state: "ready" }, { state: "failed", why: "x" }), { state: "open", chat: "chat_pj_ab12", adding: 0, readOnly: false }, "made on this device, the read could not add detail");
  assert.deepEqual(chatState({ chat: null, state: "waiting" }, { state: "making" }), { state: "waiting" });
  assert.deepEqual(chatState({ chat: null, state: "none" }, chatAnswer({ data: { chat: null, pending: true } })), { state: "pending" }, "a viewer never makes it");
  assert.deepEqual(chatState({ chat: null, state: "none" }, { state: "missing" }), { state: "missing" });
  assert.deepEqual(chatState({ chat: null, state: "none", say: "This device can't start private chats yet." }, { state: "making" }), { state: "waiting" } , "needs_ring while this device cannot make one reads as waiting");
  assert.deepEqual(chatState({ chat: null, state: "none", say: "Some devices can't open private chats yet." }, { state: "failed", why: "denied" }), { state: "failed", why: "Some devices can't open private chats yet." });
});
