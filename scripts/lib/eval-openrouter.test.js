// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { Budget, BudgetStop, StartRefused, openrouterOnce, marginFor, MARGIN_BY_MODEL, keyUsage, START_LIMIT_USD, modelListed } from "./eval-openrouter.js";

const reply = (text, cost) => async (url, init) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }], usage: { cost, prompt_tokens: 10, completion_tokens: 5 } }), url, init });

test("openrouter runner: sends the key and model, returns text and the reported cost, never free", async t => {
  const seen = [];
  const b = new Budget({ file: path.join(tempHome(t), "spend.json") });
  const run = openrouterOnce({ key: "sk-or-fake", model: "m/x", budget: b, fetch: async (u, i) => { seen.push({ u, i }); return reply("hi", 0.01)(u, i); } });
  const r = await run({ system: "s", prompt: "p", model: "haiku", maxUsd: 1 });
  assert.deepEqual([r.text, r.usd, r.tokens_in, r.tokens_out], ["hi", 0.01, 10, 5]);
  assert.equal(JSON.parse(seen[0].i.body).model, "m/x");
  assert.equal(seen[0].i.headers.authorization, "Bearer sk-or-fake");
  assert.equal(b.total, 0.01);
  await openrouterOnce({ key: "k", budget: b, fetch: reply("x", undefined) })({ system: "s", prompt: "p", model: "m", maxUsd: 1 });
  assert.ok(b.total > 0.01, "a reply with no cost counts as a small cost");
  assert.throws(() => openrouterOnce({ key: "", budget: b }), /not set/);
});

test("budget: refuses a call that could pass the limit, keeps the total in a file, and a rerun continues from it", async t => {
  const file = path.join(tempHome(t), "spend.json");
  let calls = 0;
  const f = async (u, i) => { calls++; return reply("ok", 4)(u, i); };
  const b = new Budget({ file, limit: 15, margin: 0.05 });
  const run = openrouterOnce({ key: "k", budget: b, fetch: f });
  for (let i = 0; i < 3; i++) await run({ system: "s", prompt: "p", model: "m", maxUsd: 1 });
  assert.equal(b.total, 12);
  await run({ system: "s", prompt: "p", model: "m", maxUsd: 1 });
  assert.equal(b.total, 16, "the last allowed call may land over: only the check before it is the guard");
  await assert.rejects(run({ system: "s", prompt: "p", model: "m", maxUsd: 1 }), e => e instanceof BudgetStop && /spend stop/.test(e.message));
  assert.equal(calls, 4, "no call is made once the guard refuses");
  assert.equal(b.stopped, true);
  // A rerun starts from the file: still stopped, still no call.
  const again = new Budget({ file, limit: 15 });
  assert.equal(again.total, 16);
  await assert.rejects(openrouterOnce({ key: "k", budget: again, fetch: f })({ system: "s", prompt: "p", model: "m", maxUsd: 1 }), BudgetStop);
  assert.equal(calls, 4);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).calls, 4);
});

test("budget: a call is refused when total plus the margin would pass the limit; an unreadable file fails closed", async t => {
  const dir = tempHome(t);
  const b = new Budget({ file: path.join(dir, "a.json"), limit: 1, margin: 0.05 });
  b.add(0.96);
  assert.throws(() => b.check(), BudgetStop);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "not json");
  assert.throws(() => new Budget({ file: bad }).check(), BudgetStop);
});

test("openrouter runner: an error reply throws without echoing the key, and cost on an error still counts", async t => {
  const b = new Budget({ file: path.join(tempHome(t), "s.json") });
  const run = openrouterOnce({ key: "sk-or-secret", budget: b, fetch: async () => ({ ok: false, status: 402, json: async () => ({ error: { message: "insufficient credits" }, usage: { cost: 0.5 } }) }) });
  await assert.rejects(run({ system: "s", prompt: "p", model: "m", maxUsd: 1 }), e => /402: insufficient credits/.test(e.message) && !/sk-or-secret/.test(e.message));
  assert.equal(b.total, 0.5);
});

test("margin: each model keeps its own per-call maximum, an unknown model the dearest", () => {
  assert.equal(marginFor("anthropic/claude-haiku-4.5"), 0.05);
  assert.equal(marginFor("anthropic/claude-sonnet-4.6"), 0.25);
  assert.equal(marginFor("someone/else"), Math.max(...Object.values(MARGIN_BY_MODEL)));
  assert.equal(marginFor(undefined), 0.25);
});


const KEY = "sk-or-" + "v1-" + "abcdef0123456789".repeat(3);
const usageReply = (usage, limit = 50, status = 200) => async (url, init) => ({ ok: status < 400, status, json: async () => ({ data: { usage, limit } }), url, init });

test("key usage: read from OpenRouter with the key, never echoed, and any failure throws so nothing starts", async () => {
  let seen;
  const u = await keyUsage({ key: KEY, fetch: async (url, init) => { seen = { url, init }; return usageReply(3.25)(url, init); } });
  assert.deepEqual(u, { usage: 3.25, limit: 50 });
  assert.equal(seen.url, "https://openrouter.ai/api/v1/key");
  assert.equal(seen.init.headers.authorization, `Bearer ${KEY}`);
  for (const bad of [usageReply(undefined), usageReply("x"), async () => ({ ok: false, status: 401, json: async () => ({ error: { message: `bad key ${KEY}` } }) }), async () => { throw new Error(`network ${KEY}`); }, async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })]) {
    await assert.rejects(keyUsage({ key: KEY, fetch: bad }), e => /could not read the key's usage/.test(e.message) && !e.message.includes(KEY), "the failure never carries the key");
  }
  await assert.rejects(keyUsage({ key: "" }), /not set/);
});

test("start guard: $14 or more on the key refuses to start; below it the run goes on", () => {
  assert.equal(START_LIMIT_USD, 14);
  const e = new StartRefused(14.2);
  assert.match(e.message, /refusing to start.*\$14\.2000.*\$14/);
  assert.ok(!e.message.includes(KEY));
});

test("in a run the key's own usage counts: stops before a call that could pass $15 of the key's total, even when the ledger is empty", async t => {
  const b = new Budget({ file: path.join(tempHome(t), "spend.json"), limit: 15, margin: 0.25 });
  b.setKeyBase(11);
  let calls = 0;
  const run = openrouterOnce({ key: "k", budget: b, fetch: async (u, i) => { calls++; return reply("ok", 1.5)(u, i); } });
  await run({ system: "s", prompt: "p", model: "m", maxUsd: 1 });   // 11 + 0 + 0.25 <= 15
  await run({ system: "s", prompt: "p", model: "m", maxUsd: 1 });   // 11 + 1.5 + 0.25 <= 15
  await run({ system: "s", prompt: "p", model: "m", maxUsd: 1 });   // 11 + 3 + 0.25 <= 15
  await assert.rejects(run({ system: "s", prompt: "p", model: "m", maxUsd: 1 }), e => e instanceof BudgetStop);   // 11 + 4.5 + 0.25 > 15
  assert.equal(calls, 3, "no call is made once the key's total would pass the limit");
  assert.equal(b.stopped, true);
  assert.equal(b.total, 4.5, "the ledger keeps this run's spend for the partial results");
  // Without a key base only the ledger guards, as before.
  const plain = new Budget({ file: path.join(tempHome(t), "s2.json"), limit: 15, margin: 0.25 });
  await openrouterOnce({ key: "k", budget: plain, fetch: reply("ok", 1.5) })({ system: "s", prompt: "p", model: "m", maxUsd: 1 });
  assert.equal(plain.stopped, false);
});

test("the key base is refreshed every N calls: spend by something else on the same key is seen mid-run, and a failed refresh stops", async t => {
  const b = new Budget({ file: path.join(tempHome(t), "spend.json"), limit: 15, margin: 0.05 });
  b.setKeyBase(2);
  let chat = 0, usage = 2;
  const f = async (url, init) => url.endsWith("/key") ? usageReply(usage)(url, init) : (chat++, reply("ok", 0.1)(url, init));
  const run = openrouterOnce({ key: KEY, budget: b, fetch: f, refreshEvery: 5 });
  for (let i = 0; i < 5; i++) await run({ system: "s", prompt: "p", model: "m", maxUsd: 1 });
  usage = 14.98;                                  // another workflow spent on the key
  await assert.rejects(run({ system: "s", prompt: "p", model: "m", maxUsd: 1 }), e => e instanceof BudgetStop);
  assert.equal(chat, 5, "no sixth call: the refresh saw the key near its limit");
  // A refresh that cannot be read stops the run too.
  const c = new Budget({ file: path.join(tempHome(t), "s2.json"), limit: 15, margin: 0.05 });
  c.setKeyBase(2);
  let n = 0;
  const g = async (url, init) => url.endsWith("/key") ? { ok: false, status: 500, json: async () => ({}) } : (n++, reply("ok", 0.1)(url, init));
  const run2 = openrouterOnce({ key: KEY, budget: c, fetch: g, refreshEvery: 2 });
  await run2({ system: "s", prompt: "p", model: "m", maxUsd: 1 }); await run2({ system: "s", prompt: "p", model: "m", maxUsd: 1 });
  await assert.rejects(run2({ system: "s", prompt: "p", model: "m", maxUsd: 1 }), e => e instanceof BudgetStop);
  assert.equal(n, 2);
});

test("modelListed: a retired model id is false (Grok Build shows OpenRouter's 400 for one as Internal error), a listed one true, an unreadable list null", async () => {
  const list = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "x-ai/grok-build-0.1" }, { id: "openai/gpt-5.1-codex-mini" }] }) });
  assert.equal(await modelListed("x-ai/grok-build-0.1", { fetch: /** @type {any} */ (list) }), true);
  assert.equal(await modelListed("x-ai/grok-code-fast-1", { fetch: /** @type {any} */ (list) }), false);
  assert.equal(await modelListed("x", { fetch: /** @type {any} */ (async () => ({ ok: false, status: 503, json: async () => ({}) })) }), null);
  assert.equal(await modelListed("x", { fetch: /** @type {any} */ (async () => { throw new Error("offline"); }) }), null);
  assert.equal(await modelListed("x", { fetch: /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) })) }), null);
});
