// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeApi, joinKey, mergeSource, joinOpenRouter, ageMissing, proposeEvals, evalUsd, EVAL_TYPES, keyOf, MISSED_LIMIT, catalogueRows, modelView, entriesForAccount, versionOf } from "../lib/model-registry.js";

const ANTHROPIC = { data: [{ id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5", created_at: "2025-09-29T00:00:00Z", type: "model" }, { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }, { nope: 1 }] };
const OPENROUTER = { data: [
  { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools", "reasoning"], architecture: { input_modalities: ["text", "image"] } },
  { id: "openai/gpt-5", name: "OpenAI: GPT-5", context_length: 400000, pricing: { prompt: "0.00000125", completion: "0.00001" }, supported_parameters: ["tools"] },
] };

test("normalizeApi: Anthropic and OpenRouter rows become plain rows; junk is skipped; prices are USD per million tokens", () => {
  const a = normalizeApi("claude", ANTHROPIC);
  assert.deepEqual(a.map(r => [r.id, r.label]), [["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"], ["claude-haiku-4-5", "Claude Haiku 4.5"]]);
  assert.ok(a[0].created > 0);
  const o = normalizeApi("openrouter", OPENROUTER);
  assert.deepEqual(o[0].price, { in: 3, out: 15 });
  assert.deepEqual(o[0].capabilities, { tools: true, reasoning: true, vision: true, efforts: [], default_effort: null });
  assert.equal(o[0].context, 1000000);
  assert.deepEqual(normalizeApi("codex", null), []);
  assert.deepEqual(normalizeApi("codex", { data: "x" }), []);
});

test("joinKey: a dotted OpenRouter id and a dated provider id are the same model", () => {
  assert.equal(joinKey("anthropic/claude-sonnet-4.5"), joinKey("claude-sonnet-4-5-20250929"));
  assert.equal(joinKey("claude-haiku-4-5-latest"), joinKey("claude-haiku-4.5"));
  assert.notEqual(joinKey("gpt-5"), joinKey("gpt-5-mini"));
});

test("mergeSource and joinOpenRouter: the provider's own answer makes the entry, OpenRouter fills price, context and capabilities, each field says where it came from", () => {
  const t0 = 1000;
  let { entries, added } = mergeSource(new Map(), "claude", "api", normalizeApi("claude", ANTHROPIC), t0);
  assert.deepEqual(added, ["claude/claude-sonnet-4-5-20250929", "claude/claude-haiku-4-5"]);
  entries = joinOpenRouter(entries, normalizeApi("openrouter", OPENROUTER), t0);
  const e = entries.get("claude/claude-sonnet-4-5-20250929");
  assert.deepEqual(e.sources, ["api", "openrouter"]);
  assert.deepEqual(e.price, { in: 3, out: 15 });
  assert.equal(e.from.price, "openrouter");
  assert.equal(e.label, "Claude Sonnet 4.5", "the provider's label stands; OpenRouter's name does not replace it");
  assert.equal(e.from.label, "api");
  assert.equal(entries.get("claude/claude-haiku-4-5").price, null, "no match, no price");
  // a CLI later reports a label: it outranks nothing it should not
  const cli = mergeSource(entries, "claude", "cli", [{ id: "claude-haiku-4-5", label: "Haiku", context: null, price: null, capabilities: null }], t0 + 1);
  assert.deepEqual(cli.added, []);
  assert.equal(cli.entries.get("claude/claude-haiku-4-5").label, "Claude Haiku 4.5", "api outranks cli");
});

test("a model every source stopped listing is marked unavailable after MISSED_LIMIT refreshes and is never deleted", () => {
  let { entries } = mergeSource(new Map(), "codex", "api", [{ id: "gpt-old", label: "Old", context: null, price: null, capabilities: null }], 1);
  entries.get("codex/gpt-old").evals = { "capsule-answer": { score: 0.9, at: 5 } };
  for (let i = 0; i < MISSED_LIMIT - 1; i++) entries = ageMissing(entries, new Set());
  assert.equal(entries.get("codex/gpt-old").available, true);
  entries = ageMissing(entries, new Set());
  assert.equal(entries.get("codex/gpt-old").available, false);
  assert.deepEqual(entries.get("codex/gpt-old").evals, { "capsule-answer": { score: 0.9, at: 5 } });
  entries = mergeSource(entries, "codex", "api", [{ id: "gpt-old", label: "Old", context: null, price: null, capabilities: null }], 9).entries;
  assert.equal(entries.get("codex/gpt-old").available, true, "it comes back when a source lists it");
});

test("proposeEvals: each eval's cost follows the model's own price, and a model with no price is still proposed with the cost unknown", () => {
  const priced = proposeEvals({ id: "claude-sonnet-4-5", provider: "claude", label: "Sonnet 4.5", price: { in: 3, out: 15 } });
  assert.equal(priced.types.length, EVAL_TYPES.length);
  assert.equal(priced.price_known, true);
  const quick = priced.types.find(t => t.id === "capsule-answer");
  assert.equal(quick.usd, evalUsd(EVAL_TYPES[0], { in: 3, out: 15 }));
  assert.equal(quick.usd, 0.18);
  assert.equal(priced.total_usd, Math.round(priced.types.reduce((n, t) => n + t.usd, 0) * 100) / 100);
  const free = proposeEvals({ id: "mystery", provider: "grok", price: null });
  assert.equal(free.price_known, false);
  assert.equal(free.total_usd, null);
  assert.ok(free.types.every(t => t.usd === null));
  assert.equal(free.model, keyOf("grok", "mystery"));
});

// ---- the one shape (modelView): every provider's list maps to it, with every detail the provider gives and nothing guessed

/** Bodies as each provider answers its own /models (trimmed to the fields they carry). */
const BODIES = {
  claude: { data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-21T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000,
    capabilities: { image_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true } } }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } } }] },
  codex: { object: "list", data: [{ id: "gpt-5.5-2026-04-23", object: "model", created: 1776902400, owned_by: "openai" }] },
  grok: { models: [{ id: "grok-4.7", created: 1789516800, input_modalities: ["text", "image"], output_modalities: ["text"] }] },
  "openai-compatible": { data: [{ id: "lab-large", context_length: 32768, max_model_len: 32768 }] },
  openrouter: { data: [{ id: "x-ai/grok-4.7", canonical_slug: "x-ai/grok-4.7-20260916", name: "SpaceXAI: Grok 4.7", created: 1789516800, context_length: 500000, top_provider: { max_completion_tokens: 64000 },
    pricing: { prompt: "0.000002", completion: "0.00001" }, supported_parameters: ["tools", "reasoning", "reasoning_effort"], architecture: { input_modalities: ["text", "image"] },
    reasoning: { mandatory: true, supported_efforts: ["xhigh", "high", "medium", "low"], default_effort: "high" } }] },
};

test("each provider's list maps to the one shape: its real name, provider, version, context, max output, price, capabilities and effort levels, unknown as null", () => {
  const v = (/** @type {string} */ p) => modelView({ ...normalizeApi(p, /** @type {any} */ (BODIES)[p])[0], provider: p });
  const claude = v("claude");
  assert.deepEqual([claude.name, claude.provider, claude.vendor, claude.version, claude.context, claude.max_output, claude.vision, claude.reasoning, claude.efforts],
    ["Claude Opus 5.5", "claude", "Anthropic", "2026-09-21", 1000000, 128000, true, true, ["low", "medium", "high", "xhigh", "max"]]);
  assert.equal(claude.tools, null, "Anthropic's list does not say: unknown, not guessed");
  assert.equal(claude.key, "claude/claude-opus-5-5");
  const codex = v("codex");
  assert.deepEqual([codex.name, codex.vendor, codex.version, codex.context, codex.price, codex.vision, codex.efforts], ["gpt-5.5-2026-04-23", "OpenAI", "2026-04-23", null, null, null, []], "OpenAI lists ids only: the rest is joined from the catalogue");
  const grok = v("grok");
  assert.deepEqual([grok.name, grok.vendor, grok.vision, grok.version], ["grok-4.7", "xAI", true, "2026-09-16"]);
  const compat = v("openai-compatible");
  assert.deepEqual([compat.name, compat.context, compat.vendor], ["lab-large", 32768, null]);
  const or = v("openrouter");
  assert.deepEqual([or.name, or.vendor, or.version, or.context, or.max_output, or.price, or.tools, or.vision, or.reasoning, or.efforts, or.default_effort],
    ["Grok 4.7", "SpaceXAI", "2026-09-16", 500000, 64000, { in: 2, out: 10 }, true, true, true, ["low", "medium", "high", "xhigh"], "high"]);
  for (const p of Object.keys(BODIES)) {
    const m = v(p);
    assert.deepEqual(Object.keys(m).sort(), ["accounts", "context", "default_effort", "efforts", "id", "key", "label", "max_output", "name", "price", "provider", "reasoning", "tools", "vendor", "version", "vision"], `${p} has the whole shape`);
  }
  assert.equal(versionOf("claude-sonnet-4-5-20250929", undefined), "2025-09-29");
  assert.equal(versionOf("gpt-5", undefined), null);
});

test("a sign-in provider's models come from OpenRouter's catalogue under the provider's own id, with its details; variants and aliases are not models of its own", () => {
  const or = normalizeApi("openrouter", { data: [
    { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", context_length: 1000000, top_provider: { max_completion_tokens: 128000 }, pricing: { prompt: "0.000004", completion: "0.00002" }, supported_parameters: ["tools"], reasoning: { supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "high" } },
    { id: "anthropic/claude-opus-5.5:batch", name: "Anthropic: Claude Opus 5.5 (batch)" },
    { id: "~anthropic/claude-opus-latest", name: "Latest" },
    { id: "openai/gpt-5.3-codex", name: "OpenAI: GPT-5.3-Codex", context_length: 400000 },
  ] });
  const claude = catalogueRows("claude", or);
  assert.deepEqual(claude.map((r) => [r.id, r.label]), [["claude-opus-5-5", "Claude Opus 5.5"]]);
  assert.deepEqual(catalogueRows("codex", or).map((r) => r.id), ["gpt-5.3-codex"], "OpenAI keeps the dots");
  assert.deepEqual(catalogueRows("openrouter", or), [], "OpenRouter's own models are its own entries");
  const { entries } = mergeSource(new Map(), "claude", "catalogue", claude, 1);
  const m = modelView(entries.get("claude/claude-opus-5-5"));
  assert.deepEqual([m.name, m.vendor, m.context, m.max_output, m.price, m.tools, m.efforts, m.default_effort], ["Claude Opus 5.5", "Anthropic", 1000000, 128000, { in: 4, out: 20 }, true, ["low", "medium", "high", "xhigh", "max"], "high"]);
});

test("a key's own list says which account gives a model; the capabilities of two sources combine, the higher one winning where both speak", () => {
  let { entries } = mergeSource(new Map(), "claude", "api", normalizeApi("claude", BODIES.claude), 1, "acct_a");
  entries = joinOpenRouter(entries, normalizeApi("openrouter", { data: [{ id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", pricing: { prompt: "0.000004", completion: "0.00002" }, supported_parameters: ["tools"], reasoning: { supported_efforts: ["high", "low"] } }] }), 2);
  const e = entries.get("claude/claude-opus-5-5");
  assert.deepEqual(e.accounts, ["acct_a"]);
  const m = modelView(e, ["acct_a"]);
  assert.equal(m.tools, true, "the catalogue says tools where Anthropic's list did not");
  assert.deepEqual(m.efforts, ["low", "medium", "high", "xhigh", "max"], "the provider's own effort levels outrank the catalogue's");
  assert.deepEqual(m.price, { in: 4, out: 20 });
  assert.deepEqual(m.accounts, ["acct_a"]);
  // which entries an account runs: its own key's list; a sign-in, what its CLI reported, else the catalogue; an OpenAI-compatible server only its own
  const all = [
    { id: "a", provider: "claude", sources: ["api"], accounts: ["key_1"] }, { id: "b", provider: "claude", sources: ["catalogue"] }, { id: "c", provider: "codex", sources: ["cli"] },
    { id: "d", provider: "codex", sources: ["catalogue"] }, { id: "e", provider: "openai-compatible", sources: ["api"], accounts: ["srv_1"] },
  ];
  assert.deepEqual(entriesForAccount({ id: "key_1", provider: "claude", kind: "api-key" }, all).map((x) => x.id), ["a"]);
  assert.deepEqual(entriesForAccount({ id: "login_1", provider: "claude", kind: "login" }, all).map((x) => x.id), ["a", "b"]);
  assert.deepEqual(entriesForAccount({ id: "login_2", provider: "codex", kind: "login" }, all).map((x) => x.id), ["c"], "a sign-in whose CLI reported its models lists those");
  assert.deepEqual(entriesForAccount({ id: "srv_2", provider: "openai-compatible", kind: "api-key" }, all).map((x) => x.id), [], "another server's list is not this one's");
  assert.deepEqual(entriesForAccount({ id: "srv_1", provider: "openai-compatible", kind: "api-key" }, all).map((x) => x.id), ["e"]);
  assert.deepEqual(entriesForAccount({ id: "oc_2", provider: "opencode", kind: "api-key" }, [...all, { id: "g", provider: "opencode", sources: ["api"], accounts: ["oc_1"] }]).map((x) => x.id), [], "another OpenCode account's list is not this one's");
});
