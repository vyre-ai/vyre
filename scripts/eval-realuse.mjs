#!/usr/bin/env node
// @ts-check
// eval-realuse: the real-use memory test (the user approved it on Vyre's own sessions only, 1 Oct 2026). Input: a folder holding
// corpus.json from scripts/real-use-extract.mjs (scrubbed sessions). The corpus is data, never part of this repository, and the
// folder is deleted afterwards. Four arms answer the same questions on one cheap model, scored by the expected strings (no judge):
//   none          the model with no memory
//   claude-auto   Claude Code's auto memory, approximated: model-written notes per session, the newest 200 lines (simulated, as in eval-h2h)
//   vyre          Vyre Memory's memory.ask over the sessions, through eval-bar's own path (keyword retrieval with its fake embedder)
//   full-context  every session in the prompt: the ceiling
//
//   node scripts/eval-realuse.mjs <dir> --estimate    cost with no key
//   node scripts/eval-realuse.mjs <dir> --gen         write the questions (a model call per session) to <dir>/questions.json
//   node scripts/eval-realuse.mjs <dir> --run         run the four arms over <dir>/questions.json, write <dir>/results.json
//   node scripts/eval-realuse.mjs <dir> --report      print the saved results
//
// Spend: a hard cap of REALUSE_CAP_USD (default $5) on this test alone, read from a ledger in <dir> and from the key's own usage before
// and after. The key comes from OPENROUTER_EVAL_KEY in the environment and is never printed or written.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Budget, marginFor, keyUsage } from "./lib/eval-openrouter.js";
import { runBar } from "./eval-bar.js";
import { correct } from "./eval-answer.js";
import * as H from "./lib/h2h.js";
import { generateQuestions, textOfSession } from "./lib/realuse.js";
import { countingModel, liveModel } from "./eval-h2h.js";

const CAP = Number(process.env.REALUSE_CAP_USD) > 0 ? Number(process.env.REALUSE_CAP_USD) : 5;
const read = (/** @type {string} */ f) => JSON.parse(fs.readFileSync(f, "utf8"));

/** @param {import("./lib/h2h.js").Model & { rows: Map<string, any> }} model @param {string} dir @param {any[]} sessions @param {any[]} questions */
export async function runArms(model, dir, sessions, questions) {
  const world = { SESSIONS: sessions, PROJECTS: [] };
  const results = /** @type {any} */ ({ questions: questions.length, sessions: sessions.length, arms: {} });
  const score = (/** @type {string} */ arm, /** @type {{ answer: string }[]} */ got) => {
    const ok = got.map((g, i) => correct(g.answer, questions[i].expect));
    results.arms[arm] = { n: questions.length, ok: ok.filter(Boolean).length, right: ok };
  };
  // none
  score("none", await H.answerArm(model, "none", "Memory", "(you have no memory of the user's work)", questions));
  // vyre, through eval-bar's world "real"
  const world_file = path.join(dir, "corpus.json");
  process.env.VYRE_EVAL_REAL_WORLD = path.join(dir, "real-world.json");
  fs.writeFileSync(process.env.VYRE_EVAL_REAL_WORLD, JSON.stringify({ sessions, questions }));
  void world_file;
  const runner = async (/** @type {any} */ r) => { const x = await model.call({ arm: "vyre", kind: "answer", system: r.system, prompt: r.prompt, maxTokens: 400 }); return { text: x.text, usd: x.usd, tokens_in: x.tin, tokens_out: x.tout }; };
  const bar = await runBar({ world: "real", record: true, explain: true, runner, asks: path.join(dir, "real-asks.json"), classes: ["history"], freshness: false });
  const ex = bar.explained || [];
  results.arms.vyre = { n: ex.length, ok: ex.filter((/** @type {any} */ e) => e.ok).length, right: ex.map((/** @type {any} */ e) => Boolean(e.ok)) };
  // claude-auto
  const auto = await H.buildAutoMemory(model, world);
  score("claude-auto", await H.answerArm(model, "claude-auto", "MEMORY.md (auto memory)", auto.text, questions));
  results.arms["claude-auto"].note_lines = auto.lines;
  // full context
  score("full-context", await H.answerArm(model, "full-context", "Every session transcript", H.fullContext(world), questions));
  results.spend = Object.fromEntries([...model.rows].map(([k, v]) => [k, { calls: v.calls, usd: Math.round(v.usd * 1e4) / 1e4 }]));
  results.total_usd = Math.round([...model.rows.values()].reduce((n, v) => n + v.usd, 0) * 1e4) / 1e4;
  return results;
}

/** @param {any} r */
export function table(r) {
  const pc = (/** @type {any} */ x) => `${Math.round((100 * x.ok) / (x.n || 1))}% (${x.ok}/${x.n})`;
  const out = [`Real-use test: ${r.questions} questions from ${r.sessions} Vyre sessions (scrubbed), one model`, "", "| arm | right | cost |", "|---|---|---|"];
  for (const [k, v] of Object.entries(r.arms)) out.push(`| ${k} | ${pc(v)} | $${(r.spend && r.spend[k] ? r.spend[k].usd : 0).toFixed(3)} |`);
  out.push("", `Total spend: $${r.total_usd}`);
  return out.join("\n");
}

async function main(argv) {
  const dir = argv.find(a => !a.startsWith("--"));
  if (!dir) { console.error("usage: node scripts/eval-realuse.mjs <dir> --estimate|--gen|--run|--report"); process.exit(2); }
  const modelId = process.env.VYRE_EVAL_MODEL || H.DEFAULT_MODEL;
  if (argv.includes("--report")) { process.stdout.write(table(read(path.join(dir, "results.json"))) + "\n"); return; }
  const { sessions } = read(path.join(dir, "corpus.json"));
  if (argv.includes("--estimate")) {
    const m = countingModel(modelId);
    const qs = Array.from({ length: 50 }, (_, i) => ({ q: `Placeholder question ${i} about a specific fact in the work?`, class: "history", expect: ["x"] }));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-realuse-"));
    for (const s of sessions) await m.call({ arm: "qgen", kind: "qgen", system: "q", prompt: textOfSession(s).slice(0, 14_000), maxTokens: 700 });
    const r = await runArms(m, tmp, sessions, qs);
    const out = ["Estimate (no key, no model call)", "", "| arm | calls | tokens in | usd |", "|---|---|---|---|"];
    for (const [k, v] of m.rows) out.push(`| ${k} | ${v.calls} | ${v.tin} | ${v.usd.toFixed(3)} |`);
    out.push("", `Estimated total: $${r.total_usd + 0} (cap $${CAP})`);
    process.stdout.write(out.join("\n") + "\n");
    return;
  }
  if (!argv.includes("--gen") && !argv.includes("--run")) { console.error("--estimate, --gen, --run or --report"); process.exit(2); }
  const key = String(process.env.OPENROUTER_EVAL_KEY || "");
  const usd = (/** @type {number} */ n) => `$${n.toFixed(4)}`;
  let before;
  try { before = await keyUsage({ key }); console.log(`eval-realuse: key usage before: ${usd(before.usage)}`); if (before.usage >= 45) throw new Error("the key is nearly at its limit"); }
  catch (e) { console.error(`eval-realuse: ${/** @type {Error} */ (e).message}; nothing was sent.`); process.exit(3); }
  const cacheFile = path.join(dir, "replies.json");
  /** @type {Record<string, any>} */ const cache = fs.existsSync(cacheFile) ? read(cacheFile) : {};
  const budget = new Budget({ file: path.join(dir, "spend.json"), limit: CAP, margin: marginFor(modelId) });
  const model = liveModel({ key, model: modelId, budget, cache, save: () => fs.writeFileSync(cacheFile, JSON.stringify(cache)) });
  let code = 0;
  try {
    if (argv.includes("--gen")) {
      const qs = await generateQuestions(model, sessions, 50);
      fs.writeFileSync(path.join(dir, "questions.json"), JSON.stringify(qs, null, 1) + "\n");
      console.log(`eval-realuse: ${qs.length} questions written to ${path.join(dir, "questions.json")}`);
    } else {
      const qs = read(path.join(dir, "questions.json"));
      const r = await runArms(model, dir, sessions, qs);
      fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(r, null, 1) + "\n");
      console.log(table(r));
    }
  } catch (e) { const err = /** @type {any} */ (e); console.error(`eval-realuse: ${err.message}\nThe replies so far are saved in ${dir}.`); code = err.code === "budget" ? 3 : 1; }
  try { const after = await keyUsage({ key }); console.log(`eval-realuse: key usage after: ${usd(after.usage)} (this run ${usd(after.usage - before.usage)}); ledger ${usd(budget.total)} of $${CAP}`); } catch { console.log("eval-realuse: key usage after: unavailable"); }
  process.exitCode = code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(e => { console.error(`eval-realuse: ${e.message}`); process.exit(1); });
