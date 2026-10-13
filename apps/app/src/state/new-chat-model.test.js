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

import { pickerGroups, inputFor } from "./new-chat-model.js";
test("the picker has your assistant, the people (never you) and the agents, each filtered by the search", () => {
  const agents = [{ name: "kit", kind: "agent" }, { name: "juno", kind: "assistant", assistant: true }, { name: "rev", kind: "agent" }];
  const people = [{ id: "per_me", name: "Alex" }, { id: "per_c", name: "Chris Park", role: "member" }];
  const all = pickerGroups({ agents, people, me: "per_me" });
  assert.equal(all.assistant?.name, "juno");
  assert.deepEqual(all.people.map((p) => p.name), ["Chris Park"]);
  assert.deepEqual(all.agents.map((a) => a.name), ["kit", "rev"]);
  const f = pickerGroups({ agents, people, me: "per_me", q: "ch" });
  assert.deepEqual([f.assistant, f.people.length, f.agents.length], [null, 1, 0]);
  assert.equal(pickerGroups({ agents: [{ name: "kit" }], people: [] }).assistant, null);
});
test("what was picked becomes the work.chat.create people and agents, once each", () => {
  assert.deepEqual(inputFor({ people: ["per_c", "per_c"], agents: ["kit"] }), { people: ["per_c"], agents: ["kit"] });
});
test("with a project, its team's agents are a group of their own, ahead of the rest", () => {
  const g = pickerGroups({ agents: [{ name: "kit" }, { name: "rev" }], people: [], team: ["rev"] });
  assert.deepEqual([g.team.map((a) => a.name), g.agents.map((a) => a.name)], [["rev"], ["kit"]]);
});
