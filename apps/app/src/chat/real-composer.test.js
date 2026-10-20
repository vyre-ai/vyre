import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { doingLine, peopleFor, recordPicks, switchCall } from "./real-composer.js";

test("a person's model pick asks threads.chat-switch with the slot, the provider, the model, their own account and the effort", () => {
  const pick = { account: { id: "ac_1" }, model: { id: "lab-deep-2", provider: "claude" } };
  assert.deepEqual(switchCall("t1", pick), { tool: "threads.chat-switch", input: { chat: "t1", provider: "claude", model: "lab-deep-2", account: "ac_1" } });
  assert.deepEqual(switchCall("t1", { account: { id: "ac_2" }, model: { id: "x-ai/grok-4.7", provider: "openrouter" } }, "model:codex/gpt-5#1", "high")?.input, { chat: "t1", slot: "model:codex/gpt-5#1", provider: "openrouter", model: "x-ai/grok-4.7", account: "ac_2", effort: "high" });
  assert.equal(switchCall("t1", null), null);
});

test("people to mention: this chat's first, then the space's actors and the person's agents, once each, never the viewer", () => {
  const p = peopleFor({ here: [{ name: "juno", family: "assistant" }], actors: { actors: [{ id: "per_me", name: "me", family: "person" }, { id: "per_d", name: "Dana", family: "person" }, { id: "x", name: "Juno", family: "assistant" }] }, agents: [{ name: "kit" }], viewer: "per_me" });
  assert.deepEqual(p, [{ name: "juno", id: "juno", family: "assistant" }, { name: "Dana", id: "per_d", family: "person" }, { name: "kit", id: "kit", family: "assistant" }]);
});

test("records to tag carry their urn and how many sealed fields hold a value; internal types are left out", () => {
  const world = { types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text" }, { name: "ssn", kind: "sealed" }, { name: "pw", kind: "sealed" }] }, { name: "def-x", label: "Def", fields: [] }],
    byType: { contact: [{ urn: "vyre://s/contact/c1", id: "c1", data: { name: "Jane Doe", ssn: { sealed: "SSN", present: true }, pw: { sealed: "PW", present: false } } }], "def-x": [{ id: "d", data: {} }] } };
  assert.deepEqual(recordPicks(world, (d, r) => r.data.name), [{ name: "Jane Doe", type: "Contact", sealed: 1, urn: "vyre://s/contact/c1", kind: "record" }]);
  assert.deepEqual(recordPicks(null, () => ""), []);
});

test("the @ picker says what each live session is doing and where", () => {
  const agents = [{ name: "kit", doing: "working", projects: ["billing"] }, { name: "juno", doing: "waiting on your answer", projects: "*" }, { name: "sage", doing: "not started", projects: [] }];
  const people = peopleFor({ actors: [{ id: "x", name: "kit", family: "agent" }], agents, viewer: "me", here: [] });
  assert.equal(people.find((p) => p.name === "kit")?.doing, "Working on billing", "an agent already listed as an actor still gets its line");
  assert.equal(people.find((p) => p.name === "juno")?.doing, "Waiting on your answer");
  assert.equal(people.find((p) => p.name === "sage")?.doing, undefined);
  assert.equal(doingLine(null), "");
  assert.equal(doingLine({ doing: "idle", projects: ["a", "b"] }), "Idle");
});
