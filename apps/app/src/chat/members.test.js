import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { membersFrom, runThreadOf } from "./members.js";

test("a chat's members from work.chat.get: the viewer is You, a person without a name is Someone, agents by name", () => {
  // work.chat.get (core/work/index.js): { chat, open, people: [ids], agents: [names], slots, transcript }
  const got = { chat: { chat: "chat_1" }, open: true, people: ["per_me", "per_2", "per_3"], agents: ["kit"], slots: [] };
  const m = membersFrom(got, { actors: [{ id: "per_2", name: "Dana Okafor" }, { id: "per_3", name: "per_3" }] }, "per_me");
  assert.deepEqual(m.map((x) => [x.id, x.name, x.family]), [["person:per_me", "You", "person"], ["person:per_2", "Dana Okafor", "person"], ["person:per_3", "Someone", "person"], ["agent:kit", "kit", "assistant"]]);
  assert.deepEqual(membersFrom(null, null, null), []);
});

test("the run's thread is the first slot's thread work.chat.get names; none before a run starts", () => {
  assert.equal(runThreadOf({ slots: [{ slot: "model:claude/default#1", thread: "th_1" }] }), "th_1");
  assert.equal(runThreadOf({ slots: [] }), null);
  assert.equal(runThreadOf(null), null);
});
