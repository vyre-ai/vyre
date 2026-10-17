// @ts-check
import "../../scripts/mac-test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createChatPrefs } from "./chat-prefs.js";

const person = { hops: [{ actor: { kind: "person", id: "per_alice" } }] };

test("work chat prefs: mute and list-pin round-trip and clear when both off", () => {
  const db = new DatabaseSync(":memory:");
  const p = createChatPrefs({ db });
  assert.deepEqual(p.get(person), { muted: [], pinned: [] });
  p.set(person, { chat: "chat_a", muted: true });
  p.set(person, { chat: "chat_b", pinned: true });
  assert.deepEqual(p.get(person), { muted: ["chat_a"], pinned: ["chat_b"] });
  p.set(person, { chat: "chat_a", muted: false });
  assert.deepEqual(p.get(person), { muted: [], pinned: ["chat_b"] });
  p.set(person, { chat: "chat_b", pinned: false });
  assert.deepEqual(p.get(person), { muted: [], pinned: [] });
});

test("work chat prefs: isMuted", () => {
  const db = new DatabaseSync(":memory:");
  const p = createChatPrefs({ db });
  assert.equal(p.isMuted("per_alice", "chat_x"), false);
  p.set(person, { chat: "chat_x", muted: true });
  assert.equal(p.isMuted("per_alice", "chat_x"), true);
  assert.equal(p.isMuted("per_bob", "chat_x"), false);
});
