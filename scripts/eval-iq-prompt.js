#!/usr/bin/env node
// @ts-check
// eval-iq-prompt: does the Capsule's quick answer (Vyre IQ, core/sessions/iq-prompt.js) answer
// only from its facts, cite them, say "I don't know yet" when none answers, and say the same
// thing twice?
//
//   node scripts/eval-iq-prompt.js --live            ask the model each case twice (costs a few cents)
//   node scripts/eval-iq-prompt.js --live --runs 3   three times each
//   node scripts/eval-iq-prompt.js --live --model sonnet
//   node scripts/eval-iq-prompt.js --json            the report as JSON
//
// --live runs Claude Code the way vyred starts a quick answer: the composed prompt replacing
// Claude Code's own, no tools, no MCP servers, none of the user's settings, thinking off, on the
// capsule purpose's model (haiku unless --model). It uses the Claude login of whoever runs it, so
// only a person runs it; tests grade fixed answers instead (test/eval/iq-prompt.test.js).
// VYRE_CLAUDE_BIN names another claude binary.
//
// The bar: every case passes on every run, and every case gives the same answer on every run.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { composeIq, IDK } from "../core/sessions/iq-prompt.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CASES_FILE = path.join(ROOT, "test/eval/iq-prompt.json");

/** @typedef {{ id: string, q: string, facts: string[], expect: { idk?: boolean, has?: string[], cites?: number[] } }} Case */

/** Talk about access or tools the prompt forbids. */
const ACCESS = /\b(access|tools?|memory system|can(?:not|'t) see|do(?:n't| not) have (?:any )?(?:information|data|memory)|as an ai|language model)\b/i;
const TYPO = /\btypo|misspel|did you mean\b/i;

/** Sentences in an answer: citations and the periods inside them do not split. */
export const sentences = (/** @type {string} */ a) => a.replace(/\[\d+\]/g, "").split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => /\w/.test(s)).length;

/**
 * Grade one answer against its case. Returns the failures, none when it passes.
 * @param {string} answer @param {Case} c
 * @returns {string[]}
 */
export function grade(answer, c) {
  const a = String(answer ?? "").trim();
  const why = [];
  if (/—/.test(a)) why.push("an em dash");
  if (c.expect.idk) {
    if (a !== IDK) why.push(`not exactly "${IDK}"`);
    return why;
  }
  if (a === IDK || /don't know yet/i.test(a)) { why.push("said it does not know, and a fact answers it"); return why; }
  for (const w of c.expect.has || []) if (!a.toLowerCase().includes(w.toLowerCase())) why.push(`does not say "${w}"`);
  for (const n of c.expect.cites || []) if (!a.includes(`[${n}]`)) why.push(`does not cite [${n}]`);
  const cited = [...a.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
  for (const n of cited) if (n < 1 || n > c.facts.length) why.push(`cites [${n}], which is not a fact`);
  const n = sentences(a);
  if (n < 1 || n > 3) why.push(`${n} sentences, not 1 to 3`);
  if (ACCESS.test(a)) why.push("talks about its access or tools");
  if (TYPO.test(a)) why.push("mentions a typo");
  return why;
}

/**
 * Grade every case's answers (one per run): passes, and the same answer every run.
 * @param {Case[]} cases @param {Record<string, string[]>} answers case id to its runs' answers
 */
export function report(cases, answers) {
  const rows = cases.map(c => {
    const runs = answers[c.id] || [];
    const fails = runs.map(a => grade(a, c));
    const steady = runs.length > 0 && runs.every(a => a.trim() === runs[0].trim());
    return { id: c.id, runs: runs.length, pass: runs.length > 0 && fails.every(f => f.length === 0), steady, fails: fails.flat(), answer: runs[0] ?? null };
  });
  const pass = rows.filter(r => r.pass).length, steady = rows.filter(r => r.steady).length;
  return { cases: rows.length, pass, steady, ok: pass === rows.length && steady === rows.length, rows };
}

/** @returns {Case[]} */
export const loadCases = () => JSON.parse(fs.readFileSync(CASES_FILE, "utf8")).cases;

/** One live answer: Claude Code with the quick answer's launch. @param {Case} c @param {string} model */
function ask(c, model) {
  const sys = composeIq({ facts: c.facts }).text;
  const r = spawnSync(process.env.VYRE_CLAUDE_BIN || "claude",
    ["-p", c.q, "--system-prompt", sys, "--model", model, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--output-format", "text"],
    { encoding: "utf8", timeout: 120_000, env: { ...process.env, MAX_THINKING_TOKENS: "0" } });
  if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${String(r.stderr || r.error || "").slice(0, 300)}`);
  return String(r.stdout).trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (/** @type {string} */ k, /** @type {string} */ d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  if (!args.includes("--live")) {
    console.error("This asks the model and uses your Claude login: run it with --live. The graded fixtures run in the tests.");
    process.exit(2);
  }
  const cases = loadCases();
  const runs = Math.max(1, Number(opt("--runs", "2")) || 2), model = opt("--model", "haiku");
  /** @type {Record<string, string[]>} */ const answers = {};
  for (const c of cases) { answers[c.id] = []; for (let i = 0; i < runs; i++) answers[c.id].push(ask(c, model)); }
  const r = report(cases, answers);
  if (args.includes("--json")) console.log(JSON.stringify({ model, runs, ...r }, null, 2));
  else {
    console.log(`Vyre IQ prompt ${composeIq().version} on ${model}, ${runs} runs: ${r.pass}/${r.cases} pass, ${r.steady}/${r.cases} steady`);
    for (const row of r.rows) console.log(`${row.pass && row.steady ? "ok  " : "FAIL"} ${row.id}: ${JSON.stringify(row.answer)}${row.fails.length ? `  (${[...new Set(row.fails)].join("; ")})` : ""}${row.steady ? "" : "  (answers differ)"}`);
  }
  process.exit(r.ok ? 0 : 1);
}
