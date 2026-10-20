// @ts-check
// The Flow model port's fallback: the main account answers; when it is out of credits, rate limited (after one more try), signed out or not answering, the fallback answers and says why; a bad request or a
// content refusal fails the step and the fallback is never asked. Over a fake registry (the person's accounts, their keys) and a fake door (each account's answer by its key).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { flowModel } from "./flow-model.js";
import { modelError } from "../../lib/model-errors.js";

const ANA = "per_ana";
const ROWS = {
  main: { id: "main", provider: "openrouter", kind: "api-key", label: "Main key", person: ANA, own_vault: true, vault_item: "m" },
  back: { id: "back", provider: "openai-compatible", kind: "api-key", label: "Back key", person: ANA, own_vault: true, vault_item: "b", base_url: "https://api.example.com/v1", model: "gpt-x" },
  owner: { id: "owner", provider: "openrouter", kind: "api-key", label: "Owner key", person: null, vault_item: "o" },
};

/** @param {(key: string, i: any) => any} answer */
function world(answer) {
  /** @type {any[]} */ const sent = [];
  const registry = {
    call: async (/** @type {string} */ tool, /** @type {any} */ q) => {
      if (tool !== "sessions.accounts.resolve") return { error: { code: "no_such_tool", message: tool } };
      const r = /** @type {any} */ (ROWS)[q.account];
      // as sessions.accounts.resolve: only an account that is this person's, on that provider
      if (!r || r.provider !== q.provider || (r.person ? r.person !== q.person : q.person !== "per_owner")) return { error: { code: "not_found", message: "no account" } };
      return { data: r };
    },
    deps: { lendKey: async (/** @type {any} */ q) => ({ data: { value: `key-${q.account}` } }), accountKey: async (/** @type {any} */ a) => `key-${a.id}` },
  };
  const door = { call: async (/** @type {any} */ i) => { sent.push(i); return answer(i.credential.key, i); } };
  const fm = flowModel({ registry, retryMs: 1 });
  const call = (/** @type {any} */ extra = {}) => fm.call({ person: ANA, main: { account: "main", provider: "openrouter" }, fallback: { account: "back", provider: "openai-compatible" }, purpose: "classify", max_tokens: 64, messages: [{ role: "user", content: "hi" }], space: "spc_x", door, chainFor: async () => ({ hops: [] }), ...extra });
  return { sent, call, fm };
}

test("the main account answers, and says so", async () => {
  const w = world(() => ({ content: "ok" }));
  const r = await w.call();
  assert.deepEqual(r.answered, { which: "main", label: "Main key", provider: "openrouter" });
  assert.deepEqual(w.sent.map((s) => s.credential.key), ["key-main"]);
});

for (const [kind, status] of /** @type {[string, number][]} */ ([["credits", 402], ["auth", 401], ["unavailable", 503]])) {
  test(`main ${kind}: the fallback answers, with its own model, and the answer says why`, async () => {
    const w = world((key) => { if (key === "key-main") throw modelError(`OpenRouter answered ${status}: nope`, { status }); return { content: "ok" }; });
    const r = await w.call({ model: "x/step" });
    assert.deepEqual(r.answered, { which: "fallback", label: "Back key", provider: "openai-compatible", main_label: "Main key", main_kind: kind });
    assert.deepEqual(w.sent.map((s) => [s.credential.key, s.model]), [["key-main", "x/step"], ["key-back", "gpt-x"]], "the step's model on main, the fallback's own model on the fallback");
  });
}

test("main rate limited: tried once more, then the fallback answers", async () => {
  const w = world((key) => { if (key === "key-main") throw modelError("OpenRouter answered 429: slow down", { status: 429 }); return { content: "ok" }; });
  const r = await w.call();
  assert.equal(r.answered.which, "fallback");
  assert.equal(r.answered.main_kind, "rate_limit");
  assert.deepEqual(w.sent.map((s) => s.credential.key), ["key-main", "key-main", "key-back"], "the retry, then the fallback");
});

test("main rate limited once and fine on its retry: no fallback", async () => {
  let n = 0;
  const w = world((key) => { if (key === "key-main" && n++ === 0) throw modelError("too many requests", { status: 429 }); return { content: "ok" }; });
  assert.equal((await w.call()).answered.which, "main");
});

for (const [kind, err] of /** @type {[string, any][]} */ ([["bad_request", () => modelError("OpenRouter answered 400: not a valid model", { status: 400 })], ["refused", () => modelError("OpenRouter answered 403: flagged by moderation", { status: 403 })]])) {
  test(`main ${kind}: the step fails and the fallback is never asked`, async () => {
    const w = world((key) => { if (key === "key-main") throw err(); return { content: "ok" }; });
    await assert.rejects(w.call(), (e) => /** @type {any} */ (e).kind === kind);
    assert.deepEqual(w.sent.map((s) => s.credential.key), ["key-main"]);
  });
}

test("the main account removed (signed out for good): the fallback answers", async () => {
  const w = world(() => ({ content: "ok" }));
  const r = await w.call({ main: { account: "gone", provider: "openrouter" } });
  assert.equal(r.answered.which, "fallback");
  assert.equal(r.answered.main_kind, "auth");
});

test("both fail: the step fails with both reasons and the main account's name for the card", async () => {
  const w = world(() => { throw modelError("OpenRouter answered 402: no credits", { status: 402 }); });
  await assert.rejects(w.call(), (e) => /Main Main key is out of credits, and the fallback Back key failed too/.test(/** @type {Error} */ (e).message) && /** @type {any} */ (e).account_label === "Main key" && /** @type {any} */ (e).kind === "credits");
});

test("a member can never run on the owner's account, as main or as fallback", async () => {
  const w = world(() => ({ content: "ok" }));
  await assert.rejects(w.call({ main: { account: "owner", provider: "openrouter" }, fallback: undefined }), (e) => /** @type {any} */ (e).code === "no_account");
  const r = await w.call({ fallback: { account: "owner", provider: "openrouter" } }).catch((e) => e);
  assert.equal(r.answered.which, "main", "the main one answered; the owner's was never needed");
  assert.equal(await w.fm.accountOk({ person: ANA, account: "owner", provider: "openrouter" }), false);
  assert.equal(await w.fm.accountOk({ person: ANA, account: "back", provider: "openai-compatible" }), true);
  assert.ok(!w.sent.some((s) => s.credential.key === "key-owner"), "the owner's key was never sent");
});
