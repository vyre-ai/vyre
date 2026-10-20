// @ts-check
// The one model service, per person: each person's picker lists only the models of their own AI accounts, grouped by account, every model in the one shape with its details (name, vendor, version,
// context, max output, price, capabilities, effort levels). Another person's account is not theirs to list. On a real daemon, OpenRouter's public catalogue on loopback. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { allowLoopbackForTests } from "../lib/http.js";
allowLoopbackForTests();

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const CATALOGUE = { data: [
  { id: "anthropic/claude-opus-5.5", canonical_slug: "anthropic/claude-opus-5.5-20260921", name: "Anthropic: Claude Opus 5.5", created: 1790094732, context_length: 1000000, top_provider: { max_completion_tokens: 128000 },
    pricing: { prompt: "0.000004", completion: "0.00002" }, supported_parameters: ["tools", "reasoning"], architecture: { input_modalities: ["text", "image"] }, reasoning: { supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "high" } },
  { id: "openai/gpt-5.3-codex", canonical_slug: "openai/gpt-5.3-codex-20260224", name: "OpenAI: GPT-5.3-Codex", context_length: 400000, top_provider: { max_completion_tokens: 128000 },
    pricing: { prompt: "0.00000175", completion: "0.000014" }, supported_parameters: ["tools", "reasoning"], architecture: { input_modalities: ["text", "image"] }, reasoning: { supported_efforts: ["xhigh", "high", "medium", "low", "none"], default_effort: "medium" } },
  { id: "x-ai/grok-4.7", name: "SpaceXAI: Grok 4.7", context_length: 500000 },
] };

test("a person sees only the models of their own AI accounts, each with its details, and cannot list another person's account", { timeout: 180_000 }, async t => {
  const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(CATALOGUE)); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); }));
  const saved = process.env.VYRE_OPENROUTER_API;
  process.env.VYRE_OPENROUTER_API = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
  t.after(() => { if (saved === undefined) delete process.env.VYRE_OPENROUTER_API; else process.env.VYRE_OPENROUTER_API = saved; });

  const d = await start({ root: tempHome(t), presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner, BOB = "per_" + "b".repeat(26);
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
  const as = async (/** @type {string} */ person, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(chainOf(person), {})).token });

  const o = await as(owner, "sessions.accounts.add", { provider: "claude", label: "Owner Claude", kind: "login" });
  assert.ok(!o.error, JSON.stringify(o.error));
  const b = await as(BOB, "sessions.accounts.add", { provider: "codex", label: "Bob Codex", kind: "login" });
  assert.ok(!b.error, JSON.stringify(b.error));
  const looked = await d.registry.call("models.refresh", {}, "cli");
  assert.ok(!looked.error, JSON.stringify(looked.error));

  /** The person's picker: each of their accounts with the models it can run (what the app's one hook reads). @param {string} person */
  const picker = async (person) => {
    const accts = (await as(person, "sessions.accounts.list")).data || [];
    return Promise.all(accts.map(async (/** @type {any} */ a) => ({ account: a.label, models: ((await as(person, "sessions.accounts.models", { account: a.id })).data || { models: [] }).models })));
  };
  const mine = await picker(owner);
  assert.deepEqual(mine.map((g) => g.account), ["Owner Claude"], "the owner's picker is the owner's accounts only");
  const opus = mine[0].models.find((/** @type {any} */ m) => m.id === "claude-opus-5-5");
  assert.ok(opus, JSON.stringify(mine[0].models.map((/** @type {any} */ m) => m.id)));
  assert.deepEqual([opus.name, opus.provider, opus.vendor, opus.version, opus.context, opus.max_output, opus.price, opus.vision, opus.tools, opus.reasoning, opus.efforts, opus.default_effort, opus.accounts],
    ["Claude Opus 5.5", "claude", "Anthropic", "2026-09-21", 1000000, 128000, { in: 4, out: 20 }, true, true, true, ["low", "medium", "high", "xhigh", "max"], "high", [o.data.id]]);
  assert.ok(mine[0].models.every((/** @type {any} */ m) => m.provider === "claude"), "a Claude sign-in lists Claude's models, not another provider's");

  const bobs = await picker(BOB);
  assert.deepEqual(bobs.map((g) => g.account), ["Bob Codex"], "Bob's picker is Bob's account only");
  const codex = bobs[0].models.find((/** @type {any} */ m) => m.id === "gpt-5.3-codex");
  assert.ok(codex, JSON.stringify(bobs[0].models.map((/** @type {any} */ m) => m.id)));
  assert.deepEqual([codex.name, codex.vendor, codex.context, codex.efforts, codex.default_effort], ["GPT-5.3-Codex", "OpenAI", 400000, ["none", "low", "medium", "high", "xhigh"], "medium"]);
  assert.ok(!bobs[0].models.some((/** @type {any} */ m) => m.provider === "claude"), "no model of the owner's account reaches Bob");
  assert.equal((await as(BOB, "sessions.accounts.models", { account: o.data.id })).error?.code, "not_found", "Bob cannot list the owner's account by its id");
  assert.equal((await as(owner, "sessions.accounts.models", { account: b.data.id })).error?.code, "not_found", "nor the owner Bob's");
});
