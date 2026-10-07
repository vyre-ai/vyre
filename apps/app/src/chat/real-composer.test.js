import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { modelChoices, peopleFor, recordPicks, switchCall } from "./real-composer.js";

const ROWS = [
  { id: "claude", label: "Claude", accounts: [{ id: "default", label: "Default", signed_in: true, default: true }], models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
  { id: "codex", label: "Codex", accounts: [{ id: "x1", label: "Work", signed_in: true }], models: [{ id: "gpt-5", label: "GPT-5" }] },
  { id: "grok", label: "Grok", accounts: [], models: [{ id: "grok-4", label: "Grok 4" }] },
];

test("the models offered are those of the signed-in accounts, with the answering one marked", () => {
  const { models, model } = modelChoices(ROWS, { provider: "claude", account: "default", model: "sonnet" });
  assert.deepEqual(models.map((m) => m.label), ["Claude · Opus", "Claude · Sonnet", "Codex · GPT-5"]);
  assert.equal(model, "claude|default|sonnet");
  assert.equal(modelChoices([ROWS[0]], { provider: "claude", model: "opus" }).models[0].label, "Opus", "one account: the plain model name");
  assert.deepEqual(modelChoices(null), { models: [], model: undefined });
});

test("switching a model asks threads.chat-switch with the slot, provider, model and account", () => {
  const cur = { provider: "claude", account: "default" };
  assert.deepEqual(switchCall("t1", "claude|default|opus", ROWS, cur), { tool: "threads.chat-switch", input: { chat: "t1", provider: "claude", account: "default", model: "opus" } });
  assert.deepEqual(switchCall("t1", "claude|default|opus", ROWS, cur, "model:codex/gpt-5#1").input, { chat: "t1", slot: "model:codex/gpt-5#1", provider: "claude", model: "opus", account: "default" });
  assert.equal(switchCall("t1", "bad", ROWS, cur), null);
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
