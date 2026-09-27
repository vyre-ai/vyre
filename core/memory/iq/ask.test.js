// @ts-check
// iq/ask: cited answers or an abstention, checked by code (ADR 0034, phase 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../../store/index.js";
import { MIGRATIONS } from "../schema.js";
import { tempHome } from "../../../test/helpers.js";
import { asker, checkAsk, mustAppear, askPrompt, askHash } from "./ask.js";

const P = [
  { session: "s1", seq: 3, role: "assistant", ts: Date.parse("2026-06-12T10:00:00Z"), name: "Northwind invoices", text: "Fixed the rounding in src/billing/refund.ts: totals now round half up. Deployed to staging on port 8443." },
  { session: "s2", seq: 1, role: "user", ts: Date.parse("2026-06-20T10:00:00Z"), name: "Harlow site", text: "dana wants the intake form above the fold" },
];

test("ask: what must be in the sources is the answer's names, numbers, paths and quotes", () => {
  assert.deepEqual(mustAppear("The bug was in src/billing/refund.ts, fixed on port 8443.").sort(), ["8443", "src/billing/refund.ts"].sort());
  assert.ok(mustAppear("Dana Reyes asked for it.").includes("Dana Reyes"));
});

test("ask: a reply stands only on the passages it was given and on their words", () => {
  const ok = checkAsk({ answer: "It was in src/billing/refund.ts.", cite: [1], confidence: 0.8, abstain: false, known: [] }, P);
  assert.equal(ok.abstained, false);
  assert.equal(ok.answer, "It was in src/billing/refund.ts.");
  assert.equal(checkAsk({ answer: "It was in src/billing/refund.ts.", cite: [3], confidence: 0.8 }, P).abstained, true, "a passage that was not given");
  assert.equal(checkAsk({ answer: "It was in src/billing/invoice.ts.", cite: [1], confidence: 0.8 }, P).abstained, true, "a path the passage never says");
  assert.equal(checkAsk({ answer: "Port 9000.", cite: [1], confidence: 0.9 }, P).abstained, true, "a number the passage never says");
  assert.equal(checkAsk({ answer: "It was in src/billing/refund.ts.", cite: [], confidence: 0.8 }, P).abstained, true, "no citation");
  assert.equal(checkAsk({ answer: "It was in src/billing/refund.ts.", cite: [1], confidence: 0.3 }, P).abstained, true, "not sure");
  const no = checkAsk({ answer: null, abstain: true, known: ["the refund rounding was fixed"] }, P);
  assert.equal(no.abstained, true);
  assert.deepEqual(no.known, ["the refund rounding was fixed"]);
  assert.equal(checkAsk(null, P).abstained, true);
});

function db(t) {
  const d = open(path.join(tempHome(t), "vyre.db"));
  migrate(d, "memory", MIGRATIONS);
  t.after(() => d.close());
  return d;
}

test("ask: a sure personal fact answers with no model; else the model, kept by its prompt, cited", async t => {
  const d = db(t);
  let calls = 0;
  const runner = async () => { calls++; return { text: JSON.stringify({ answer: "The rounding bug was in src/billing/refund.ts.", cite: [1], confidence: 0.85, abstain: false, known: [] }), usd: 0.002 }; };
  const answer = async ({ q }) => (/wife/.test(q) ? { answer: "Your wife is Noor.", confidence: 0.9, kind: "fact", facts: [{ id: "me|spouse|kin:spouse" }], sources: [{ session: "s9", seq: 0 }] } : { answer: null });
  const retrieve = async () => ({ passages: P });
  let spent = 0;
  const ask = asker({ db: d, answer, retrieve, runner, budget: { allow: usd => spent + usd <= 0.1, charge: usd => { spent += usd; } } });

  const wife = await ask({ question: "what is my wife's name", personal: true });
  assert.equal(wife.answer, "Your wife is Noor.");
  assert.equal(wife.via, "fact");
  assert.equal(calls, 0);
  // A caller that may not see personal facts never gets one.
  assert.equal((await ask({ question: "what is my wife's name" })).via, "retrieval");

  const r1 = await ask({ question: "which file had the refund rounding bug", personal: true });
  assert.equal(r1.abstained, false);
  assert.equal(r1.sources[0].session, "s1");
  assert.equal(r1.sources[0].seq, 3);
  const before = calls;
  const r2 = await ask({ question: "which file had the refund rounding bug", personal: true });
  assert.equal(calls, before, "the same prompt is answered from what was kept");
  assert.deepEqual({ ...r2, latency_ms: 0, cost_usd: 0 }, { ...r1, latency_ms: 0, cost_usd: 0 });
  assert.ok(d.prepare("SELECT reply FROM memory_iq_asks WHERE hash = ?").get(askHash(askPrompt("which file had the refund rounding bug", P))));
});

test("ask: no passages, no model, a spent budget or a made-up answer all abstain", async t => {
  const d = db(t);
  const none = asker({ db: d, answer: async () => ({}), retrieve: async () => ({ passages: [] }), runner: async () => { throw new Error("not called"); } });
  assert.equal((await none({ question: "what port does the api use" })).abstained, true);
  const noModel = asker({ db: d, answer: async () => ({}), retrieve: async () => ({ passages: P }), runner: null });
  assert.equal((await noModel({ question: "what port does staging use" })).abstained, true);
  let calls = 0;
  const broke = asker({ db: d, answer: async () => ({}), retrieve: async () => ({ passages: P }), runner: async () => { calls++; return { text: "{}", usd: 0 }; }, budget: { allow: () => false, charge: () => {} } });
  assert.equal((await broke({ question: "what port does staging use" })).abstained, true);
  assert.equal(calls, 0);
  const liar = asker({ db: d, answer: async () => ({}), retrieve: async () => ({ passages: P }),
    runner: async () => ({ text: JSON.stringify({ answer: "Staging runs on port 9000.", cite: [1], confidence: 0.9 }), usd: 0.001 }) });
  const r = await liar({ question: "which port is staging on" });
  assert.equal(r.abstained, true);
  assert.equal(r.answer, null);
});
