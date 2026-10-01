#!/usr/bin/env node
// @ts-check
// eval-h2h: the head-to-head (team/0.2.5/memory-context.md). Same questions, one cheap model, several
// ways of giving it memory, scored by the open world's own expect strings (no judge model).
//
//   node scripts/eval-h2h.js --estimate     builds every prompt, counts tokens, prints the cost; no key, no model
//   node scripts/eval-h2h.js --record       runs it for real through OpenRouter (VYRE_EVAL_RECORD=1, the workflow only)
//   node scripts/eval-h2h.js --report       prints the saved results as a table
//
// Main arms, over the first 10 questions of each answerable class and of the unanswerable class:
//   vyre          Vyre Memory's memory.ask (hybrid retrieval, then one model call), through eval-bar's own path
//   claude-auto   Claude Code's CLAUDE.md and auto memory, approximated: the model writes notes after each session
//                 (3 lines at most), the index keeps the newest 200 lines and 25 KB, and the question is asked with it
//   agents-md     Codex's AGENTS.md, approximated by a hand-kept file: one call over everything, 32 KiB at most
//   full-context  the ceiling: every transcript in the prompt
// Long-session arms, over a 480-turn synthetic session cut at turn 400: compaction alone, compaction plus
// memory_search (BM25 verbatim turns), and the Vyre-managed window (pinned decisions, pointer index, summary,
// tail, retrieved turns as a data block). None of these runs the real claude or codex binary: they are the
// memory each tool would hand the model, so they say nothing about those tools' own prompts or tool use.
//
// Spend: the round's hard cap is $5 (CAP_USD). The ledger (test/eval/h2h/spend.json) and the replies cache
// (test/eval/h2h/replies.json) are committed after each dispatch, so a rerun pays only for what is missing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Budget, openrouterOnce, marginFor, keyUsage } from "./lib/eval-openrouter.js";
import { runBar, WORLDS, ANSWERABLE } from "./eval-bar.js";
import { correct } from "./eval-answer.js";
import * as H from "./lib/h2h.js";
import * as long from "../test/fixtures/long-session.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "test/eval/h2h");
export const CAP_USD = 5;
/** The key's own hard limit is $50; a run refuses to start when it has already spent this much. */
export const START_REFUSE_USD = 45;
const PER_CLASS = 10;
const CLASSES = [...ANSWERABLE, "unanswerable"];
/** Output tokens an estimate assumes, per kind of call (the live run pays for the real ones). */
const EST_OUT = { answer: 60, notes: 50, agents: 2200, summary: 1000, pinned: 1100 };

/** A model that only counts: for --estimate. @param {string} model @returns {H.Model & { rows: Map<string, { calls: number, tin: number, tout: number, usd: number }> }} */
export function countingModel(model) {
  const rows = new Map();
  return {
    rows,
    async call(c) {
      const tin = H.tokensOf(c.system) + H.tokensOf(c.prompt);
      const tout = Math.min(c.maxTokens || 9999, /** @type {any} */ (EST_OUT)[c.kind] || 60);
      const usd = H.priceOf(model, tin, tout);
      const r = rows.get(c.arm) || { calls: 0, tin: 0, tout: 0, usd: 0 };
      r.calls++; r.tin += tin; r.tout += tout; r.usd += usd; rows.set(c.arm, r);
      return { text: c.kind === "answer" ? "I don't know." : "- a note\n".repeat(c.kind === "notes" ? 1 : 1), usd, tin, tout };
    },
  };
}

/** A live model through OpenRouter: every reply cached by its prompt, every cent counted, stopped at the cap. @param {{ key: string, model: string, budget: Budget, cache: Record<string, any>, save: () => void }} o @returns {H.Model & { rows: Map<string, { calls: number, tin: number, tout: number, usd: number }> }} */
export function liveModel(o) {
  const once = openrouterOnce({ key: o.key, model: o.model, budget: o.budget, refreshEvery: 0 });
  const rows = new Map();
  return {
    rows,
    async call(c) {
      const k = crypto.createHash("sha256").update(JSON.stringify([o.model, c.system, c.prompt, c.maxTokens || 0])).digest("hex");
      const hit = o.cache[k];
      if (hit) return { ...hit, usd: 0, cached: true };
      const r = await once({ system: c.system, prompt: c.prompt, model: o.model, ...(c.maxTokens ? { maxTokens: c.maxTokens } : {}) });
      const rep = { text: r.text, usd: r.usd, tin: r.tokens_in, tout: r.tokens_out };
      o.cache[k] = rep; o.save();
      const row = rows.get(c.arm) || { calls: 0, tin: 0, tout: 0, usd: 0 };
      row.calls++; row.tin += rep.tin; row.tout += rep.tout; row.usd += rep.usd; rows.set(c.arm, row);
      return rep;
    },
  };
}

/** The whole experiment over one model object. @param {H.Model & { rows: Map<string, any> }} model @param {{ model: string, tmp: string, vyre?: boolean }} o */
export async function experiment(model, o) {
  const w = WORLDS.open();
  const questions = H.pickQuestions(w.gold.questions, CLASSES, PER_CLASS);
  const results = /** @type {any} */ ({ model: o.model, questions: questions.length, main: {}, long: {} });

  // Vyre's own path, through eval-bar: the same memory.ask, retrieval and prompt, the model call counted here.
  if (o.vyre !== false) {
    const runner = async (/** @type {any} */ r) => { const x = await model.call({ arm: "vyre", kind: "answer", system: r.system, prompt: r.prompt, maxTokens: 400 }); return { text: x.text, usd: x.usd, tokens_in: x.tin, tokens_out: x.tout }; };
    const bar = await runBar({ world: "open", record: true, explain: true, runner, asks: path.join(o.tmp, "vyre-asks.json"), classes: CLASSES, only: PER_CLASS });
    const ex = bar.explained || [];
    const by = {};
    let ok = 0;
    for (const e of ex) { const c = (by[e.class] ||= { n: 0, ok: 0 }); c.n++; if (e.ok) { c.ok++; ok++; } }
    results.main.vyre = { n: ex.length, ok, by, answerable: { n: ex.filter((/** @type {any} */ e) => e.class !== "unanswerable").length, ok: ex.filter((/** @type {any} */ e) => e.class !== "unanswerable" && e.ok).length }, unanswerable: { n: ex.filter((/** @type {any} */ e) => e.class === "unanswerable").length, ok: ex.filter((/** @type {any} */ e) => e.class === "unanswerable" && e.ok).length } };
  }

  const auto = await H.buildAutoMemory(model, w.world);
  const agents = await H.buildAgentsMd(model, w.world);
  const arms = [
    ["claude-auto", "MEMORY.md (auto memory)", auto.text],
    ["agents-md", "AGENTS.md", agents.text],
    ["full-context", "Every session transcript", H.fullContext(w.world)],
  ];
  for (const [arm, heading, memory] of arms) {
    const got = await H.answerArm(model, arm, heading, memory, questions);
    results.main[arm] = { ...H.scoreMain(correct, questions, got), memory_tokens: H.tokensOf(memory), ...(arm === "claude-auto" ? { note_lines: auto.lines, kept: auto.kept } : {}) };
  }

  const L = await H.runLong(model, long.TURNS, long.CUT, long.QUESTIONS);
  for (const [arm, got] of Object.entries(L.out)) results.long[arm] = H.scoreLong(correct, long.QUESTIONS, got);
  results.long_meta = { turns: long.TURNS.length, cut: long.CUT, questions: long.QUESTIONS.length, summary_tokens: L.summaryTokens, pinned_tokens: L.pinnedTokens };
  results.spend = Object.fromEntries([...model.rows].map(([k, v]) => [k, { calls: v.calls, tokens_in: v.tin, tokens_out: v.tout, usd: Math.round(v.usd * 1e4) / 1e4 }]));
  results.total_usd = Math.round([...model.rows.values()].reduce((n, v) => n + v.usd, 0) * 1e4) / 1e4;
  return results;
}

/** @param {any} r */
export function table(r) {
  const pc = (/** @type {any} */ x) => (x && x.n ? `${Math.round((100 * x.ok) / x.n)}% (${x.ok}/${x.n})` : "n/a");
  const out = [`Head-to-head, ${r.model}, ${r.questions} questions from the open world`, "", "| arm | answerable | abstains when unanswerable |", "|---|---|---|"];
  for (const [k, v] of Object.entries(r.main)) out.push(`| ${k} | ${pc(/** @type {any} */ (v).answerable)} | ${pc(/** @type {any} */ (v).unanswerable)} |`);
  out.push("", `Long session (${r.long_meta ? `${r.long_meta.turns} turns, cut at ${r.long_meta.cut}, ${r.long_meta.questions} questions about turns before the cut` : ""})`, "", "| arm | right |", "|---|---|");
  for (const [k, v] of Object.entries(r.long)) out.push(`| ${k} | ${pc(v)} |`);
  out.push("", `Spend this run: $${r.total_usd}`);
  return out.join("\n");
}

async function main(argv) {
  const modelId = process.env.VYRE_EVAL_MODEL || H.DEFAULT_MODEL;
  fs.mkdirSync(DIR, { recursive: true });
  if (argv.includes("--report")) { process.stdout.write(table(JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf8"))) + "\n"); return; }
  if (argv.includes("--estimate")) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-h2h-"));
    const m = countingModel(modelId);
    const r = await experiment(m, { model: modelId, tmp });
    const out = ["Estimate (no key, no model call), " + modelId + ", prices assumed from OpenRouter's list", "", "| arm | calls | tokens in | tokens out | usd |", "|---|---|---|---|---|"];
    for (const [k, v] of m.rows) out.push(`| ${k} | ${v.calls} | ${v.tin} | ${v.tout} | ${v.usd.toFixed(3)} |`);
    out.push("", `Estimated total: $${r.total_usd} (hard cap $${CAP_USD}; the run stops before a call that could pass it)`);
    process.stdout.write(out.join("\n") + "\n");
    return;
  }
  if (!argv.includes("--record")) { process.stderr.write("eval-h2h: --estimate, --record or --report\n"); process.exit(2); }
  if (process.env.VYRE_EVAL_RECORD !== "1") { process.stderr.write("eval-h2h: recording calls the model and runs only in the memory-h2h-record workflow (VYRE_EVAL_RECORD=1).\n"); process.exit(2); }
  const key = String(process.env.OPENROUTER_EVAL_KEY || "");
  const usd = (/** @type {number} */ n) => `$${n.toFixed(4)}`;
  let before;
  try {
    before = await keyUsage({ key });
    process.stdout.write(`eval-h2h: key usage before: ${usd(before.usage)}${before.limit != null ? ` of the key's $${before.limit} limit` : ""}\n`);
    if (before.usage >= START_REFUSE_USD) throw new Error(`the key has already spent ${usd(before.usage)}`);
  } catch (e) { process.stderr.write(`eval-h2h: refusing to start: ${/** @type {Error} */ (e).message}; nothing was sent to the model.\n`); process.exit(3); }
  const ledger = path.join(DIR, "spend.json"), cacheFile = path.join(DIR, "replies.json");
  /** @type {Record<string, any>} */ const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  const budget = new Budget({ file: ledger, limit: CAP_USD, margin: marginFor(modelId) });
  budget.setKeyBase(before.usage);
  const model = liveModel({ key, model: modelId, budget, cache, save: () => fs.writeFileSync(cacheFile, JSON.stringify(cache)) });
  let code = 0;
  try {
    const r = await experiment(model, { model: modelId, tmp: DIR });
    fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(r, null, 1) + "\n");
    process.stdout.write(table(r) + "\n");
  } catch (e) {
    const err = /** @type {any} */ (e);
    process.stderr.write(`eval-h2h: ${err.code === "budget" ? "spend stop: " : ""}${err.message}\nThe replies so far are saved; rerun to continue.\n`);
    code = err.code === "budget" ? 3 : 1;
  }
  try { const after = await keyUsage({ key }); process.stdout.write(`eval-h2h: key usage after: ${usd(after.usage)} (this run ${usd(after.usage - before.usage)}); ledger $${budget.total.toFixed(4)} of $${CAP_USD}\n`); }
  catch (e) { process.stdout.write(`eval-h2h: key usage after: unavailable (${/** @type {Error} */ (e).message})\n`); }
  process.exitCode = code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { process.stderr.write(`eval-h2h: ${e.stack || e.message}\n`); process.exit(1); });
}
