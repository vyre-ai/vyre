#!/usr/bin/env node
// @ts-check
// eval-iq: does Vyre IQ's retrieval find the turns a question's answer is in? (ADR 0034, phase 2)
//
//   node scripts/eval-iq.js                   the open sessions world, every ablation, as a report
//   node scripts/eval-iq.js --world sealed    the sealed sessions world (written blind; scores only,
//                                             never a question, a passage or a failure)
//   node scripts/eval-iq.js --json            the same, as JSON
//   node scripts/eval-iq.js --answer          also memory.ask on every question, its replies replayed
//                                             from test/eval/asks/<world>.json (CI calls no model)
//   node scripts/eval-iq.js --answer --record  ask the fast model (`claude -p`, testbox) and keep
//                                             its replies there; the sealed world is recorded unread
//   node scripts/eval-iq.js --embedder real   meaning by the real model (all-MiniLM-L6-v2), installed
//                                             into VYRE_EVAL_EMBEDDER_DIR (default: os.tmpdir()/vyre-eval-embedder);
//                                             the default is the fake one (hashed words), as in CI
//
// It seeds the world into a temporary store the way the tests seed Recall, embeds every turn,
// starts the memory module, curates, and asks memory.retrieve every answerable question under
// each ablation:
//
//   bm25        keyword only (hybrid off), no expansion, no time words, no recency
//   hybrid      Recall's hybrid (keyword and meaning), nothing else
//   dense       meaning weighted as heavily as keywords (dense_weight 1)
//   +expand     hybrid, widened by names memory and the graph know
//   +when       and time words favour their window
//   full        and the recency prior (what memory.retrieve does by default)
//
// Metrics: recall@8 (the cited turn is in the top 8), session@8 (a turn of the cited session is),
// answer@8 (an acceptable answer's words are in a passage), MRR of the cited turn, p50/p95 ms.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../core/store/index.js";
import { seedRecall } from "../test/fixtures/corpus.js";
import { Dense } from "../core/recall/dense.js";
import { load } from "../core/recall/embed.js";
import { fakeEmbedder } from "../core/recall/testing.js";
import { startMemory, embedAll, correct, CONFIDENT } from "./eval-answer.js";
import { claudeOnce, modelFor } from "../core/memory/personal/reader.js";
import { VERSION as ASK_VERSION } from "../core/memory/iq/ask.js";
import * as openWorld from "../test/fixtures/iq-open.js";
import * as sealedWorld from "../test/fixtures/iq-sealed.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORLDS = {
  open: () => ({ world: openWorld, gold: JSON.parse(fs.readFileSync(path.join(ROOT, "test/eval/iq-open.json"), "utf8")), sealed: false }),
  sealed: () => ({ world: sealedWorld, gold: JSON.parse(fs.readFileSync(path.join(ROOT, "test/eval/iq-sealed.json"), "utf8")), sealed: true }),
};

export const ABLATIONS = {
  bm25: { hybrid: false, expand: false, when: false, recency: false },
  hybrid: { expand: false, when: false, recency: false },
  dense: { expand: false, when: false, recency: false, knobs: { dense_weight: 1 } },
  "+expand": { when: false, recency: false },
  "+when": { recency: false },
  full: {},
};

const K = 8;
const round = x => (x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

/** Where each question's answer is: exact turns, their sessions. */
const targets = q => ({ turns: new Set((q.where || []).map(w => `${w.session}:${w.seq}`)), sessions: new Set((q.where || []).map(w => String(w.session))) });

/**
 * Score one ablation's passages against the gold.
 * @param {any[]} questions @param {any[][]} got passages per question @param {number[]} ms
 */
export function scoreRetrieval(questions, got, ms) {
  let n = 0, hit = 0, sess = 0, ans = 0, rr = 0;
  const kinds = {};
  questions.forEach((q, i) => {
    if (!q.expect) return;
    n++;
    const t = targets(q), ps = got[i].slice(0, K);
    const rank = ps.findIndex(p => t.turns.has(`${p.session}:${p.seq}`));
    const h = rank >= 0;
    if (h) { hit++; rr += 1 / (rank + 1); }
    if (ps.some(p => t.sessions.has(p.session))) sess++;
    if (ps.some(p => correct(p.text, q.expect))) ans++;
    const k = kinds[q.kind] || (kinds[q.kind] = { n: 0, hit: 0 });
    k.n++; if (h) k.hit++;
  });
  return {
    questions: n, recall_at_8: round(hit / n), session_at_8: round(sess / n), answer_at_8: round(ans / n), mrr: round(rr / n),
    p50_ms: round(pct(ms, 0.5)), p95_ms: round(pct(ms, 0.95)),
    by_kind: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, round(v.hit / v.n)])),
  };
}

/**
 * @param {{ world?: "open"|"sealed", embedder?: "fake"|"real", only?: string[], answer?: boolean, record?: boolean }} [opts]
 */
export async function runIq(opts = {}) {
  const w = WORLDS[opts.world || "open"];
  if (!w) throw new Error(`no world called ${opts.world} (${Object.keys(WORLDS).join(", ")})`);
  const { world, gold, sealed } = w();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-eval-iq-"));
  const realNow = Date.now;
  Date.now = () => world.NOW;
  let db, mem;
  try {
    db = open(path.join(dir, "vyre.db"));
    db.exec("PRAGMA synchronous = OFF");
    seedRecall(db, world.SESSIONS);
    let embedder = null;
    if (opts.embedder === "real") {
      const base = process.env.VYRE_EVAL_EMBEDDER_DIR || path.join(os.tmpdir(), "vyre-eval-embedder");
      const r = await load({ cacheDir: path.join(base, "models"), runtime: path.join(base, "runtime") });
      if (!r.embedder) throw new Error(`the real embedder did not load: ${r.why}`);
      embedder = r.embedder;
    } else embedder = fakeEmbedder();
    const dense = new Dense(db);
    const t0 = performance.now();
    await embedAll(db, embedder);
    const embedMs = performance.now() - t0;
    const asksFile = path.join(ROOT, "test/eval/asks", `${opts.world || "open"}.json`);
    mem = await startMemory(db, { me: world.ME, embedder, dense, iqRunner: opts.record ? claudeOnce({ cwd: dir }) : null });
    if (opts.answer && fs.existsSync(asksFile)) {
      const kept = JSON.parse(fs.readFileSync(asksFile, "utf8"));
      const ins = db.prepare("INSERT OR REPLACE INTO memory_iq_asks (hash, v, at, reply, usd) VALUES (?,?,?,?,?)");
      if (kept.version === ASK_VERSION) for (const [h, r] of Object.entries(kept.replies || {})) ins.run(h, ASK_VERSION, 0, String(r), 0);
    }
    await mem.call("memory.curate", { full: true });
    const questions = gold.questions;
    /** @type {Record<string, any>} */
    const results = {};
    for (const [name, a] of Object.entries(ABLATIONS)) {
      if (opts.only && !opts.only.includes(name)) continue;
      const got = [], ms = [];
      for (const q of questions) {
        const s = performance.now();
        const r = q.expect ? await mem.call("memory.retrieve", { question: q.q, k: K, ...a }) : { passages: [] };
        ms.push(performance.now() - s);
        got.push(r.passages || []);
      }
      results[name] = scoreRetrieval(questions, got, ms.filter((_, i) => questions[i].expect));
    }
    // Determinism: the same question over the same index reads the same passages.
    let inconsistent = 0;
    for (const q of questions.filter(x => x.expect)) {
      const a = await mem.call("memory.retrieve", { question: q.q, k: K });
      const b = await mem.call("memory.retrieve", { question: q.q, k: K });
      if (JSON.stringify(a.passages.map(p => p.id)) !== JSON.stringify(b.passages.map(p => p.id))) inconsistent++;
    }
    let answered = null;
    if (opts.answer) {
      // memory.ask: right (an acceptable answer, or an abstention where there is none),
      // confident-wrong, abstained, ungrounded, and the same answer when asked again.
      let right = 0, cw = 0, abst = 0, ungrounded = 0, incons = 0, usd = 0;
      const ms = [], kinds = {}, whys = {};
      for (const q of questions) {
        const r = await mem.call("memory.ask", { question: q.q });
        ms.push(r.latency_ms); usd += r.cost_usd || 0;
        const ok = q.expect ? correct(r.answer, q.expect) : !r.answer;
        if (ok) right++;
        if (r.answer && !ok && r.confidence >= CONFIDENT) cw++;
        if (r.abstained) { abst++; const w = String(r.why || "abstained").replace(/: .*$/, ""); whys[w] = (whys[w] || 0) + 1; }
        if (r.answer && !(r.sources || []).length) ungrounded++;
        const again = await mem.call("memory.ask", { question: q.q });
        if (again.answer !== r.answer || JSON.stringify((again.sources || []).map(x => `${x.session}:${x.seq}`)) !== JSON.stringify((r.sources || []).map(x => `${x.session}:${x.seq}`))) incons++;
        const k = kinds[q.kind] || (kinds[q.kind] = { n: 0, ok: 0 }); k.n++; if (ok) k.ok++;
      }
      answered = { accuracy: round(right / questions.length), confident_wrong: cw, abstain_rate: round(abst / questions.length), ungrounded, inconsistent: incons,
        p50_ms: round(pct(ms, 0.5)), p95_ms: round(pct(ms, 0.95)), cost_usd: round(usd * 1e3) / 1e3, cost_per_question: round(usd / questions.length * 1e4) / 1e4,
        by_kind: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, round(v.ok / v.n)])), abstained_why: whys };
      if (opts.record) {
        const replies = Object.fromEntries(/** @type {any[]} */ (db.prepare("SELECT hash, reply FROM memory_iq_asks WHERE v = ? ORDER BY hash").all(ASK_VERSION)).map(r => [String(r.hash), String(r.reply)]));
        fs.mkdirSync(path.dirname(asksFile), { recursive: true });
        fs.writeFileSync(asksFile, JSON.stringify({ version: ASK_VERSION, model: modelFor({}), replies }, null, 1) + "\n");
      }
    }
    return {
      answered,
      world: { name: opts.world || "open", sealed, sessions: world.SESSIONS.length, turns: world.SESSIONS.reduce((n, s) => n + s.turns.length, 0),
        questions: questions.length, answerable: questions.filter(q => q.expect).length, embedder: opts.embedder === "real" ? "all-MiniLM-L6-v2" : "fake (hashed words)",
        embed_ms: round(embedMs) },
      ablations: results, inconsistent,
    };
  } finally {
    Date.now = realNow;
    try { await mem?.stop(); } catch {}
    try { db?.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function print(r) {
  const w = r.world;
  const out = [`eval-iq: ${w.name} world${w.sealed ? " (sealed: scores only)" : ""}, ${w.sessions} sessions, ${w.turns} turns, ${w.answerable} answerable of ${w.questions}; embedder ${w.embedder}`];
  out.push(`  ${"ablation".padEnd(10)} recall@8  session@8  answer@8  mrr    p95 ms`);
  for (const [name, a] of Object.entries(r.ablations)) {
    out.push(`  ${name.padEnd(10)} ${String(a.recall_at_8).padEnd(9)} ${String(a.session_at_8).padEnd(10)} ${String(a.answer_at_8).padEnd(9)} ${String(a.mrr).padEnd(6)} ${a.p95_ms}`);
  }
  out.push(`  inconsistent: ${r.inconsistent}`);
  if (r.answered) {
    const a = r.answered;
    out.push(`  memory.ask: accuracy ${a.accuracy}, confident-wrong ${a.confident_wrong}, abstained ${a.abstain_rate}, ungrounded ${a.ungrounded}, inconsistent ${a.inconsistent}`);
    out.push(`    latency p50/p95 ${a.p50_ms} / ${a.p95_ms} ms (replayed replies take no model time), cost $${a.cost_usd} ($${a.cost_per_question} a question)`);
    out.push(`    by kind: ${Object.entries(a.by_kind).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    out.push(`    abstained because: ${Object.entries(a.abstained_why).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  const full = r.ablations.full;
  if (full) out.push(`  full, by kind: ${Object.entries(full.by_kind).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  process.stdout.write(out.join("\n") + "\n");
}

async function main(argv) {
  const wi = argv.indexOf("--world"), ei = argv.indexOf("--embedder");
  const r = await runIq({ world: /** @type {any} */ (wi >= 0 ? argv[wi + 1] : "open"), embedder: /** @type {any} */ (ei >= 0 ? argv[ei + 1] : "fake"),
    answer: argv.includes("--answer"), record: argv.includes("--record"), only: argv.includes("--answer") ? ["full"] : undefined });
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(r, null, 1) + "\n"); else print(r);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { process.stderr.write(`eval-iq: ${e.message}\n`); process.exit(1); });
}
