import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { agentChoices, createInput, chatIdOf } from "./new-chat-model.js";

test("the assistant is first and the default", () => {
  const c = agentChoices([{ name: "kit", kind: "agent" }, { name: "juno", kind: "assistant" }, { bad: 1 }]);
  assert.deepEqual(c.map((a) => a.name), ["juno", "kit"]);
  assert.equal(c[0].assistant, true);
  assert.deepEqual(agentChoices(null), []);
});

test("work.chat.create lists a space or project agent by name, and never the person's own assistant", () => {
  assert.deepEqual(createInput({ agent: { name: "kit", assistant: false } }), { people: [], agents: ["kit"] });
  assert.deepEqual(createInput({ agent: { name: "juno", assistant: true } }), { people: [], agents: [] });
  assert.deepEqual(createInput({ agent: null, title: " Lease " }), { title: "Lease", people: [], agents: [] });
});

test("the new chat's id is the chat field of work.chat.create's answer", () => {
  assert.equal(chatIdOf({ chat: "chat_1", title: null, project: null, people: ["per_1"], agents: [] }), "chat_1");
  assert.equal(chatIdOf({}), null);
});
