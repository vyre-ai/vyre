// @ts-check
// The model registry in a real vyred in a temp home: fake sources (the sessions snapshot, the switchboard's key fetch, OpenRouter on loopback), the first fill silent, a later model a card, nothing run
// without a yes.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { allowLoopbackForTests } from "../../lib/http.js";
import { EVAL_TYPES } from "../../lib/model-registry.js";
allowLoopbackForTests();

/** An OpenRouter on a free port whose list a test can change. */
async function openrouter(t, list) {
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(list.value)); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  return `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
}
const OR = { data: [{ id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"] }] };

async function box(t, api, extra = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] }, ...extra }));
  const saved = process.env.VYRE_OPENROUTER_API;
  process.env.VYRE_OPENROUTER_API = api;
  const d = await start({ root, log: () => {} });
  t.after(async () => { await d.stop(); if (saved === undefined) delete process.env.VYRE_OPENROUTER_API; else process.env.VYRE_OPENROUTER_API = saved; });
  /** @type {any[]} */ const events = [];
  d.events?.on?.("models.new", (/** @type {any} */ e) => events.push(e));
  const call = (/** @type {string} */ tool, input = {}, caller = "cli") => d.registry.call(tool, input, caller);
  return { d, call, events, root };
}

test("models: a refresh fills the registry from the CLI-reported models, joins OpenRouter's price and context, and says where each source stands", async t => {
  const list = { value: OR };
  const b = await box(t, await openrouter(t, list));
  const first = (await b.call("models.refresh")).data;
  assert.equal(first.refreshed, true);
  const status = (await b.call("models.status")).data;
  const or = status.sources.find((/** @type {any} */ s) => s.name === "openrouter");
  assert.equal(or.ok, true);
  assert.equal(or.rows, 1);
  const api = status.sources.find((/** @type {any} */ s) => s.name === "api");
  assert.deepEqual([api.ok, api.rows], [true, 0], "no accounts with keys here: nothing to ask, nothing failed");
  assert.equal(status.sources.find((/** @type {any} */ s) => s.name === "cli").ok, true);
  const list2 = (await b.call("models.list")).data;
  assert.ok(list2.count >= 1, "the sessions module's own models fill it");
  assert.ok(list2.models.every((/** @type {any} */ m) => typeof m.id === "string" && Array.isArray(m.sources)));
  assert.equal((await b.call("models.refresh")).data.refreshed, false, "at most once a minute");
});

test("models: a refresh with the same models is quiet; the eval tools refuse a model nobody proposed and anyone but a person", async t => {
  const b = await box(t, await openrouter(t, { value: OR }));
  await b.call("models.refresh");
  assert.deepEqual((await b.call("models.evals")).data.evals, []);
  assert.equal((await b.call("models.eval-approve", { model: "claude/nope" })).error.code, "not_found");
  assert.equal((await b.call("models.eval-approve", { model: "claude/nope" }, "mcp:agent:juno")).error.code, "denied");
  assert.equal((await b.call("models.get", { id: "nope" })).error.code, "not_found");
  assert.deepEqual((await b.call("models.eval-queue")).data.queue, []);
  assert.equal(EVAL_TYPES.length > 0, true);
});

test("models: the first fill is silent; a model first seen later is announced once and proposes its evals with a cost from its own price; nothing runs without a yes", async t => {
  const list = { value: OR };
  const b = await box(t, await openrouter(t, list), { models: { min_ask_ms: 0 } });
  const learn = (/** @type {string} */ id, /** @type {string} */ label) => b.d.registry.call("sessions.providers.learn", { provider: "codex", models: [{ id, label }] }, "module:threads");
  assert.equal((await learn("gpt-5", "GPT-5")).error, undefined);
  await b.call("models.refresh");
  assert.equal(b.events.length, 0, "the first fill is silent");
  assert.deepEqual((await b.call("models.evals")).data.evals, []);
  // a new model appears (and one that was there stays)
  assert.equal((await learn("gpt-5.5", "GPT-5.5")).error, undefined);
  await b.call("models.refresh");
  assert.deepEqual(b.events.map((/** @type {any} */ e) => e.model || (e.payload && e.payload.model)), ["codex/gpt-5.5"]);
  const ev = (await b.call("models.evals", { state: "pending" })).data.evals;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].model, "codex/gpt-5.5");
  assert.equal(ev[0].price_known, false, "no source has a price for it: the cost is said to be unknown");
  assert.equal(ev[0].total_usd, null);
  assert.equal(ev[0].types.length, EVAL_TYPES.length);
  await b.call("models.refresh");
  assert.equal((await b.call("models.evals")).data.evals.length, 1, "refreshing again proposes nothing new");
  // nothing is queued until a person says yes
  assert.deepEqual((await b.call("models.eval-queue")).data.queue, []);
  assert.equal((await b.call("models.eval-approve", { model: "codex/gpt-5.5", evals: ["tool-use", "nonsense"], cap_usd: 5 })).error.code, "bad_input");
  const nocap = await b.call("models.eval-approve", { model: "codex/gpt-5.5", evals: ["capsule-answer"] });
  assert.equal(nocap.error.code, "bad_input");
  assert.match(nocap.error.message, /cost .* unknown .* hard cap/);
  assert.equal((await b.call("models.eval-approve", { model: "codex/gpt-5.5", evals: ["capsule-answer"], cap_usd: -1 })).error.code, "bad_input");
  const ok = (await b.call("models.eval-approve", { model: "codex/gpt-5.5", evals: ["capsule-answer"], cap_usd: 2 })).data;
  assert.deepEqual(ok.approved, ["capsule-answer"]);
  assert.equal(ok.cap_usd, 2);
  assert.match(ok.note, /nothing runs/);
  assert.equal((await b.call("models.eval-approve", { model: "codex/gpt-5.5" })).error.code, "bad_state");
  const q = (await b.call("models.eval-queue")).data.queue;
  assert.deepEqual(q.map((/** @type {any} */ x) => [x.model, x.types, x.cap_usd]), [["codex/gpt-5.5", ["capsule-answer"], 2]]);
  // a runner reports: only an approved type, a score from 0 to 1, and the model's entry carries it
  assert.equal((await b.call("models.eval-record", { model: "codex/gpt-5.5", type: "tool-use", score: 0.5 })).error.code, "not_allowed");
  assert.equal((await b.call("models.eval-record", { model: "codex/gpt-5.5", type: "capsule-answer", score: 2 })).error.code, "bad_input");
  assert.equal((await b.call("models.eval-record", { model: "codex/gpt-5.5", type: "capsule-answer", score: 0.9 })).data.ok, true);
  assert.deepEqual((await b.call("models.get", { id: "codex/gpt-5.5" })).data.evals["capsule-answer"].score, 0.9);
  assert.equal((await b.call("models.evals", { state: "done" })).data.evals.length, 1);
});

test("models: declining remembers the model; it is not proposed again", async t => {
  const b = await box(t, await openrouter(t, { value: OR }), { models: { min_ask_ms: 0 } });
  const learn = (/** @type {string} */ id) => b.d.registry.call("sessions.providers.learn", { provider: "grok", models: [{ id }] }, "module:threads");
  await learn("grok-4"); await b.call("models.refresh");
  await learn("grok-5"); await b.call("models.refresh");
  assert.equal((await b.call("models.eval-decline", { model: "grok/grok-5" })).data.ok, true);
  await b.call("models.refresh");
  const all = (await b.call("models.evals")).data.evals;
  assert.deepEqual(all.map((/** @type {any} */ e) => [e.model, e.state]), [["grok/grok-5", "declined"]]);
});

test("models: the model picker (sessions.models) reads this one list: Claude Code's aliases first, then every available model the registry knows, never twice, and the aliases alone before the registry has anything", async t => {
  const b = await box(t, await openrouter(t, { value: OR }));
  const before = (await b.call("sessions.models")).data;
  assert.deepEqual(before.map((/** @type {any} */ m) => m.id).slice(0, 3), ["opus", "sonnet", "haiku"], "the aliases come first");
  assert.equal((await b.call("models.refresh")).data.refreshed, true);
  const known = (await b.call("models.list", { provider: "claude", available: true })).data.models.map((/** @type {any} */ m) => m.id);
  const picker = (await b.call("sessions.models")).data.map((/** @type {any} */ m) => m.id);
  assert.deepEqual(picker.slice(0, 3), ["opus", "sonnet", "haiku"]);
  for (const id of known) assert.ok(picker.includes(id), `${id} is a registry model and the picker offers it`);
  assert.equal(new Set(picker).size, picker.length, "no model twice");
  assert.deepEqual((await b.call("sessions.models", { provider: "codex" })).data.map((/** @type {any} */ m) => m.id).filter((/** @type {string} */ id) => ["opus", "sonnet", "haiku"].includes(id)), [], "another provider's picker has no Claude aliases");
});
