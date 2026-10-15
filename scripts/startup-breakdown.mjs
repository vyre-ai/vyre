#!/usr/bin/env node
// startup-breakdown: where vyred's startup memory goes, by cause. Starts a vyred on an empty temp home with the flags a box runs it with, samples its resident size every 20 ms, and ties each growth to the
// "module <name> <version> running" line that was printed in that window, so the table says which module's start took how many MB. Then it asks for a full collection (SIGUSR2, scripts/lib/gc-hook.mjs) and
// prints the settled numbers, so the peak (what perf-check budgets) and the floor (what stays) are told apart. Linux and macOS (reads `ps`). Run on a runner or a test machine, never on a person's Vyre home.
//   node scripts/startup-breakdown.mjs [--seconds 12] [--top 20]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : Number(process.argv[i + 1]); };
const SECONDS = arg("--seconds", 12), TOP = arg("--top", 20);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rssMB = pid => { try { return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024; } catch { return null; } };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-breakdown-"));
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ recall: { vectors: false }, memory: { model: { on: false } } }));
const gcFile = path.join(home, "gc.json");
const gcHook = new URL("file://" + path.join(HERE, "lib", "gc-hook.mjs")).href;
const child = spawn(process.execPath, ["--expose-gc", "--max-semi-space-size=5", `--import=${gcHook}`, path.join(REPO, "core", "daemon", "main.js")], {
  cwd: REPO, env: { MALLOC_ARENA_MAX: "2", ...process.env, VYRE_HOME: home, VYRE_PERF_GC_FILE: gcFile, VYRE_NO_DIALOGS: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
const t0 = Date.now();
/** @type {{ t: number, name: string }[]} */ const marks = [];
let buf = "";
const onData = d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = /^module (\S+) \S+ running/.exec(line); if (m) marks.push({ t: Date.now() - t0, name: m[1] }); } };
child.stdout.on("data", onData); child.stderr.on("data", onData);
/** @type {{ t: number, mb: number }[]} */ const samples = [];
while (Date.now() - t0 < SECONDS * 1000) { const mb = rssMB(child.pid); if (mb !== null) samples.push({ t: Date.now() - t0, mb }); await sleep(20); }
const peak = samples.reduce((a, s) => Math.max(a, s.mb), 0);
let settled = null;
try { process.kill(child.pid, "SIGUSR2"); } catch { /* gone */ }
for (let i = 0; i < 50 && !settled; i++) { await sleep(100); try { settled = JSON.parse(fs.readFileSync(gcFile, "utf8")); } catch { /* not yet */ } }
child.kill("SIGTERM");

// attribute: the growth between one module line and the next goes to the module that just started
const at = t => { let best = samples[0]; for (const s of samples) { if (s.t <= t) best = s; else break; } return best ? best.mb : 0; };
const rows = marks.map((m, i) => ({ name: m.name, t: m.t, grew: at(i + 1 < marks.length ? marks[i + 1].t : m.t + 50) - at(m.t) }));
const base = samples.length ? samples[0].mb : 0;
console.log(`startup RSS: first sample ${base.toFixed(1)} MB, peak ${peak.toFixed(1)} MB over ${SECONDS} s, ${marks.length} modules started`);
if (settled) console.log(`after a full collection: rss ${settled.rss} MB, heap used ${settled.heapUsed} MB, heap total ${settled.heapTotal} MB, external ${settled.external} MB, array buffers ${settled.arrayBuffers} MB`);
console.log(`\nthe ${TOP} modules whose start grew the process most (MB, at ms):`);
for (const r of rows.sort((a, b) => b.grew - a.grew).slice(0, TOP)) console.log(`  ${r.grew.toFixed(1).padStart(6)}  ${r.name.padEnd(22)} at ${r.t} ms`);
const first = marks[0], last = marks[marks.length - 1];
if (first && last) console.log(`\nbefore the first module line (runtime, the kernel, the store): ${at(first.t).toFixed(1)} MB; all module starts together: ${(at(last.t) - at(first.t)).toFixed(1)} MB; after the last module line to the peak: ${(peak - at(last.t)).toFixed(1)} MB`);
fs.rmSync(home, { recursive: true, force: true });
