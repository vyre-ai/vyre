// @ts-check
// The drivers behind the door's listModels (core/daemon/model-lists.js): each provider is asked at its own address with its own header, the key is used for one request and never comes back, and a refusal,
// a failure, an unsafe address and a missing key are each said in words.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelListDrivers, MODEL_LISTING_PROVIDERS, namesOf } from "../core/daemon/model-lists.js";

const KEY = "fixture-key-aaaaaaaaaaaaaaaaaaaaaaaa";
const body = { data: [{ id: "m1", display_name: "Model One" }, { id: "m2" }, { name: "models/m3" }, { id: 5 }, null, "m4"], echo: KEY };
const mk = (/** @type {any} */ over = {}) => { /** @type {any[]} */ const asked = []; const d = modelListDrivers({ keyOf: async () => KEY, fetch: async (/** @type {string} */ url, /** @type {any} */ init) => { asked.push({ url, headers: init.headers }); return { ok: true, status: 200, json: async () => body }; }, ...over }); return { d, asked }; };

test("each provider is asked at its own address with its own header, and the answer is names, never the body or the key", async () => {
  const { d, asked } = mk();
  assert.deepEqual([...MODEL_LISTING_PROVIDERS].sort(), ["claude", "codex", "grok", "openai-compatible"]);
  for (const provider of ["claude", "codex", "grok"]) {
    const names = await d[provider].models({ account: { id: `a-${provider}` } });
    assert.deepEqual(names, [{ id: "m1", label: "Model One" }, { id: "m2" }, { id: "m3" }, { id: "m4" }], "id and display name; a number and a null are not model entries");
    assert.ok(!JSON.stringify(names).includes(KEY));
  }
  assert.match(asked[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models/);
  assert.equal(asked[0].headers["x-api-key"], KEY);
  assert.equal(asked[1].headers.authorization, `Bearer ${KEY}`);
  assert.equal(asked[2].url, "https://api.x.ai/v1/models");
  await assert.rejects(() => d.codex.call(), /can be listed here, not called/);
});

test("a refused key, a failure, a missing key, an unsafe address and a missing address are each said plainly, and no error carries the key", async () => {
  const fail = (/** @type {any} */ f, /** @type {any} */ over = {}) => modelListDrivers({ keyOf: async () => KEY, fetch: f, ...over });
  await assert.rejects(() => fail(async () => ({ ok: false, status: 401 })).codex.models({ account: {} }), /the key was refused/);
  await assert.rejects(() => fail(async () => ({ ok: false, status: 503 })).codex.models({ account: {} }), /HTTP 503/);
  await assert.rejects(() => fail(async () => { throw new Error(`socket hang up ${KEY}`); }).codex.models({ account: {} }), e => /socket hang up/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(() => fail(async () => ({}), { keyOf: async () => null }).codex.models({ account: {} }), /no key/);
  await assert.rejects(() => fail(async () => ({}))["openai-compatible"].models({ account: {} }), /names no address/);
  await assert.rejects(() => fail(async () => ({}), { hostSafe: async () => false })["openai-compatible"].models({ account: { base_url: "https://10.0.0.5/v1" } }), /not a place a key may be sent/);
  const own = /** @type {string[]} */ ([]);
  await fail(async (/** @type {string} */ u) => { own.push(u); return { ok: true, status: 200, json: async () => ({ data: [] }) }; })["openai-compatible"].models({ account: { base_url: "https://llm.example.com/v1/" } });
  assert.deepEqual(own, ["https://llm.example.com/v1/models"]);
});

test("namesOf reads data or models, the id or the name, text only, once each", () => {
  assert.deepEqual(namesOf({ models: [{ name: "models/gemini" }, { id: "a", displayName: "A" }, { id: "a" }] }), [{ id: "gemini" }, { id: "a", label: "A" }]);
  assert.deepEqual(namesOf({}), []);
  assert.deepEqual(namesOf(null), []);
});
