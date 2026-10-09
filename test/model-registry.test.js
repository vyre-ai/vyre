// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeApi, joinKey, mergeSource, joinOpenRouter, ageMissing, proposeEvals, evalUsd, EVAL_TYPES, keyOf, MISSED_LIMIT } from "../lib/model-registry.js";

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
  assert.deepEqual(o[0].capabilities, { tools: true, reasoning: true, vision: true });
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
