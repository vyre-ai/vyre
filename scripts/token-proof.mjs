#!/usr/bin/env node
// @ts-check
// token-proof (R031-00n): does the small tool core (harness/mcp/core-tools.js) cost a model fewer tokens than listing every tool, and does it still get the work done?
//
//   node scripts/token-proof.mjs                      the dry estimate of one round and the ten tasks; calls no model, reads no key
//   node scripts/token-proof.mjs run --home <dir> --max-usd 5 [--arms old,core] [--reps 3] [--model <id>] [--only todo,doc] [--out <dir>]
//                                                     the paid round: drives headless Claude Code against the Vyre box at --home, one process per task and arm
//
// Arms: `old` lists every tool (VYRE_MCP_LISTING=all, Claude Code's own tool search off, so the whole listing is in the prompt); `old-search` lists every tool and leaves Claude Code's
// own tool search forced on (ENABLE_TOOL_SEARCH=true; it defers a long MCP list by itself); `core` is the new listing with tools_find and tools_call. Each run records input, output and cache tokens, time, turns, the
// tool calls made (tools_call unwrapped to the tool it ran) and pass or fail. The paid round runs only with VYRE_PROOF_PAID=yes in the environment AND --max-usd: it stops before the next run
// once Claude Code's own reported cost reaches the cap. It uses whatever ANTHROPIC_* auth the shell has; nothing is printed of it. Run it on the test box, never on a person's Mac.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TASKS, parseStream, passed, summarize, estimate, PRICES } from "./lib/token-proof.js";
import { tokens } from "../lib/tokens.js";
import { listing } from "../harness/mcp/core-tools.js";
import { agentCatalog } from "../test/tools-universe.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "estimate";
const flag = (/** @type {string} */ n, /** @type {string} */ d = "") => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ARMS = {
  old: { listing: "all", env: { VYRE_MCP_LISTING: "all", ENABLE_TOOL_SEARCH: "false" } },
  "old-search": { listing: "all", env: { VYRE_MCP_LISTING: "all", ENABLE_TOOL_SEARCH: "true" } },
  core: { listing: "core", env: { ENABLE_TOOL_SEARCH: "false" } },
};

function dry() {
  const cat = agentCatalog();
  const size = (/** @type {string} */ mode) => tokens(JSON.stringify(listing(cat, mode)));
  const sizes = { all: size("all"), core: size("") };
  console.log(`Listing: ${cat.length} tools an agent may use; all listed = ${sizes.all} tokens, core + tools_find/tools_call = ${sizes.core} tokens.\n`);
  console.log("Tasks (fixed prompts; pass = the right tool ran without an error, and the seeded fact is in the answer where there is one):");
  for (const t of TASKS) console.log(`  ${t.id.padEnd(10)} ${t.prompt}\n  ${" ".repeat(10)} tool: ${t.tools.join(" | ")}; world: ${t.seed}`);
  const reps = Number(flag("reps", "3"));
  for (const shared of [false, true]) {
    const e = estimate({ arms: [{ name: "old", listing: sizes.all, turns: 3 }, { name: "core", listing: sizes.core, turns: 5 }], reps, shared, prices: PRICES });
    console.log(`\nDry estimate, ${reps} reps, ${TASKS.length} tasks, two arms, ${shared ? "prefix cached across runs" : "no cache shared between runs"}: $${e.totalUsd}`);
    for (const a of e.arms) console.log(`  ${a.arm.padEnd(5)} ${a.runs} runs, ${a.turnsPerRun} turns each, ${a.tokensInPerRun} tokens in and ${a.tokensOutPerRun} out per run, $${a.usdPerRun} per run, $${a.usd} in all`);
  }
  console.log(`\nAssumptions: Claude Code's own prompt ~14,000 tokens; old arm 3 turns, core arm 5 (find, call, answer); ~900 tokens per tool result; prices per million tokens ${JSON.stringify(PRICES)} (check before a paid run).`);
}

/** Run claude to the end. @param {string[]} a @param {Record<string,string>} env @param {string} cwd */
function claude(a, env, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = "", err = "";
    const c = spawn("claude", a, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 300_000);
    c.on("error", (e) => { clearTimeout(timer); resolve({ out, err: String(e.message), ms: Date.now() - t0 }); });
    c.on("close", () => { clearTimeout(timer); resolve({ out, err, ms: Date.now() - t0 }); });
  });
}

async function paid() {
  if (process.env.VYRE_PROOF_PAID !== "yes") { console.error("refused: a paid round needs VYRE_PROOF_PAID=yes (the product owner's go)"); process.exit(2); }
  const cap = Number(flag("max-usd")); if (!(cap > 0)) { console.error("refused: --max-usd is required"); process.exit(2); }
  const home = flag("home"); if (!home || !fs.existsSync(home)) { console.error("refused: --home <the Vyre box's home> is required"); process.exit(2); }
  const arms = flag("arms", "old,core").split(",").filter((a) => a in ARMS), reps = Number(flag("reps", "1")), model = flag("model", process.env.VYRE_PROOF_MODEL || "");
  const only = flag("only") ? flag("only").split(",") : null, out = flag("out", fs.mkdtempSync(path.join(os.tmpdir(), "token-proof-")));
  fs.mkdirSync(out, { recursive: true });
  /** @type {any[]} */ const rows = []; let spent = 0;
  outer: for (let r = 0; r < reps; r++) for (const task of TASKS.filter((t) => !only || only.includes(t.id))) for (const arm of arms) {
    if (spent >= cap) { console.log(`stopped: reported spend $${spent.toFixed(3)} reached the cap of $${cap}`); break outer; }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "token-proof-work-"));
    const cfg = path.join(work, "mcp.json");
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { vyre: { command: process.execPath, args: [path.join(ROOT, "harness", "mcp", "server.js")], env: { VYRE_HOME: home, ...(ARMS[/** @type {keyof typeof ARMS} */ (arm)].env.VYRE_MCP_LISTING ? { VYRE_MCP_LISTING: "all" } : {}) } } } }));
    const env = { ...process.env, ...ARMS[/** @type {keyof typeof ARMS} */ (arm)].env, DISABLE_AUTOUPDATER: "1", CI: "1" };
    const a = ["-p", task.prompt, "--output-format", "stream-json", "--verbose", "--mcp-config", cfg, "--strict-mcp-config", "--allowedTools", "mcp__vyre", "--max-turns", "12", "--max-budget-usd", String(Math.max(0.05, Math.min(1, cap - spent)).toFixed(2)), ...(model ? ["--model", model] : [])];
    const res = /** @type {any} */ (await claude(a, /** @type {any} */ (env), work));
    const run = parseStream(res.out);
    const row = { arm, task: task.id, rep: r, pass: !run.error && passed(task, run), ...run, ms: run.ms || res.ms };
    spent += run.usd; rows.push(row);
    console.log(`${arm.padEnd(10)} ${task.id.padEnd(10)} ${row.pass ? "PASS" : "FAIL"}  in ${run.usage.input + run.usage.cacheRead + run.usage.cacheWrite}  out ${run.usage.output}  ${run.turns} turns  ${run.calls.length} calls  $${run.usd.toFixed(4)}  ${(row.ms / 1000).toFixed(1)}s`);
    fs.writeFileSync(path.join(out, "rows.json"), JSON.stringify(rows, null, 1));
  }
  console.log("\n" + JSON.stringify(summarize(rows), null, 1) + `\nrows: ${path.join(out, "rows.json")}`);
}

if (cmd === "run") await paid(); else dry();
