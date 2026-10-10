// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { modelNames, keyOfAccount, MODEL_LISTING_PROVIDERS } from "./model-names.js";

test("the key of an account is the first non-empty value of its launch environment, and nothing when it has none", async () => {
  assert.equal(await keyOfAccount(async () => ({ env: { A: "", B: "sk-1", C: "sk-2" } }))({ id: "a" }), "sk-1");
  assert.equal(await keyOfAccount(async () => ({ env: {} }))({ id: "a" }), null);
  assert.equal(await keyOfAccount(async () => ({}))({ id: "a" }), null);
});

test("each API-key account is asked of the door once; a refusal is that account's error in words, never a key; login accounts and unknown providers are not asked", async () => {
  const asked = /** @type {any[]} */ ([]);
  const accounts = { claude: [{ id: "k1", kind: "api-key" }, { id: "l1", kind: "login" }], codex: [{ id: "k2", kind: "api-key" }], grok: [], "openai-compatible": [{ id: "k3", kind: "api-key" }] };
  const ctx = {
    call: async (/** @type {string} */ tool, /** @type {any} */ i) => ({ data: tool === "sessions.accounts.list" ? accounts[/** @type {keyof typeof accounts} */ (i.provider)] : null }),
    listModels: async (/** @type {any} */ q) => { asked.push([q.provider, q.account.id]); if (q.account.id === "k2") throw new Error("the key was refused"); return [{ id: "m-1", label: "Model One" }, { id: "m-2" }]; },
  };
  const out = await modelNames(ctx, MODEL_LISTING_PROVIDERS);
  assert.deepEqual(asked, [["claude", "k1"], ["openai-compatible", "k3"], ["codex", "k2"]].sort((a, b) => MODEL_LISTING_PROVIDERS.indexOf(a[0]) - MODEL_LISTING_PROVIDERS.indexOf(b[0])));
  assert.deepEqual(out.map(o => [o.provider, o.account, o.ok, o.ok ? o.models : o.error]), [["claude", "k1", true, [{ id: "m-1", label: "Model One" }, { id: "m-2" }]], ["codex", "k2", false, "the key was refused"], ["openai-compatible", "k3", true, [{ id: "m-1", label: "Model One" }, { id: "m-2" }]]]);
  assert.deepEqual((await modelNames({ call: ctx.call }, ["claude"])).map(o => [o.ok, o.error]), [[false, "no way to ask the door for a model list here"]], "a build with no door says so");
});
