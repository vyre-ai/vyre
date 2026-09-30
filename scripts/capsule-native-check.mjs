#!/usr/bin/env node
// @ts-check
// capsule-native-check — the built native Capsule, driven and measured (CI, macOS only).
//
//   node scripts/capsule-native-check.mjs [path/to/Vyre.app]
//
// Starts the app's binary with VYRE_CAPSULE_DRIVE=1 in a throwaway VYRE_HOME with no vyred, so it
// is offline, and VYRE_CAPSULE_TEST=1, so it asks for nothing and posts nothing. It shows the panel
// (without taking the keyboard), types a sum, checks the row and the offline line, reads the open
// and keystroke timings, hides it, and samples its CPU and memory while hidden. Budgets, from
// docs/work/capsule-pro.md: hidden under 60 MB of memory and under 0.1% CPU, wake under 50 ms.
// "Memory" is phys_footprint, what Activity Monitor shows as Memory: the pages this process dirtied
// or had compressed, asked from inside the app (TASK_VM_INFO). Resident (ps RSS) is printed beside
// it and is larger: it also counts the clean, shared pages of AppKit and SwiftUI mapped into every
// app, which cost the Mac nothing extra. VYRE_CAPSULE_CHECK_DETAIL=1 also prints vmmap and heap.
// A broken behaviour fails the run (exit 1). A budget over its target is printed as OVER and does
// not fail it: the targets are capsule-pro's to meet, and these numbers are how they see them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";

const app = path.resolve(process.argv[2] || "local/capsule/native/.build/Vyre.app");
const bin = path.join(app, "Contents", "MacOS", "Vyre");
if (!fs.existsSync(bin)) { console.error(`no app at ${app}`); process.exit(1); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-capsule-check-"));
const BUDGET = { hiddenMB: 60, hiddenCpu: 0.1, openMs: 50, keyP95Ms: 16, wakeP95Ms: 50 };
// The whole check has four minutes; a hang anywhere fails it in words instead of eating the job.
const watchdog = setTimeout(() => { console.log("FAIL the check did not finish in 4 minutes"); try { child.kill("SIGKILL"); } catch {} process.exit(1); }, 240_000);
watchdog.unref();

const child = spawn(bin, [], { env: { ...process.env, VYRE_HOME: home, VYRE_SOCKET: path.join(home, "vyred.sock"), VYRE_CAPSULE_DRIVE: "1", VYRE_CAPSULE_TEST: "1" },
  stdio: ["pipe", "pipe", "inherit"] });
/** @type {((m: any) => void)[]} */
const waiting = [];
readline.createInterface({ input: /** @type {any} */ (child.stdout) }).on("line", l => {
  let m; try { m = JSON.parse(l); } catch { return; }
  const w = waiting.shift(); if (w) w(m);
});
const send = c => new Promise((r, j) => { waiting.push(r); child.stdin?.write(JSON.stringify(c) + "\n"); setTimeout(() => j(new Error(`no answer to ${JSON.stringify(c)}`)), 10_000); });
const pause = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const budget = (ok, what) => console.log(`${ok ? "ok  " : "OVER"} ${what}`);

const MB = b => b / 1048576;
const mem = async () => (await send({ memory: true })).memory;
const detail = process.env.VYRE_CAPSULE_CHECK_DETAIL === "1";
const tool = (cmd, args, keep) => {
  try {
    // heap and vmmap suspend the target to read it; on a busy runner that has taken minutes.
    const out = execFileSync(cmd, args, { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString().split("\n");
    console.log(`--- ${cmd} ${args.join(" ")}\n${(keep ? out.filter(keep) : out).slice(0, 120).join("\n")}`);
  } catch (e) { console.log(`--- ${cmd} failed: ${String(e && e.message || e).split("\n")[0]}`); }
};

try {
  await new Promise((r, j) => { waiting.push(r); setTimeout(() => j(new Error("the app did not say ready")), 15_000); });
  await pause(3000);
  const before = await mem();
  console.log(`never shown: ${MB(before.footprint).toFixed(1)} MB footprint, ${MB(before.resident).toFixed(1)} MB resident, ${MB(before.mallocInUse).toFixed(1)} MB malloc`);
  await send({ show: true });
  await pause(4000);                                    // vyred is looked for and not found
  await send({ text: "200 + 10%" });
  await pause(300);
  const p = await send({ probe: true });
  check(p.rows.some(r => r.kind === "calc" && r.title === "220"), `the sum is a row (${JSON.stringify(p.rows.map(r => r.title))})`);
  check(p.offline === true, "offline is said when vyred is not running");
  await send({ key: "escape" });
  const t = (await send({ timings: true })).timings;
  const open = t.find(x => x.kind === "open"), results = t.find(x => x.kind === "results");
  console.log(`open ${open && open.ms.toFixed(1)} ms · keystroke to rows ${results && results.ms.toFixed(1)} ms`);
  if (open && open.phases) console.log(`open phases (ms): ${Object.entries(open.phases).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`);
  budget(open && open.ms < BUDGET.openMs, `open under ${BUDGET.openMs} ms`);
  // Feel: type real words one letter at a time (apps, files and the calculator all answer), and time
  // each keystroke to its rows. A frame at 60 Hz is 16 ms, so the 95th percentile must fit in one.
  // The quick providers answer in the same frame; the slow ones land after and are not counted here.
  const pct = (xs, q) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN; };
  const words = ["safari", "system settings", "12 * (3 + 4)", "notes", "20 km in miles", "terminal", "a", "mail"];
  // A profile of the app while it types, so a stall names its own code (macOS `sample`, 1 ms).
  const sampler = spawn("/usr/bin/sample", [String(child.pid), "6", "10", "-mayDie"], { stdio: ["ignore", "pipe", "pipe"] });
  let sampled = "", sampleErr = ""; sampler.stdout.on("data", d => { sampled += d; }); sampler.stderr.on("data", d => { sampleErr += d; });
  await pause(300);
  const keyMs = [], keyDetail = [];
  for (const w of words) {
    await send({ text: "" }); await pause(60);
    for (let i = 1; i <= w.length; i++) {
      const before = (await send({ timings: true })).timings.length;
      await send({ text: w.slice(0, i) });
      const tm = (await send({ timings: true })).timings;
      const last = tm.slice(before).find(x => x.kind === "results");
      if (last) { keyMs.push(last.ms); keyDetail.push(last); }
      await pause(20);
    }
  }
  console.log(`typing: ${keyMs.length} keystrokes to rows, median ${pct(keyMs, 0.5).toFixed(1)} ms, 95th ${pct(keyMs, 0.95).toFixed(1)} ms, worst ${Math.max(...keyMs).toFixed(1)} ms`);
  // Which keystrokes were slowest, so a slow one can be traced to its words.
  await new Promise(r => { if (sampler.exitCode !== null) r(); else { sampler.on("exit", r); setTimeout(r, 75_000); } });
  // The heaviest frames of the main thread: lines of the call graph holding 100 or more of its samples.
  const graph = sampled.split("Call graph:")[1] || "";
  const main = graph.split(/\n\s*\d+ Thread_/)[0] || "";
  const heavy = main.split("\n").filter(l => { const m = l.match(/^[\s+!:|]*(\d+)\s/); return m && Number(m[1]) >= 6; }).slice(0, 60);
  if (!heavy.length) console.log(`sampler: ${sampled.length} bytes, call graph ${graph.length} bytes, exit ${sampler.exitCode}, stderr: ${sampleErr.slice(0, 300).replace(/\s+/g, " ")}, first lines: ${sampled.split("\n").slice(0, 6).join(" | ").slice(0, 300)}`);
  if (heavy.length) console.log(`main thread while typing (samples of 10 ms):\n${heavy.map(l => l.replace(/\s+/g, " ").slice(0, 200)).join("\n")}`);
  const slowest = [...keyDetail].sort((a, b) => b.ms - a.ms).slice(0, 6);
  console.log(`slowest keystrokes: ${slowest.map(k => `"${k.text}" ${k.ms.toFixed(0)} ms (set ${Number(k.set).toFixed(0)}, layout ${Number(k.layout).toFixed(0)})`).join(" · ")}`);
  budget(pct(keyMs, 0.95) < BUDGET.keyP95Ms, `keystroke to rows 95th percentile under ${BUDGET.keyP95Ms} ms (one frame)`);
  // Wake: hide and show ten times, timing each show.
  const wake = [];
  for (let i = 0; i < 10; i++) {
    await send({ hide: true }); await pause(200);
    const n = (await send({ timings: true })).timings.length;
    await send({ show: true }); await pause(150);
    const o = (await send({ timings: true })).timings.slice(n).find(x => x.kind === "open");
    if (o) wake.push(o.ms);
  }
  console.log(`wake: ${wake.length} shows, median ${pct(wake, 0.5).toFixed(1)} ms, 95th ${pct(wake, 0.95).toFixed(1)} ms`);
  budget(pct(wake, 0.95) < BUDGET.wakeP95Ms, `wake 95th percentile under ${BUDGET.wakeP95Ms} ms`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Capsule speed\n\n| | median | 95th |\n|---|---|---|\n| keystroke to rows (ms) | ${pct(keyMs, 0.5).toFixed(1)} | ${pct(keyMs, 0.95).toFixed(1)} |\n| wake (ms) | ${pct(wake, 0.5).toFixed(1)} | ${pct(wake, 0.95).toFixed(1)} |\n`);
  }
  await send({ text: "" });
  await send({ hide: true });
  await pause(3000);
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const [rss, cpu] = execFileSync("ps", ["-o", "rss=,%cpu=", "-p", String(child.pid)], { timeout: 10_000 }).toString().trim().split(/\s+/).map(Number);
    samples.push({ rss: rss / 1024, cpu });
    await pause(1000);
  }
  // Asked after the CPU samples, so the asking is not counted as hidden work.
  const m = await mem();
  const rss = Math.max(...samples.map(s => s.rss)), cpu = samples.reduce((a, s) => a + s.cpu, 0) / samples.length;
  const mb = MB(m.footprint);
  console.log(`hidden: ${mb.toFixed(1)} MB footprint, ${rss.toFixed(1)} MB resident (max), ${MB(m.mallocInUse).toFixed(1)} MB malloc in use, ` +
    `${MB(m.compressed).toFixed(1)} MB compressed, ${cpu.toFixed(3)}% CPU (mean over 20 s)`);
  budget(mb < BUDGET.hiddenMB, `hidden under ${BUDGET.hiddenMB} MB footprint`);
  budget(cpu < BUDGET.hiddenCpu, `hidden under ${BUDGET.hiddenCpu}% CPU`);
  if (detail) {
    const pid = String(child.pid);
    tool("footprint", [pid]);
    tool("vmmap", ["--summary", pid], l => !/^\s*$/.test(l));
    tool("heap", ["-sortBySize", pid], l => /^\s*(\d+)\s+\d+/.test(l) || /Zone|Process|All zones/.test(l));
  }
} catch (e) {
  failures.push(String(e && e.message || e)); console.log(`FAIL ${e && e.message || e}`);
} finally {
  child.kill("SIGTERM");
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failures.length ? 1 : 0);
