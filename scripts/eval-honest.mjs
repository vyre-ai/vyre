#!/usr/bin/env node
// @ts-check
// eval-honest (R031-00v): the honest evals. Eval A: plain Claude Code against Claude Code with Vyre (plain as given, plain given the data). Eval B: memory across a forced roll (Claude's own /compact,
// Vyre's seed only, Vyre's seed with the reference sheet and link, and no roll). See scripts/eval-honest/prereg.json for the tasks and checks and team/0.3.1/DESIGN-rollover-v2.md Part 2 for the rules.
//
//   node scripts/eval-honest.mjs plan                       calls no model: the cells, the number of runs, the lint of the scripted conversation, the seal, and a cost estimate
//   node scripts/eval-honest.mjs seal                       writes scripts/eval-honest/PREREG.sha256 (the hash of prereg.json and heldout.json). Do this once, commit, then run.
//   node scripts/eval-honest.mjs check --home <dir>         the free dry run on the stand-in claude (test box only): seeds the world, runs every plumbing step, calls no model, spends nothing
//   node scripts/eval-honest.mjs run --home <dir> --max-usd <n> [--which A|B|all] [--reps 3] [--only recall,todo] [--cells vyre,plain-a2] [--arms compact,no-roll] [--out <dir>] [--model <id>] [--claude <bin>]
//                                                           the paid run. Needs VYRE_PROOF_PAID=yes, --max-usd, a sealed prereg and a committed tree. The product owner's go; the lead runs it.
//   node scripts/eval-honest.mjs report --out <dir>         the report from <dir>/rows.json
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { report, plan, lint, endedRow } from "./lib/eval-honest.js";
import { whereIsIt, inspectorUrl } from "./eval-honest/stall.mjs";
import { loadSealed } from "./eval-honest/run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "plan";
const flag = (/** @type {string} */ n, /** @type {string} */ d = "") => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

if (cmd === "seal") {
  const { seal } = loadSealed();
  fs.writeFileSync(path.join(HERE, "eval-honest", "PREREG.sha256"), seal + "\n");
  console.log(`sealed: ${seal}\ncommit scripts/eval-honest/ before any paid run`);
} else if (cmd === "report") {
  const out = flag("out");
  if (!out) { console.error("--out <dir> is required"); process.exit(2); }
  const { seal } = loadSealed();
  const dp = path.join(out, "disclosures.json");
  const md = report(JSON.parse(fs.readFileSync(path.join(out, "rows.json"), "utf8")), { title: "Honest eval", seal, disclosures: fs.existsSync(dp) ? JSON.parse(fs.readFileSync(dp, "utf8")) : [] });
  fs.writeFileSync(path.join(out, "report.md"), md); console.log(md);
} else if (cmd === "check" || cmd === "run") {
  if (!flag("home")) { console.error("--home <a fresh folder for the proof box> is required"); process.exit(2); }
  const extra = cmd === "check" ? ["--check", "--stand-in"] : [];
  // The run always has an --out folder: the supervisor below reads the harness's heartbeat there.
  const out = flag("out") || `${path.resolve(flag("home"))}-honest-${Date.now()}`;
  const rest = args.slice(1);
  if (!flag("out")) rest.push("--out", out);
  fs.mkdirSync(out, { recursive: true });
  // The harness runs with its inspector open on loopback, so a stalled one can be paused, from here, and asked where its main thread is (a busy loop cannot refuse a pause).
  const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", path.join(HERE, "token-proof-world.mjs"), "eval", ...rest, ...extra], { stdio: ["inherit", "inherit", "pipe"], env: process.env });
  let inspector = "";
  child.stderr.on("data", (/** @type {Buffer} */ b) => { process.stderr.write(b); inspector = inspector || inspectorUrl(String(b)); });
  const STALL_MS = Number(flag("stall-min", "3")) * 60_000;
  const watch = setInterval(async () => {
    let age = 0;
    try { age = Date.now() - fs.statSync(path.join(out, ".heartbeat")).mtimeMs; } catch { return; }   // no beat yet: still seeding
    if (age <= STALL_MS) return;
    clearInterval(watch);
    /** @type {any} */ let beat = {};
    try { beat = JSON.parse(fs.readFileSync(path.join(out, ".heartbeat"), "utf8")); } catch { /* unreadable */ }
    console.error(`STALLED: the harness has not beaten for ${Math.round(age / 1000)} s (its event loop is blocked). It was in: ${beat.phase || "unknown"}.`);
    // Whether its threads are spinning or waiting (a busy loop shows ~100% CPU; a call that waits on a process shows a sleeping state), then where its main thread is, asked over the inspector.
    try { const ps = spawnSync("ps", ["-L", "-o", "tid,pcpu,stat,wchan:24", "-p", String(child.pid)], { encoding: "utf8" }); console.error(ps.stdout || ps.stderr); } catch { /* no ps */ }
    const frames = inspector ? await whereIsIt(inspector) : [];
    console.error(frames.length ? `where its main thread is:\n  ${frames.join("\n  ")}` : "where its main thread is: it did not answer (it is inside a native call)");
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    // The run it was in is INVALID: recorded now, so the report lists it and a resume re-runs it once like any invalid run.
    if (beat.job) {
      const rowsFile = path.join(out, "rows.json");
      /** @type {any[]} */ let rows = []; try { rows = JSON.parse(fs.readFileSync(rowsFile, "utf8")); } catch { /* none yet */ }
      rows.push({ ...endedRow({ name: beat.job.name, rep: beat.job.rep, n: beat.job.n, why: `stalled: the harness stopped beating for ${Math.round(age / 1000)} s in "${beat.phase}" and was ended`, sha: beat.sha || "", ms: age }), retryOf: null });
      fs.writeFileSync(rowsFile, JSON.stringify(rows, null, 1));
      console.error(`run ${beat.job.n} (${beat.job.name}, rep ${beat.job.rep}) is recorded as INVALID in ${rowsFile}. To carry on from it: the same command with --again --out ${out}`);
    }
  }, 15_000);
  child.on("exit", (code, sig) => { clearInterval(watch); process.exit(sig ? 3 : (code ?? 1)); });
} else {
  const { prereg, heldout, seal, sealed } = loadSealed();
  const msgs = prereg.evalB.messages;
  const bad = lint(msgs, msgs.map((/** @type {any} */ m, /** @type {number} */ i) => ({ m, i })).filter((/** @type {any} */ o) => o.m.kind === "question").map((/** @type {any} */ o) => ({ index: o.i, answers: o.m.answers.filter((/** @type {string} */ a) => !a.startsWith("{")) })));
  const tasks = prereg.evalA.tasks.length + heldout.tasks.length, cells = prereg.evalA.cells.length;
  const aRuns = tasks * cells * prereg.reps, bRuns = prereg.evalB.arms.length * prereg.reps;
  console.log(`Eval A: ${prereg.evalA.tasks.length} tasks + ${heldout.tasks.length} held-out, ${cells} cells (${prereg.evalA.cells.map((/** @type {any} */ c) => c.id).join(", ")}), ${prereg.reps} reps = ${aRuns} runs`);
  console.log(`Eval B: ${prereg.evalB.arms.length} arms (${prereg.evalB.arms.map((/** @type {any} */ a) => a.id).join(", ")}), ${prereg.reps} reps = ${bRuns} runs of ${msgs.length} messages, roll after ${prereg.evalB.rollAfter}`);
  console.log(`model pinned: ${prereg.model}; order seed ${prereg.orderSeed}; seal ${seal.slice(0, 16)} ${sealed === seal ? "(sealed)" : sealed ? "(DIFFERS from PREREG.sha256)" : "(not sealed yet)"}`);
  console.log(`lint of the scripted conversation: ${bad.length ? bad.join("; ") : "clean (no question carries an answer)"}`);
  // Round 4 and 5 prices: a Vyre task $0.06 to $0.37 (about $0.15 mean), a plain task about the same or less; a long B conversation about $0.5 to $0.9.
  const estA = Math.round(aRuns / cells * (0.15 + 0.12 + 0.10) * 100) / 100, estB = Math.round(bRuns * 0.7 * 100) / 100;
  console.log(`Estimate (round 4 and 5 prices, check before a go): Eval A about $${estA}, Eval B about $${estB}, together about $${Math.round((estA + estB) * 100) / 100}. The runner stops at --max-usd.`);
  const p = plan({ orderSeed: prereg.orderSeed, reps: 1 }, prereg.evalB.arms);
  console.log(`Order of the first Eval B block (a seeded shuffle, one block per rep): ${p.map((x) => x.cell.id).join(", ")}`);
}
