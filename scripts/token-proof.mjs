#!/usr/bin/env node
// @ts-check
// token-proof (R031-00n): does the small tool core (harness/mcp/core-tools.js) cost a model fewer tokens than listing every tool, and does it still get the work done?
//
//   node scripts/token-proof.mjs                      the dry estimate of one round and the ten tasks; calls no model, reads no key
//   node scripts/token-proof.mjs run --home <dir> --max-usd 5 [--arms old,core] [--reps 3] [--model <id>] [--only todo,doc] [--out <dir>]
//                                                     the paid round: seeds a fresh box at --home (scripts/token-proof-world.mjs) and has the assistant do each task as a fresh thread on the
//                                                     real claude, once per arm. The proof runs as a Vyre-started agent, the way agents really use Vyre: the person's own Claude Code session
//                                                     attaches as the plugin agent and is offered only memory and recall, so it would show nothing.
//
// Arms: `old` lists every tool (VYRE_MCP_LISTING=all, Claude Code's own tool search off, so the whole listing is in the prompt); `old-search` lists every tool and leaves Claude Code's
// own tool search forced on (ENABLE_TOOL_SEARCH=true; it defers a long MCP list by itself); `core` is the new listing with tools_find and tools_call. Each run records input, output and cache tokens, time, turns, the
// tool calls made (tools_call unwrapped to the tool it ran) and pass or fail. The paid round runs only with VYRE_PROOF_PAID=yes in the environment AND --max-usd: it stops before the next run
// once Claude Code's own reported cost reaches the cap. It uses whatever ANTHROPIC_* auth the shell has; nothing is printed of it. Run it on the test box, never on a person's Mac.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TASKS, parseStream, passed, summarize, estimate, PRICES } from "./lib/token-proof.js";
import { tokens } from "../lib/tokens.js";
import { listing } from "../harness/mcp/core-tools.js";
import { broadCatalog } from "../test/tools-universe.js";
import { catalogOf } from "../harness/mcp/core-tools.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "estimate";
const flag = (/** @type {string} */ n, /** @type {string} */ d = "") => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ARMS = {
  old: { listing: "all", env: { VYRE_MCP_LISTING: "all", ENABLE_TOOL_SEARCH: "false" } },
  "old-search": { listing: "all", env: { VYRE_MCP_LISTING: "all", ENABLE_TOOL_SEARCH: "true" } },
  core: { listing: "core", env: { ENABLE_TOOL_SEARCH: "false" } },
};

/** The tools a Vyre agent is offered, from a real in-process daemon when this machine may start one (a test box); otherwise an estimate from the manifests, which counts about twice as many. */
async function catalogNow() {
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-proof-dry-"));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
    const { start } = await import("../core/daemon/index.js");
    const { present } = await import("../test/helpers.js");
    const { PERSON_ONLY, HUMAN_ONLY } = await import("../core/presence/index.js");
    const d = await start({ root, presence: present, log: () => {} });
    try {
      return { exact: true, cat: catalogOf(d.registry.listTools("mcp:agent:kit").filter((/** @type {any} */ x) => !x.name.startsWith("harness.") && !PERSON_ONLY.has(x.name) && !HUMAN_ONLY.has(x.name)).map((/** @type {any} */ x) => ({ name: x.name, description: String(x.description || ""), input: x.input }))) };
    } finally { await d.stop(); }
  } catch { return { exact: false, cat: broadCatalog() }; }
}

async function dry() {
  const { exact, cat } = await catalogNow();
  const size = (/** @type {string} */ mode) => tokens(JSON.stringify(listing(cat, mode)));
  const sizes = { all: size("all"), core: size("") };
  console.log(`${exact ? "" : "(An estimate from the manifests: this machine cannot start a daemon, and the estimate counts about twice as many tools. Run it on the test box for the exact numbers.)\n"}Listing: ${cat.length} tools an agent may use; all listed = ${sizes.all} tokens, core + tools_find/tools_call = ${sizes.core} tokens.\n`);
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

/** The paid round: refuses without the go, a cap and a home, then hands over to the seeded world (scripts/token-proof-world.mjs run), which starts the assistant's threads on the real claude. */
function paid() {
  if (process.env.VYRE_PROOF_PAID !== "yes" && !args.includes("--stand-in")) { console.error("refused: a paid round needs VYRE_PROOF_PAID=yes (the product owner's go)"); process.exit(2); }
  if (!(Number(flag("max-usd")) > 0)) { console.error("refused: --max-usd is required"); process.exit(2); }
  if (!flag("home")) { console.error("refused: --home <a fresh folder for the proof box> is required"); process.exit(2); }
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "token-proof-world.mjs"), ...args], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

if (cmd === "run") paid(); else await dry();
