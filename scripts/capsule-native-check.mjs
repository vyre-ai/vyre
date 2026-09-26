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
// docs/work/capsule-pro.md: hidden under 60 MB resident and under 0.1% CPU, wake under 50 ms.
// Exits 1 when a check fails; the numbers are printed either way.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";

const app = path.resolve(process.argv[2] || "local/capsule/native/.build/Vyre.app");
const bin = path.join(app, "Contents", "MacOS", "Vyre");
if (!fs.existsSync(bin)) { console.error(`no app at ${app}`); process.exit(1); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-capsule-check-"));
const BUDGET = { hiddenMB: 60, hiddenCpu: 0.1, openMs: 50 };

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

try {
  await new Promise((r, j) => { waiting.push(r); setTimeout(() => j(new Error("the app did not say ready")), 15_000); });
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
  check(open && open.ms < BUDGET.openMs, `open under ${BUDGET.openMs} ms`);
  await send({ hide: true });
  await pause(3000);
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const [rss, cpu] = execFileSync("ps", ["-o", "rss=,%cpu=", "-p", String(child.pid)]).toString().trim().split(/\s+/).map(Number);
    samples.push({ mb: rss / 1024, cpu });
    await pause(1000);
  }
  const mb = Math.max(...samples.map(s => s.mb)), cpu = samples.reduce((a, s) => a + s.cpu, 0) / samples.length;
  console.log(`hidden: ${mb.toFixed(1)} MB resident (max), ${cpu.toFixed(3)}% CPU (mean over 20 s)`);
  check(mb < BUDGET.hiddenMB, `hidden under ${BUDGET.hiddenMB} MB`);
  check(cpu < BUDGET.hiddenCpu, `hidden under ${BUDGET.hiddenCpu}% CPU`);
} catch (e) {
  failures.push(String(e && e.message || e)); console.log(`FAIL ${e && e.message || e}`);
} finally {
  child.kill("SIGTERM");
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failures.length ? 1 : 0);
