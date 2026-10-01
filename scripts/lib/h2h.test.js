// @ts-check
// The head-to-head's parts, with no model and no key: the long session plants what it says, BM25 finds
// each planted turn, the scoring reads abstentions, the estimate stays under the round's cap, and a
// cached reply costs nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as H from "./h2h.js";
import { correct } from "../eval-answer.js";
import { Budget } from "./eval-openrouter.js";
import { countingModel, liveModel, experiment, CAP_USD } from "../eval-h2h.js";
import * as long from "../../test/fixtures/long-session.js";

test("long session: every planted fact is before the cut and every question's answer is in its turn", () => {
  assert.equal(long.TURNS.length, long.TURN_COUNT);
  for (const p of long.PLANTED) {
    assert.ok(p.at < long.CUT, `${p.q} is planted before the cut`);
    assert.ok(long.TURNS[p.at].text === p.text, "the planted turn is the text");
    assert.ok(correct(p.text, p.expect), `the planted line contains its own answer: ${p.q}`);
  }
  assert.ok(H.tokensOf(long.TURNS.map(t => t.text).join("")) > 40_000, "a long session, not a short one");
});

test("bm25 over the turns puts the planted turn in the top five for most questions (the search arm's upper bound is not zero)", () => {
  const idx = H.bm25(long.TURNS);
  let found = 0;
  for (const g of long.QUESTIONS) if (idx.search(g.q, 5).some(t => t.n === g.at)) found++;
  assert.ok(found / long.QUESTIONS.length >= 0.7, `${found} of ${long.QUESTIONS.length} found`);
});

test("pointer index: one line per block of twenty turns", () => {
  const lines = H.pointerIndex(long.TURNS.slice(0, long.CUT)).split("\n");
  assert.equal(lines.length, long.CUT / 20);
  assert.match(lines[0], /^turns 0-19: /);
});

test("abstains and scoreMain: an unanswerable is right only when declined without a forbidden string", () => {
  assert.ok(H.abstains("I don't know."));
  assert.ok(!H.abstains("Her number is 303-555-0148."));
  const qs = [{ class: "personal", q: "a", expect: ["Portland"] }, { class: "unanswerable", q: "b", expect: null, forbid: ["303-555-0148"] }];
  const s = H.scoreMain(correct, qs, [{ answer: "You live in Portland." }, { answer: "I don't know." }]);
  assert.deepEqual([s.answerable.ok, s.unanswerable.ok, s.confidentWrong], [1, 1, 0]);
  const t = H.scoreMain(correct, qs, [{ answer: "Oakland." }, { answer: "It is 303-555-0148." }]);
  assert.deepEqual([t.answerable.ok, t.unanswerable.ok, t.confidentWrong], [0, 0, 2]);
});

test("the estimate runs every arm and stays under the round's cap", async () => {
  const m = countingModel(H.DEFAULT_MODEL);
  const r = await experiment(m, { model: H.DEFAULT_MODEL, tmp: fs.mkdtempSync(path.join(os.tmpdir(), "vyre-h2h-test-")), vyre: false });
  assert.deepEqual(Object.keys(r.main).sort(), ["agents-md", "claude-auto", "full-context"]);
  assert.deepEqual(Object.keys(r.long).sort(), ["compaction", "compaction+search", "vyre-window"]);
  assert.ok(r.total_usd < CAP_USD, `estimated $${r.total_usd}`);
});

test("a cached reply is free and never reaches the network", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-h2h-test-"));
  const budget = new Budget({ file: path.join(dir, "spend.json"), limit: CAP_USD });
  /** @type {Record<string, any>} */ const cache = {};
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = /** @type {any} */ (async () => { calls++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Portland" } }], usage: { cost: 0.0004, prompt_tokens: 10, completion_tokens: 2 } }) }; });
  try {
    const m = liveModel({ key: "test-key-not-real", model: H.DEFAULT_MODEL, budget, cache, save: () => {} });
    const c = { arm: "x", kind: "answer", system: "s", prompt: "p", maxTokens: 50 };
    const a = await m.call(c), b = await m.call(c);
    assert.equal(a.text, "Portland");
    assert.equal(b.cached, true);
    assert.equal(b.usd, 0);
    assert.equal(calls, 1);
    assert.ok(budget.total > 0 && budget.total < 0.01);
  } finally { globalThis.fetch = realFetch; }
});
