// @ts-check
// createAgent: ticking "Give it its own computer" ends with the agent having one, as the agent
// page's "Give <name> a computer" button does.
import test from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "./agent-create.js";

/** A fake attempt(): records each call and answers from `answers` by tool name. */
const fake = (/** @type {Record<string, any>} */ answers) => {
  /** @type {[string, any][]} */ const calls = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.push([tool, input]); return answers[tool] || { data: null }; };
  return { calls, call };
};

test("createAgent: a computer asked for and recorded by agents.create needs no second call", async () => {
  const f = fake({ "agents.create": { data: { name: "kit", computer: true } } });
  const r = await createAgent({ name: "kit", kind: "agent", projects: ["harlow-legal"], computer: true }, f.call);
  assert.deepEqual(f.calls.map(c => c[0]), ["agents.create"]);
  assert.equal(f.calls[0][1].computer, true, "your server's tick is in the create payload");
  assert.equal(r.data.computer, true);
  assert.equal(r.error, null);
  assert.equal(r.computerError, null);
});

test("createAgent: an agent made without the computer it asked for gets it through agents.update, as the button does", async () => {
  const f = fake({ "agents.create": { data: { name: "kit", computer: false } }, "agents.update": { data: { name: "kit", computer: true } } });
  const r = await createAgent({ name: "kit", kind: "agent", projects: [], computer: true }, f.call);
  assert.deepEqual(f.calls, [["agents.create", { name: "kit", kind: "agent", projects: [], computer: true }], ["agents.update", { name: "kit", computer: true }]]);
  assert.equal(r.data.computer, true);
});

test("createAgent: no computer asked for, none given and no update sent", async () => {
  const f = fake({ "agents.create": { data: { name: "kit", computer: false } } });
  const r = await createAgent({ name: "kit", computer: false }, f.call);
  assert.deepEqual(f.calls.map(c => c[0]), ["agents.create"]);
  assert.equal(r.data.computer, false);
});

test("createAgent: a refused create makes nothing and sends no update", async () => {
  const f = fake({ "agents.create": { error: { message: "there is already an agent kit" } } });
  const r = await createAgent({ name: "kit", computer: true }, f.call);
  assert.deepEqual(f.calls.map(c => c[0]), ["agents.create"]);
  assert.match(r.error.message, /already an agent kit/);
  assert.equal(r.data, null);
});

test("createAgent: a refused computer leaves the agent made and says why apart from error", async () => {
  const f = fake({ "agents.create": { data: { name: "kit", computer: false } }, "agents.update": { error: { message: "agents is busy" } } });
  const r = await createAgent({ name: "kit", computer: true }, f.call);
  assert.equal(r.error, null);
  assert.match(r.computerError.message, /busy/);
  assert.equal(r.data.computer, false);
});

test("createAgent: an update that answers without the agent (a fixture's { ok: true }) counts as given", async () => {
  const f = fake({ "agents.create": { data: { name: "new-agent", kind: "agent" } }, "agents.update": { data: { ok: true } } });
  const r = await createAgent({ name: "kit", computer: true }, f.call);
  assert.deepEqual(f.calls[1], ["agents.update", { name: "kit", computer: true }], "the update names the agent asked for");
  assert.equal(r.data.computer, true);
});
