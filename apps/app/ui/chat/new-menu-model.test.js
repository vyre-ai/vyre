// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { newMenuRows, firstRow, newMenuAgents } from "./new-menu-model.js";
import { convosFrom } from "./convo-model.js";

const agents = [{ name: "Assistant", role: "Yours" }, { name: "Engineer" }, { name: "Scout" }];
const people = [{ id: "per_dana", name: "Dana Marsh" }, { id: "per_sam", name: "Sam Reyes" }];

test("nothing typed: every agent and person, then New group, New agent, New Flow", () => {
  const r = newMenuRows("", agents, people);
  assert.deepEqual(r.agents.map((x) => x.label), ["Assistant", "Engineer", "Scout"]);
  assert.deepEqual(r.people.map((x) => x.label), ["Dana Marsh", "Sam Reyes"]);
  assert.deepEqual(r.make.map((x) => x.label), ["New group", "New agent", "New Flow"]);
  assert.equal(firstRow(r)?.label, "Assistant");
});

test("a typed word narrows agents and people, best first, and drops the New rows", () => {
  const r = newMenuRows("sa", agents, people);
  assert.deepEqual(r.agents, [], "no agent has 'sa' in its name");
  assert.deepEqual(r.people.map((x) => x.label), ["Sam Reyes"]);
  assert.deepEqual(r.make, []);
  const both = newMenuRows("an", agents, people);
  assert.deepEqual(both.agents.map((x) => x.label), ["Assistant"], "holds 'an' (assistANt)");
  assert.deepEqual(both.people.map((x) => x.label), ["Dana Marsh"], "Dana holds 'an'");
});

test("nothing matches: no rows and no first row", () => {
  const r = newMenuRows("zzz", agents, people);
  assert.equal(firstRow(r), null);
});

test("the New menu lists your assistant (Qi) and the Space's agents by name, once each: typing Qi finds it", () => {
  const chat = (/** @type {any} */ o) => ({ id: "c", title: "T", project: "", people: [], agents: [], status: "idle", last: 0, line: "", asks: 0, unread: 0, open: true, pinned: "", ...o });
  const convos = convosFrom({ assistantName: "Qi", assistantAgent: "qi", chats: [chat({ id: "p", title: "Assistant", pinned: "assistant", last: 1 }), chat({ id: "t1", title: "New chat", agents: ["engineer"], last: 5 }), chat({ id: "t2", title: "New chat", agents: ["engineer"], last: 3 }), chat({ id: "s", title: "Sam", people: ["per_sam"], last: 2 })],
    agents: [{ name: "engineer" }, { name: "scout", title: "Scout" }], people: [] });
  const agents = newMenuAgents(convos);
  assert.deepEqual(agents.map((a) => [a.name, a.role ?? ""]), [["Qi", "Your assistant"], ["Engineer", ""], ["Scout", ""]]);
  assert.deepEqual(newMenuRows("Qi", agents, []).agents.map((r) => r.label), ["Qi"], "never \"Nobody by that name\" for your own assistant");
  assert.deepEqual(newMenuRows("eng", agents, []).agents.map((r) => r.label), ["Engineer"]);
});
