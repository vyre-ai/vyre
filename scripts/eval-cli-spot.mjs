#!/usr/bin/env node
// @ts-check
// eval-cli-spot: what the head-to-head (scripts/eval-h2h.js) cannot show from simulated arms, measured
// on a hosted runner with the real binaries, through the capped OpenRouter key. Run by
// .github/workflows/memory-h2h-record.yml after the head-to-head; never on a person's machine.
//
//   node scripts/eval-cli-spot.mjs claude   10 questions through the real `claude -p`, with the auto-memory notes the
//                                           head-to-head wrote (and a canary that says whether headless Claude Code loads them)
//   node scripts/eval-cli-spot.mjs codex    10 questions through the real `codex exec` with the hand-kept AGENTS.md
//   node scripts/eval-cli-spot.mjs cache    does a UserPromptSubmit hook's additionalContext keep the cache hit?
//   node scripts/eval-cli-spot.mjs meter    do Codex and Grok send usage_update through Vyre's ACP driver, and does a fresh
//                                           session take a 20,000-token seed? (the rollover's trigger and landing)
//
// Every step is a measurement: a failure is a line in the output, never a crash, and the exit code is 0. The key is never printed.
// Spend: the job's whole spend (key usage now minus the job's start) is read before every call; a step stops at
// JOB_STOP_USD ($4.6) so the round stays under its $5 cap. Results are appended to test/eval/h2h/spot.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keyUsage, modelListed } from "./lib/eval-openrouter.js";
import { WORLDS } from "./eval-bar.js";
import { correct } from "./eval-answer.js";
import { pickQuestions, abstains } from "./lib/h2h.js";
import { codexProvider } from "../core/sessions/drivers/codex.js";
import { grokProvider } from "../core/sessions/drivers/grok.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.VYRE_H2H_DIR || path.join(ROOT, "test/eval/h2h");
/** A test may point the key-usage read at a local stand-in; any other address is ignored, so the key never goes elsewhere. */
const KEY_ENDPOINT = /^http:\/\/127\.0\.0\.1[:/]/.test(String(process.env.VYRE_EVAL_KEY_ENDPOINT || "")) ? String(process.env.VYRE_EVAL_KEY_ENDPOINT) : undefined;
const usageNow = async () => (await keyUsage({ key, ...(KEY_ENDPOINT ? { endpoint: KEY_ENDPOINT } : {}) })).usage;
export const JOB_STOP_USD = Number(process.env.H2H_JOB_STOP_USD) > 0 ? Number(process.env.H2H_JOB_STOP_USD) : 4.6;
const MODEL = process.env.VYRE_EVAL_MODEL || "anthropic/claude-haiku-4.5";
const key = String(process.env.OPENROUTER_EVAL_KEY || process.env.OPENROUTER_API_KEY || "");
const scrub = (/** @type {any} */ s) => String(s ?? "").split(key || "\u0000").join("[key]").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[key]");
const say = (/** @type {string} */ k, /** @type {string} */ w) => console.log(`${k} ${scrub(w).replace(/\s+/g, " ").slice(0, 400)}`);
const tmp = (/** @type {string} */ p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** @type {number | null} */ let start = null;
/** What the job has spent so far, from the key itself; throws when it cannot be read or the stop is reached. */
async function guard() {
  const u = await usageNow();
  if (start == null) start = Number(process.env.H2H_JOB_START_USAGE) || u;
  if (u - start >= JOB_STOP_USD) throw Object.assign(new Error(`job spend stop: $${(u - start).toFixed(3)} of the round's $5`), { code: "budget" });
  return u;
}

/** Run a binary to the end with a timeout. @param {string} bin @param {string[]} args @param {{ env: Record<string,string>, cwd: string, ms?: number, input?: string }} o @returns {Promise<{ code: number|null, out: string, err: string, ms: number }>} */
function run(bin, args, o) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const c = spawn(bin, args, { env: o.env, cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
    c.stdin.on("error", () => {});
    c.stdin.end(o.input || "");
    const timer = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, o.ms || 180_000);
    c.on("error", e => { clearTimeout(timer); resolve({ code: null, out, err: String(e.message), ms: Date.now() - t0 }); });
    c.on("close", code => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0 }); });
  });
}

const spot = () => { const w = WORLDS.open(); const all = pickQuestions(w.gold.questions, ["personal", "decision", "history", "who", "where", "time", "cross_provider", "unanswerable"], 10); return all.filter((_, i) => i % 8 === 3); };
const read = (/** @type {string} */ f) => (fs.existsSync(path.join(DIR, f)) ? fs.readFileSync(path.join(DIR, f), "utf8") : "");
/** @param {any} q @param {string} a */
const right = (q, a) => (q.class === "unanswerable" ? abstains(a) && !(q.forbid || []).some((/** @type {string} */ f) => a.toLowerCase().includes(f.toLowerCase())) : correct(a, q.expect));
const ASK = (/** @type {string} */ q) => `${q}\n\nAnswer from your memory and instructions only, in one or two sentences. If they do not contain it, say exactly: I don't know.`;

/** @type {any} */ const report = { when: new Date().toISOString(), model: MODEL };

// ------------------------------------------------------------------ claude

async function claudeSpot() {
  const notes = read("notes-auto.md");
  if (!notes) { say("FAIL", "claude: test/eval/h2h/notes-auto.md is missing (the head-to-head writes it)"); return; }
  const qs = spot();
  const home = tmp("spot-claude-home-"), cwd = tmp("spot-claude-work-");
  const env = { PATH: process.env.PATH || "", HOME: home, ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: MODEL, ANTHROPIC_SMALL_FAST_MODEL: MODEL, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CI: "1" };
  // Auto memory lives under ~/.claude/projects/<the project path with / and . as dashes>/memory/MEMORY.md.
  const enc = fs.realpathSync(cwd).replace(/[/.]/g, "-");
  const memDir = path.join(home, ".claude", "projects", enc, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "MEMORY.md"), `${notes}\n- The passphrase for the spot check is blue-heron-72 (canary).\n`);
  const ask = async (/** @type {string} */ text) => {
    const r = await run("claude", ["-p", text, "--output-format", "json", "--model", MODEL, "--max-turns", "3"], { env, cwd, ms: 240_000 });
    let j = null; try { j = JSON.parse(r.out); } catch { /* not json */ }
    return { text: String(j && j.result != null ? j.result : r.out.slice(-300) || r.err.slice(-300)), usd: j && Number(j.total_cost_usd) || 0, code: r.code, err: r.err, usage: j && j.usage || null };
  };
  let via = "auto-memory";
  try {
    await guard();
    const c = await ask(ASK("What is the passphrase for the spot check?"));
    const loaded = /blue-heron-72/i.test(c.text);
    say(loaded ? "PASS" : "INFO", `claude: auto memory ${loaded ? "was loaded by headless Claude Code (canary found)" : "was NOT loaded by headless Claude Code (canary not found); the notes go in CLAUDE.md for this check"}${c.code ? `; exit ${c.code}: ${c.err.slice(-200)}` : ""}`);
    if (!loaded) { via = "claude-md"; fs.writeFileSync(path.join(cwd, "CLAUDE.md"), `# Notes\n${notes}\n`); }
  } catch (e) { say("FAIL", `claude: ${/** @type {Error} */ (e).message}`); return; }
  const before = await guard();
  const rows = [];
  for (const q of qs) {
    try { await guard(); } catch (e) { say("INFO", `claude: ${/** @type {Error} */ (e).message}`); break; }
    const a = await ask(ASK(q.q));
    rows.push({ class: q.class, q: q.q, answer: a.text.slice(0, 200), ok: right(q, a.text), reported_usd: a.usd, code: a.code });
  }
  const after = await guard();
  const ok = rows.filter(r => r.ok).length;
  say("PASS", `claude (${via}): ${ok} of ${rows.length} right; key spend for this step $${(after - before).toFixed(4)}; Claude Code reported $${rows.reduce((n, r) => n + r.reported_usd, 0).toFixed(4)}`);
  for (const r of rows.filter(r => !r.ok)) say("INFO", `claude missed [${r.class}] ${r.q} -> ${r.answer}`);
  report.claude = { via, n: rows.length, ok, usd: Math.round((after - before) * 1e4) / 1e4, rows };
}

// ------------------------------------------------------------------ codex

async function codexSpot() {
  const agents = read("notes-agents.md");
  if (!agents) { say("FAIL", "codex: test/eval/h2h/notes-agents.md is missing (the head-to-head writes it)"); return; }
  const qs = spot();
  const home = tmp("spot-codex-home-"), cwd = tmp("spot-codex-work-");
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), agents + "\n");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const env = { PATH: process.env.PATH || "", HOME: home, CODEX_HOME: path.join(home, ".codex"), OPENROUTER_API_KEY: key, CI: "1" };
  const cfg = (/** @type {string} */ model) => ["-c", `model_provider="openrouter"`, "-c", `model="${model}"`,
    "-c", `model_providers.openrouter={ name = "openrouter", base_url = "https://openrouter.ai/api/v1", env_key = "OPENROUTER_API_KEY", wire_api = "responses" }`];
  const ask = async (/** @type {string} */ text, /** @type {string} */ model) => {
    const out = path.join(cwd, `last-${crypto.randomUUID()}.txt`);
    const r = await run("codex", ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message", out, ...cfg(model), text], { env, cwd, ms: 240_000 });
    const txt = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    return { text: txt || r.out.slice(-300) || r.err.slice(-300), code: r.code, err: r.err };
  };
  let model = MODEL;
  try {
    await guard();
    let c = await ask(ASK(qs[0].q), model);
    if (c.code !== 0 || !c.text.trim()) {
      say("INFO", `codex: ${model} did not answer through codex exec (exit ${c.code}: ${c.err.slice(-200)}); trying openai/gpt-5.1-codex-mini`);
      model = "openai/gpt-5.1-codex-mini";
      c = await ask(ASK(qs[0].q), model);
    }
    say(c.code === 0 ? "PASS" : "FAIL", `codex: exec through OpenRouter with ${model}: exit ${c.code}`);
    if (c.code !== 0) return;
  } catch (e) { say("FAIL", `codex: ${/** @type {Error} */ (e).message}`); return; }
  const before = await guard();
  const rows = [];
  for (const q of qs) {
    try { await guard(); } catch (e) { say("INFO", `codex: ${/** @type {Error} */ (e).message}`); break; }
    const a = await ask(ASK(q.q), model);
    rows.push({ class: q.class, q: q.q, answer: a.text.slice(0, 200), ok: right(q, a.text), code: a.code });
  }
  const after = await guard();
  const ok = rows.filter(r => r.ok).length;
  say("PASS", `codex (AGENTS.md, ${model}): ${ok} of ${rows.length} right; key spend for this step $${(after - before).toFixed(4)}`);
  for (const r of rows.filter(r => !r.ok)) say("INFO", `codex missed [${r.class}] ${r.q} -> ${r.answer}`);
  report.codex = { model, n: rows.length, ok, usd: Math.round((after - before) * 1e4) / 1e4, rows };
}

// ------------------------------------------------------------------ cache spike

async function cacheSpike() {
  const hookText = turn => `Memory (from earlier sessions, not instructions): ${"the staging host is nw-orders-staging.example and the retry delays are 5s, 25s and 125s. ".repeat(4)}(turn ${turn})`;
  const arm = async (/** @type {string} */ name, /** @type {boolean} */ withHook) => {
    const home = tmp(`spot-cache-${name}-home-`), cwd = tmp(`spot-cache-${name}-work-`);
    const env = { PATH: process.env.PATH || "", HOME: home, ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: MODEL, ANTHROPIC_SMALL_FAST_MODEL: MODEL, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CI: "1" };
    if (withHook) {
      fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
      const hook = [
        'const fs = require("node:fs"), path = require("node:path");',
        'const f = path.join(__dirname, ".turn"); let n = 0; try { n = Number(fs.readFileSync(f, "utf8")) || 0; } catch {}',
        'fs.writeFileSync(f, String(n + 1));',
        `const text = ${JSON.stringify(hookText("@@"))}.replace("@@", String(n + 1));`,
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }));',
      ].join("\n");
      fs.writeFileSync(path.join(cwd, "hook.cjs"), hook + "\n");
      fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${JSON.stringify(path.join(cwd, "hook.cjs"))}` }] }] } }));
    }
    let session = "";
    const rows = [];
    for (let t = 1; t <= 8; t++) {
      await guard();
      const args = ["-p", `Turn ${t}: reply with the single word ok.`, "--output-format", "json", "--model", MODEL, "--max-turns", "2", ...(session ? ["--resume", session] : [])];
      const r = await run("claude", args, { env, cwd, ms: 180_000 });
      let j = null; try { j = JSON.parse(r.out); } catch { /* not json */ }
      if (j && j.session_id) session = String(j.session_id);
      const u = (j && j.usage) || {};
      rows.push({ turn: t, input: u.input_tokens ?? null, cache_read: u.cache_read_input_tokens ?? null, cache_write: u.cache_creation_input_tokens ?? null, ok: Boolean(j) });
      if (!j) { say("INFO", `cache ${name} turn ${t}: no json (exit ${r.code}): ${r.err.slice(-200)}`); break; }
    }
    return rows;
  };
  try {
    const control = await arm("control", false), hooked = await arm("hook", true);
    const line = (/** @type {any[]} */ rows) => rows.map(r => `${r.turn}:${r.cache_read ?? "?"}/${r.cache_write ?? "?"}`).join(" ");
    say("INFO", `cache control (turn:cache_read/cache_write) ${line(control)}`);
    say("INFO", `cache with additionalContext hook ${line(hooked)}`);
    const reads = (/** @type {any[]} */ rows) => rows.slice(2).map(r => Number(r.cache_read) || 0);
    const cr = reads(control), hr = reads(hooked);
    const avg = (/** @type {number[]} */ x) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
    if (!cr.length || avg(cr) === 0) say("INFO", "cache: the control run reported no cache reads (OpenRouter may not pass them through); the spike cannot say");
    else say(avg(hr) >= 0.8 * avg(cr) ? "PASS" : "FAIL", `cache: from turn 3 the hooked session reads ${Math.round(avg(hr))} cached tokens a turn against ${Math.round(avg(cr))} for the control (${avg(hr) >= 0.8 * avg(cr) ? "additionalContext keeps the cache hit" : "additionalContext costs cache hits"})`);
    report.cache = { control, hooked };
  } catch (e) { say("FAIL", `cache: ${/** @type {Error} */ (e).message}`); }
}

// ------------------------------------------------------------------ meter spike

async function meterSpike() {
  report.meter = {};
  for (const which of ["codex", "grok"]) {
    const home = tmp(`spot-meter-${which}-home-`), cwd = tmp(`spot-meter-${which}-work-`);
    const custom = which === "codex"
      ? { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", model: "openai/gpt-5.1-codex-mini" }
      : { id: "proof", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", model: "x-ai/grok-build-0.1" };
    // A model OpenRouter no longer lists fails every turn; Grok Build shows that as "Internal error", so say what it is.
    if ((await modelListed(custom.model)) === false) { say("FAIL", `meter ${which}: ${custom.model} is not on OpenRouter any more, so every turn would fail (Grok Build reports that as "Internal error"); nothing was sent`); continue; }
    const provider = which === "codex" ? codexProvider({ custom }) : grokProvider({ custom });
    const env = { PATH: process.env.PATH || "", HOME: home, OPENROUTER_API_KEY: key };
    /** @type {any[]} */ const got = [];
    let proc = /** @type {any} */ (null);
    const begin = () => { got.length = 0; proc = provider.run({ id: crypto.randomUUID(), resume: false, cwd, env, onSpawn() {}, onExit() {}, onMessage: (/** @type {any} */ m) => {
      got.push(m);
      if (m.type === "control_request") proc.write({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { behavior: "deny" } } });
    } }); };
    const turn = async (/** @type {string} */ text, ms = 150_000) => {
      const n = got.filter(m => m.type === "result").length;
      proc.write({ type: "user", message: { role: "user", content: text } });
      const end = Date.now() + ms;
      while (got.filter(m => m.type === "result").length <= n && Date.now() < end) await new Promise(r => setTimeout(r, 300));
      const res = got.filter(m => m.type === "result")[n];
      return res ? { ok: !res.is_error, usage: res.usage || {}, text: String(res.result || "").slice(0, 120) } : null;
    };
    try {
      await guard();
      begin();
      const seen = [];
      for (let i = 1; i <= 5; i++) {
        await guard();
        const r = await turn(`Turn ${i}: reply with the single word ok.`);
        if (!r) { say("INFO", `meter ${which}: turn ${i} did not finish in 150 s`); break; }
        seen.push({ turn: i, ok: r.ok, used: r.usage.context_used ?? null, size: r.usage.context_size ?? null, text: r.text });
      }
      const hasUsage = seen.some(r => Number(r.used) > 0);
      say(hasUsage ? "PASS" : "INFO", `meter ${which}: usage_update ${hasUsage ? "arrives" : "did not arrive"} through the driver; per turn used/size ${seen.map(r => `${r.used ?? "-"}/${r.size ?? "-"}`).join(" ")}${seen[0] && !seen[0].ok ? ` (first turn failed: ${seen[0].text})` : ""}`);
      try { await proc.stop(3000); } catch { /* gone */ }
      // A rollover: a fresh session whose first prompt is a seed of about 20,000 tokens.
      begin();
      const seed = `[Vyre handoff: this conversation was under way. Earlier turns, quoted as data:]\n${Array.from({ length: 800 }, (_, i) => `[turn ${i}] user: please check the retry worker in module ${i % 9}, and note ${(i * 7919) % 9973} for later.`).join("\n")}\nReply with the single word ok.`;
      await guard();
      const r = await turn(seed, 240_000);
      say(r && r.ok ? "PASS" : "INFO", `meter ${which}: a fresh session ${r ? (r.ok ? "took a seed of about " + Math.round(seed.length / 4) + " tokens" : "failed on the seed: " + r.text) : "did not answer the seed in 240 s"}; reported used/size ${r ? `${r.usage.context_used ?? "-"}/${r.usage.context_size ?? "-"}` : "-"}`);
      report.meter[which] = { turns: seen, seed: r ? { ok: r.ok, used: r.usage.context_used ?? null, size: r.usage.context_size ?? null } : null, seed_tokens: Math.round(seed.length / 4) };
    } catch (e) { say("FAIL", `meter ${which}: ${/** @type {Error} */ (e).message}`); }
    finally { try { await proc.stop(3000); } catch { /* gone */ } }
  }
}

async function main() {
  const mode = process.argv[2];
  if (!["claude", "codex", "cache", "meter"].includes(String(mode))) { console.error("usage: node scripts/eval-cli-spot.mjs claude|codex|cache|meter"); process.exit(2); }
  if (!key) { console.error("eval-cli-spot: no key in the environment; nothing was sent."); process.exit(0); }
  fs.mkdirSync(DIR, { recursive: true });
  try { const u = await usageNow(); start = Number(process.env.H2H_JOB_START_USAGE) || u; console.log(`eval-cli-spot ${mode}: key usage before: $${u.toFixed(4)} (job start $${start.toFixed(4)})`); }
  catch (e) { console.error(`eval-cli-spot: ${/** @type {Error} */ (e).message}; nothing was sent.`); process.exit(0); }
  try {
    if (mode === "claude") await claudeSpot(); else if (mode === "codex") await codexSpot(); else if (mode === "cache") await cacheSpike(); else await meterSpike();
  } catch (e) { say("FAIL", `${mode}: ${/** @type {Error} */ (e).message}`); }
  try { const u = await usageNow(); console.log(`eval-cli-spot ${mode}: key usage after: $${u.toFixed(4)} (job so far $${(u - /** @type {number} */ (start)).toFixed(4)})`); } catch { console.log("eval-cli-spot: key usage after: unavailable"); }
  const f = path.join(DIR, "spot.json");
  /** @type {any} */ let all = {}; try { all = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* new */ }
  fs.writeFileSync(f, JSON.stringify({ ...all, ...Object.fromEntries(Object.entries(report).filter(([k]) => !["when", "model"].includes(k))), when: report.when, model: MODEL }, null, 1) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(`eval-cli-spot: ${scrub(e.stack || e.message)}`); process.exit(0); });
