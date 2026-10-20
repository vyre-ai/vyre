import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { doingLine, memberNames, peopleFor, recordPicks, shownName, switchCall } from "./real-composer.js";

test("a person's model pick asks threads.chat-switch with the slot, the provider, the model, their own account and the effort", () => {
  const pick = { account: { id: "ac_1" }, model: { id: "lab-deep-2", provider: "claude" } };
  assert.deepEqual(switchCall("t1", pick), { tool: "threads.chat-switch", input: { chat: "t1", provider: "claude", model: "lab-deep-2", account: "ac_1" } });
  assert.deepEqual(switchCall("t1", { account: { id: "ac_2" }, model: { id: "x-ai/grok-4.7", provider: "openrouter" } }, "model:codex/gpt-5#1", "high")?.input, { chat: "t1", slot: "model:codex/gpt-5#1", provider: "openrouter", model: "x-ai/grok-4.7", account: "ac_2", effort: "high" });
  assert.equal(switchCall("t1", null), null);
});

test("people to mention: this chat's first, then the space's actors and the person's agents, once each, never the viewer", () => {
  const p = peopleFor({ here: [{ name: "juno", family: "assistant" }], actors: { actors: [{ id: "per_me", name: "me", family: "person" }, { id: "per_d", name: "Dana", family: "person" }, { id: "x", name: "Juno", family: "assistant" }] }, agents: [{ name: "kit" }], viewer: "per_me" });
  assert.deepEqual(p, [{ name: "Juno", id: "juno", family: "assistant" }, { name: "Dana", id: "per_d", family: "person" }, { name: "Kit", id: "kit", family: "assistant" }], "an agent by its words, its id kept for the mention");
});

test("the @ list never shows a raw id: a person is named, else by their username from the member list, else left out", () => {
  const names = memberNames({ members: [{ person: "per_q7k2m9x4wdn3", name: "dana.vyre.run" }, { person: "per_nobodyknows1", name: null }] });
  assert.deepEqual(names, { per_q7k2m9x4wdn3: "dana.vyre.run" });
  const p = peopleFor({ actors: { actors: [{ id: "per_q7k2m9x4wdn3", name: "per_q7k2m9x4wdn3", family: "person" }, { id: "per_nobodyknows1", name: "per_nobodyknows1", family: "person" }] },
    agents: [{ name: "qi", kind: "assistant" }, { name: "engineer" }], viewer: "per_me", here: [{ name: "Someone", family: "person" }], names });
  assert.deepEqual(p.map((x) => [x.name, x.id]), [["dana", "per_q7k2m9x4wdn3"], ["Qi", "qi"], ["Engineer", "engineer"]]);
  for (const x of p) assert.doesNotMatch(x.name, /^per_/);
  assert.equal(shownName("per_abcdef123", "person", "person:per_abcdef123", { per_abcdef123: "dana.vyre.run" }), "dana", "a stream id with its person: prefix finds the member too");
  assert.equal(shownName("per_abcdef123", "assistant"), "");
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
  assert.equal(people.find((p) => p.name === "Kit")?.doing, "Working on billing", "an agent already listed as an actor still gets its line");
  assert.equal(people.find((p) => p.name === "Juno")?.doing, "Waiting on your answer");
  assert.equal(people.find((p) => p.name === "Sage")?.doing, undefined);
  assert.equal(doingLine(null), "");
  assert.equal(doingLine({ doing: "idle", projects: ["a", "b"] }), "Idle");
});
