// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchModels, MODEL_LISTING_PROVIDERS } from "../lib/model-endpoints.js";

const KEY = "fixture-key-aaaaaaaaaaaaaaaaaaaaaaaa";
const ok = (/** @type {any} */ body) => async () => ({ ok: true, status: 200, json: async () => body });

test("fetchModels: each provider is asked at its own address with its own header, and the answer never carries the key", async () => {
  /** @type {any[]} */ const asked = [];
  const io = { fetch: async (/** @type {string} */ url, /** @type {any} */ init) => { asked.push({ url, headers: init.headers }); return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) }; } };
  for (const provider of ["claude", "codex", "grok"]) {
    const r = await fetchModels({ id: `a-${provider}`, provider }, KEY, io);
    assert.deepEqual([r.ok, r.provider, r.account], [true, provider, `a-${provider}`]);
    assert.ok(!JSON.stringify(r).includes(KEY));
  }
  assert.match(asked[0].url, /^https:\/\/api\.[a-z.]+\/v1\/models/);
  assert.equal(asked[0].headers["x-api-key"], KEY);
  assert.equal(asked[1].headers.authorization, `Bearer ${KEY}`);
  assert.equal(asked[2].url, "https://api.x.ai/v1/models");
  assert.deepEqual([...MODEL_LISTING_PROVIDERS].sort(), ["claude", "codex", "grok", "openai-compatible"]);
});

test("fetchModels: a refused key, a failure, a provider with no list, an unsafe address and a missing address are each said plainly", async () => {
  assert.equal((await fetchModels({ id: "a", provider: "codex" }, KEY, { fetch: async () => ({ ok: false, status: 401 }) })).error, "the key was refused");
  assert.equal((await fetchModels({ id: "a", provider: "codex" }, KEY, { fetch: async () => ({ ok: false, status: 503 }) })).error, "HTTP 503");
  assert.match((await fetchModels({ id: "a", provider: "codex" }, KEY, { fetch: async () => { throw new Error("socket hang up"); } })).error || "", /socket hang up/);
  assert.match((await fetchModels({ id: "a", provider: "openrouter" }, KEY, { fetch: ok({}) })).error || "", /no model list/);
  assert.match((await fetchModels({ id: "a", provider: "openai-compatible" }, KEY, { fetch: ok({}) })).error || "", /names no address/);
  const unsafe = await fetchModels({ id: "a", provider: "openai-compatible", base_url: "https://10.0.0.5/v1" }, KEY, { fetch: ok({}), hostSafe: async () => false });
  assert.match(unsafe.error || "", /not a place a key may be sent/);
  const own = /** @type {any[]} */ ([]);
  await fetchModels({ id: "a", provider: "openai-compatible", base_url: "https://llm.example.com/v1/" }, KEY, { fetch: async (/** @type {string} */ u) => { own.push(u); return { ok: true, status: 200, json: async () => ({}) }; }, hostSafe: async () => true });
  assert.deepEqual(own, ["https://llm.example.com/v1/models"]);
});
