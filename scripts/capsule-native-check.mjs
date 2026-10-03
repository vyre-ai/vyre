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
  // At least 200 keystrokes of real words, in the app as it runs (the release build, no profiler, no forced
  // layout). Each key is timed to the end of its turn (first rows painted) and to its last rows landing.
  const words = ["safari", "system settings", "12 * (3 + 4)", "notes", "20 km in miles", "terminal", "a", "mail", "calendar", "messages", "music",
    "photos", "preview", "reminders", "finder", "shortcuts", "activity monitor", "keychain", "clock", "weather", "dictionary", "maps", "books",
    "podcasts", "stocks", "freeform", "console", "app store", "screenshot", "voice memos", "text edit"];
  const typeRun = async list => {
    const out = [];
    let seen = (await send({ timings: true })).count;
    for (const w of list) {
      await send({ text: "" }); await pause(60);
      for (let i = 1; i <= w.length; i++) {
        await send({ text: w.slice(0, i) });
        const r = await send({ timings: true, since: seen });
        seen = r.count;
        const e = r.timings.find(x => x.kind === "results");
        if (e) out.push(e);
        await pause(40);
      }
    }
    return out;
  };
  const keyDetail = await typeRun(words);
  const keyMs = keyDetail.map(k => k.ms).filter(x => x >= 0);
  // What the person feels: the first rows (local: apps, commands, recents) against 50 ms; the rest (Spotlight, mail,
  // files) may append after, and is reported apart.
  const firstMs = keyDetail.map(k => k.first).filter(x => typeof x === "number" && x >= 0);
  await pause(800);                                   // let the slow sources land before reading when they did
  const all = (await send({ timings: true, since: 0 })).timings.filter(x => x.kind === "results");
  const allMs = all.map(x => x.all).filter(x => typeof x === "number");
  console.log(`typing run: ${keyDetail.length} keystrokes`);
  if (firstMs.length) {
    console.log(`key to first rows: ${firstMs.length} keystrokes, median ${pct(firstMs, 0.5).toFixed(1)} ms, 95th ${pct(firstMs, 0.95).toFixed(1)} ms, worst ${Math.max(...firstMs).toFixed(1)} ms`);
    budget(pct(firstMs, 0.95) < 50, "key to first rows 95th percentile under 50 ms");
  }
  if (allMs.length) console.log(`key to all rows (slow sources included): median ${pct(allMs, 0.5).toFixed(1)} ms, 95th ${pct(allMs, 0.95).toFixed(1)} ms, worst ${Math.max(...allMs).toFixed(1)} ms`);
  const slowest = [...keyDetail].sort((a, b) => b.ms - a.ms).slice(0, 8);
  console.log(`slowest keystrokes: ${slowest.map(k => `"${k.text}" ${k.ms.toFixed(0)} ms (set ${Number(k.set).toFixed(0)}, first ${Number(k.first).toFixed(0)})`).join(" · ")}`);
  // Over the goal: profile a second run, and say what the main thread was doing (macOS `sample`, every 10 ms).
  if (firstMs.length && pct(firstMs, 0.95) >= 50) {
    const sampler = spawn("/usr/bin/sample", [String(child.pid), "8", "10", "-mayDie"], { stdio: ["ignore", "pipe", "pipe"] });
    let sampled = "", sampleErr = ""; sampler.stdout.on("data", d => { sampled += d; }); sampler.stderr.on("data", d => { sampleErr += d; });
    await pause(400);
    await typeRun(words.slice(0, 10));
    await new Promise(r => { if (sampler.exitCode !== null) r(); else { sampler.on("exit", r); setTimeout(r, 75_000); } });
    const graph = sampled.split("Call graph:")[1] || "";
    const main = graph.split(/\n\s*\d+ Thread_/)[1] || "";
    const heavy = main.split("\n").filter(l => { const m = l.match(/^[\s+!:|]*(\d+)\s/); return m && Number(m[1]) >= 6 && !/mach_msg|__CFRunLoopRun|nextEventMatching|RunCurrentEventLoop|ReceiveNextEvent|_DPSNextEvent|_BlockUntil/.test(l); }).slice(0, 60);
    console.log(heavy.length ? `main thread while typing, busy frames (samples of 10 ms):\n${heavy.map(l => l.replace(/\s+/g, " ").slice(0, 200)).join("\n")}` : `sampler: no busy frames found (${sampled.length} bytes)`);
  }
  // Wake: hide and show ten times, timing each show.
  const wake = [];
  for (let i = 0; i < 10; i++) {
    await send({ hide: true }); await pause(200);
    const n = (await send({ timings: true })).timings.length;
    await send({ show: true }); await pause(150);
    const o = (await send({ timings: true })).timings.slice(n).find(x => x.kind === "open");
    if (o) wake.push(o.ms);
  }
  // Real key events through the panel: "@" typed as the keyboards type it. Nothing typed may be swallowed (#30: "@" did nothing).
  try {
    await send({ show: true }); await send({ text: "" }); await pause(300);
    const layouts = [
      { name: "US, Shift-2", stroke: { chars: "@", ignoring: "2", code: 19, shift: true } },
      { name: "German Mac, Option-L", stroke: { chars: "@", ignoring: "l", code: 37, option: true } },
      { name: "German PC, AltGr-Q", stroke: { chars: "@", ignoring: "q", code: 12, option: true, control: true } },
    ];
    for (const l of layouts) {
      await send({ text: "" }); await pause(150);
      const r = await send({ strokes: [l.stroke, { chars: "a", code: 0 }] });
      await pause(500);
      const p = await send({ probe: true });
      console.log(`@ ${l.name}: key window ${r.key}, box ${JSON.stringify(p.text)}`);
      check(p.text === "@a", `typing @ then a gives "@a" (${l.name}, got ${JSON.stringify(p.text)})`);
    }
    // The list is empty here (offline, nothing to name): the character must still be in the box, alone.
    await send({ text: "" }); await pause(150);
    await send({ strokes: [{ chars: "@", ignoring: "2", code: 19, shift: true }] }); await pause(600);
    const alone = await send({ probe: true });
    console.log(`@ alone, nothing to list: box ${JSON.stringify(alone.text)}, rows ${alone.rows.length}`);
    check(alone.text === "@", `typing @ with nothing to list leaves "@" in the box (got ${JSON.stringify(alone.text)})`);
    await send({ text: "" });
  } catch (e) { console.log(`@ check failed to run: ${String(e && e.message || e).split("\n")[0]}`); failures.push("the @ key check did not run"); }
  // A real screen picture, if asked for: the panel shown with a word typed, captured by macOS itself.
  if (process.env.VYRE_CAPSULE_SCREENS) {
    fs.mkdirSync(process.env.VYRE_CAPSULE_SCREENS, { recursive: true });
    try {
      await send({ show: true }); await send({ text: "safari" }); await pause(900);
      const f = path.join(process.env.VYRE_CAPSULE_SCREENS, "screen-typing-safari.png");
      // The app's own window, not the whole runner screen.
      const w = await send({ windowid: true });
      execFileSync("/usr/sbin/screencapture", w.windowid > 0 ? ["-x", "-o", "-l", String(w.windowid), f] : ["-x", f], { timeout: 20_000 });
      console.log(`screen capture: ${fs.statSync(f).size} bytes at ${f}`);
      await send({ text: "" });
    } catch (e) { console.log(`screen capture failed: ${String(e && e.message || e).split("\n")[0]}`); }
  }
  // Deep glass, on the built app: the panel shown over a window that is white on the left half of the screen and black on
  // the right, captured by macOS itself. With the glass on, the panel's left half is brighter than its right half. With
  // Reduce Transparency forced on, the ground is the opaque tint and the two halves match.
  try {
    const probe = path.join(home, "glassprobe");
    execFileSync("swiftc", ["-O", "-o", probe, path.join(path.dirname(new URL(import.meta.url).pathname), "mac-glass-probe.swift")], { timeout: 120_000, stdio: "inherit" });
    const rows = [];
    for (const look of ["dark", "light"]) {
      for (const display of ["glass", "reduced"]) {
        const bd = spawn(probe, ["backdrop", "split"], { stdio: ["ignore", "pipe", "inherit"] });
        await new Promise(res => { bd.stdout.once("data", () => res(0)); setTimeout(res, 8000); });
        try {
          await send({ appearance: look }); const d = await send({ display });
          await send({ show: true }); await send({ text: "zzzzqq" }); await pause(1200);
          const w = await send({ windowid: true });
          const dir = process.env.VYRE_CAPSULE_SCREENS || home; fs.mkdirSync(dir, { recursive: true });
          const f = path.join(dir, `glass-${look}-${display}.png`);
          execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(w.windowid), f], { timeout: 20_000 });
          const [wmean, wleft, wright] = execFileSync(probe, ["luma", f], { timeout: 20_000 }).toString().trim().split(/\s+/).map(Number);
          // The same panel as the screen shows it: the screen region under it, with the window server's blur composed in. A window
          // capture of the window alone may leave the behind-window blur out, so this is the one that counts.
          const fr = await send({ windowframe: true });
          const g = path.join(dir, `glass-${look}-${display}-screen.png`);
          execFileSync("/usr/sbin/screencapture", ["-x", "-R", `${Math.round(fr.x)},${Math.round(fr.y)},${Math.round(fr.w)},${Math.round(fr.h)}`, g], { timeout: 20_000 });
          const [mean, left, right] = execFileSync(probe, ["luma", g], { timeout: 20_000 }).toString().trim().split(/\s+/).map(Number);
          rows.push({ look, display, mean, left, right, gap: left - right, sysReduced: d.systemReduced === true });
          console.log(`glass ${look} ${display}: screen mean ${mean} left ${left} right ${right} gap ${(left - right).toFixed(2)}; window-only mean ${wmean} left ${wleft} right ${wright} gap ${(wleft - wright).toFixed(2)}; system reduce transparency ${d.systemReduced}`);
        } finally { bd.kill("SIGTERM"); await pause(300); }
      }
    }
    await send({ display: "system" }); await send({ appearance: "system" }); await send({ text: "" });
    const get = (look, display) => rows.find(r => r.look === look && r.display === display);
    // GitHub's Mac runner has Reduce Transparency on, which switches macOS's blur off for every app: the glass cannot be measured
    // there (run 36957197608: the same gap with the glass on and with it forced off). Say so, and prove what can be proved: the
    // reduced ground is opaque in both looks. The blur itself is the user's check on a real Mac (docs/work/capsule-pro.md, step 16).
    if (rows.some(r => r.sysReduced)) {
      console.log("NOTE this Mac has Reduce Transparency on, so the glass blur cannot be measured here; only the opaque fallback is checked");
      for (const look of ["dark", "light"]) {
        const r = get(look, "reduced");
        if (r) check(Math.abs(r.gap) < 3, `${look} reduced transparency: an opaque ground, the two halves match (gap ${r.gap.toFixed(2)})`);
      }
    } else
    for (const look of ["dark", "light"]) {
      if (rows.some(x => x.sysReduced)) break;
      const g = get(look, "glass"), r = get(look, "reduced");
      if (g && r) {
        budget(Math.abs(r.gap) < 3, `${look} reduced transparency: the two halves match (gap ${r.gap.toFixed(2)})`);
        budget(Math.abs(g.gap) > Math.abs(r.gap) + 6, `${look} glass: the ground shows what is behind it (gap ${g.gap.toFixed(2)} against ${r.gap.toFixed(2)} reduced)`);
      }
    }
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Deep glass\n\n| look | ground | mean | left (white behind) | right (black behind) | gap |\n|---|---|---|---|---|---|\n${rows.map(r => `| ${r.look} | ${r.display} | ${r.mean} | ${r.left} | ${r.right} | ${r.gap.toFixed(2)} |`).join("\n")}\n`);
  } catch (e) { console.log(`glass proof failed: ${String(e && e.message || e).split("\n")[0]}`); failures.push("the Deep glass proof did not run"); }
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
