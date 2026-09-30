// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { Budget, BudgetStop, openrouterOnce } from "./eval-openrouter.js";

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
