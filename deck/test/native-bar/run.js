// @ts-check
// The native bar harness: measures the budgets in docs/design/native-bar.md against the Deck of any
// Vyre tree, in one headless Chrome, and prints one JSON line per budget
// ({id, metric, value, budget, pass, detail}) and then a markdown table for the Results section.
// It is a measuring tool: it always exits 0. A budget it cannot measure on a tree says "n/a" and why.
//
//   node deck/test/native-bar/run.js --tree <path> [--only 1,4,8] [--port 4791] [--label name]
//
// Runs on testbox only (docs/design/native-bar.md, "Where it runs"): it waits while the load
// average is 8 or more, starts the world (native-bar/world.js: temp home, the tree's own vyred,
// the fake claude and fake tailscale, VYRE_NO_DIALOGS=1) and one chrome-headless-shell under
// `nice -n 15`, and stops both when done. CDP=<url> uses a Chrome that is already running instead;
// CHROME=<path> names the binary (default: ~/vyre-ci/pwa-chrome's). A test helper, not part of the product.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "../cdp.js";
import { PAGE_SCRIPT } from "./page.js";
import { p95, percentile, streamGate, frameStats, thresholdP95 } from "./stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string|null} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const TREE = path.resolve(arg("--tree", path.resolve(HERE, "..", "..", "..")) || ".");
const PORT = Number(arg("--port", "4791"));
const LABEL = arg("--label", path.basename(TREE)) || "tree";
const ONLY = (arg("--only", "") || "").split(",").map(s => s.trim()).filter(Boolean);
const want = (/** @type {string} */ id) => !ONLY.length || ONLY.includes(id) || ONLY.includes(id.split(".")[0]);
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const log = (/** @type {string} */ s) => process.stderr.write(`native-bar: ${s}\n`);

/** @type {{ id: string, metric: string, value: any, budget: string, pass: boolean|null, detail?: string }[]} */
const results = [];
function report(/** @type {string} */ id, /** @type {string} */ metric, /** @type {any} */ value, /** @type {string} */ budget, /** @type {boolean|null} */ pass, detail = "") {
  const r = { id, metric, value: typeof value === "number" ? Math.round(value * 100) / 100 : value, budget, pass, ...(detail ? { detail } : {}) };
  results.push(r);
  process.stdout.write(JSON.stringify(r) + "\n");
}
const na = (/** @type {string} */ id, /** @type {string} */ metric, /** @type {string} */ budget, /** @type {string} */ why) => report(id, metric, "n/a", budget, null, why);

// ---- the load gate ---------------------------------------------------------------------------------

for (let waited = 0; os.loadavg()[0] >= 8; waited += 30) {
  if (waited >= 900) { log(`load ${os.loadavg()[0].toFixed(1)} after 15 minutes; giving up`); process.exit(0); }
  log(`load ${os.loadavg()[0].toFixed(1)} is 8 or more; waiting`);
  await sleep(30_000);
}

// ---- the world and Chrome ------------------------------------------------------------------------------

/** @type {import("node:child_process").ChildProcess[]} */
const started = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "native-bar-chrome-"));
async function stopAll() {
  for (const p of started.reverse()) {
    if (p.exitCode != null || p.signalCode != null) continue;
    const gone = new Promise(r => p.once("exit", r));
    try { p.kill("SIGTERM"); } catch {}
    await Promise.race([gone, sleep(6000)]);
    if (p.exitCode == null && p.signalCode == null) try { p.kill("SIGKILL"); } catch {}
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}
process.on("SIGINT", () => { stopAll().then(() => process.exit(0)); });
process.on("SIGTERM", () => { stopAll().then(() => process.exit(0)); });

const worldProc = spawn("nice", ["-n", "15", process.execPath, path.join(HERE, "world.js"), "--tree", TREE, "--port", String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
started.push(worldProc);
/** @type {{ url: string, s40: string, s2000: string, cwd: string }} */
const world = await new Promise((resolve, reject) => {
  let buf = "";
  worldProc.stdout?.on("data", d => { buf += d; const l = buf.split("\n").find(x => x.startsWith("{")); if (l) resolve(JSON.parse(l)); });
  worldProc.once("exit", c => reject(new Error(`world exited ${c}`)));
  setTimeout(() => reject(new Error("world did not come up in 120 s")), 120_000);
});
log(`world ${world.url} for ${TREE}`);

let CDP = process.env.CDP || "";
if (!CDP) {
  const bin = process.env.CHROME || path.join(os.homedir(), "vyre-ci/pwa-chrome/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell");
  const cdpPort = 9431 + Math.floor(Math.random() * 400);
  const chrome = spawn("nice", ["-n", "15", bin, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${scratch}`,
    "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--window-size=1280,860", "about:blank"], { stdio: "ignore" });
  started.push(chrome);
  CDP = `http://127.0.0.1:${cdpPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }
}

const tool = async (/** @type {string} */ name, /** @type {any} */ input) => {
  const r = await fetch(`${world.url}/v1/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck" }, body: JSON.stringify(input) });
  return r.json();
};

const tab = await openTab(CDP, { width: 1280, height: 860, scale: 1, mobile: false });
await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SCRIPT });
await tab.send("Network.enable");
await tab.send("Performance.enable");
const B = (/** @type {string} */ expr) => tab.run(`const B = window.__bar; ${expr}`);
const key = async (/** @type {string} */ k, /** @type {{ text?: string, code?: string, vk?: number }} */ o = {}) => {
  await tab.send("Input.dispatchKeyEvent", { type: o.text ? "keyDown" : "rawKeyDown", key: k, code: o.code, text: o.text, unmodifiedText: o.text, windowsVirtualKeyCode: o.vk });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: o.code, windowsVirtualKeyCode: o.vk });
};
const openSession = async (/** @type {string} */ id) => {
  await tab.go(`${world.url}/chat/thread/${encodeURIComponent(id)}`, 300);
  for (let i = 0; i < 100; i++) { if (await B("return !!B && !!B.timeline() && B.rows().length > 0;").catch(() => false)) break; await sleep(150); }
  await sleep(800);
};
const composerSel = ".composer textarea";
/** Scroll the timeline up by px with real wheel input, as a reader would (a view may ignore a scrollTop set by script). */
const wheelUp = async (/** @type {number} */ px) => {
  const r = await B(`return B.timeline().getBoundingClientRect().toJSON();`);
  const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  const before = await B(`return B.timeline().scrollTop;`);
  let reached = 0;
  for (let left = px; left > 0; left -= 100) {
    await tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: -Math.min(100, left) });
    await sleep(16);
    reached = Math.max(reached, before - (await B(`return B.timeline().scrollTop;`)));
  }
  await sleep(250);
  return { reached: Math.round(reached), kept: Math.round(before - (await B(`return B.timeline().scrollTop;`))) };
};

// ---- 1: keystroke to paint ---------------------------------------------------------------------------------

async function keystrokes(/** @type {string} */ id, /** @type {string} */ label) {
  const BP = "p95 processing < 16 ms", BD = "p95 duration to next paint < 33 ms";
  const has = await B(`return !!document.querySelector(${JSON.stringify(composerSel)});`);
  if (!has) { na(id + ".proc", `keystroke processing, ${label}`, BP, `no composer textarea (${composerSel}) in this tree's session view`);
    return na(id + ".paint", `keystroke to next paint, ${label}`, BD, `no composer textarea (${composerSel}) in this tree's session view`); }
  if (!(await B(`return B.evtOk;`))) { na(id + ".proc", `keystroke processing, ${label}`, BP, "this Chrome has no Event Timing API (PerformanceObserver type event)");
    return na(id + ".paint", `keystroke to next paint, ${label}`, BD, "this Chrome has no Event Timing API"); }
  await B(`const ta = document.querySelector(${JSON.stringify(composerSel)}); ta.focus(); B.keys = []; B.keyOn = true; B.ltFrom = performance.now(); B.evtFrom = B.evt.length; return true;`);
  const text = "Northwind Bakery adds a pumpkin loaf at 5.50 and kit reviews the copy before alex sends it. ".repeat(3).slice(0, 200);
  for (const c of text) { await key(c, { text: c }); await sleep(30); }
  await sleep(600);
  const r = await B(`B.keyOn = false; const lt = B.longtasks.filter(t => t.start >= B.ltFrom); const ta = document.querySelector(${JSON.stringify(composerSel)});
    const typed = ta.value.length;
    const evt = B.evt.slice(B.evtFrom).filter(e => e.start >= B.ltFrom);
    ta.value = ""; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.blur();
    return { keys: B.keys, long: lt.map(t => t.duration), typed, evt };`);
  const worst = r.long.length ? Math.max(...r.long) : 0;
  const longOk = worst <= 50;
  const longNote = `long tasks while typing: ${r.long.length}${r.long.length ? ` (worst ${Math.round(worst)} ms)` : ""}`;
  // The keydown and input entries of every key: 2 per key typed. Chrome leaves out any under 16 ms,
  // so the p95 is exact when over 5 % were reported and "under 16" otherwise (stats.js thresholdP95).
  const kd = r.evt.filter((/** @type {any} */ e) => e.name === "keydown" || e.name === "input");
  const total = 2 * text.length;
  const byName = (/** @type {string} */ n) => kd.filter((/** @type {any} */ e) => e.name === n).length;
  const counts = `${byName("keydown")} keydown and ${byName("input")} input entries of ${total} were 16 ms or more (the API reports no shorter ones, and rounds durations to 8 ms)`;
  const proc = thresholdP95(kd.map((/** @type {any} */ e) => e.proc), total, 16);
  const dur = thresholdP95(kd.map((/** @type {any} */ e) => e.duration), total, 16);
  const show = (/** @type {{ value: number|null, under: boolean }} */ x) => (x.under ? "< 16" : x.value ?? "n/a");
  const procPass = proc.under || (proc.value != null && proc.value < 16);
  const durPass = dur.under || (dur.value != null && dur.value < 33);
  const worstProc = kd.length ? Math.max(...kd.map((/** @type {any} */ e) => e.proc)) : 0;
  report(id + ".proc", `keystroke processing p95 (ms), ${label}`, show(proc), `${BP}, no long task > 50 ms`, procPass && longOk,
    `${counts}; worst processing ${Math.round(worstProc)} ms; ${longNote}`);
  report(id + ".paint", `keystroke to next paint p95 (ms), ${label}`, show(dur), `${BD}, no long task > 50 ms`, durPass && longOk,
    `Event Timing duration, keydown and input; rAF method for comparison: p95 ${Math.round((p95(r.keys) || 0) * 10) / 10} ms, median ${Math.round((percentile(r.keys, 50) || 0) * 10) / 10} ms; ${r.typed} chars landed; ${longNote}`);
}

// ---- 6: fling through the long transcript ----------------------------------------------------------------

async function loadAll() {
  for (let i = 0; i < 12; i++) {
    const clicked = await B(`const b = document.querySelector(".cv-earlier:not([hidden]) button"); if (!b) return false; b.click(); return true;`);
    if (!clicked) break;
    await sleep(1500);
  }
  return B(`return B.rows().length;`);
}

async function fling() {
  const rows = await loadAll();
  const g = await B(`const tl = B.timeline(); tl.scrollTop = tl.scrollHeight; return { h: tl.scrollHeight, c: tl.clientHeight, r: tl.getBoundingClientRect().toJSON() };`);
  await sleep(500);
  const dist = Math.max(0, g.h - g.c);
  const speed = Math.max(8000, Math.round(dist / 25));
  await B(`B.stamps = []; B.flinging = true; const tick = t => { if (!B.flinging) return; B.stamps.push(t); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true;`);
  const x = Math.round(g.r.x + g.r.width / 2), y = Math.round(g.r.y + g.r.height / 2);
  await tab.send("Input.synthesizeScrollGesture", { x, y, yDistance: dist, speed, gestureSourceType: "mouse", repeatCount: 0 });
  await sleep(300);
  const r = await B(`B.flinging = false; const tl = B.timeline(); return { stamps: B.stamps, top: tl.scrollTop, h: tl.scrollHeight, rows: B.rows().length };`);
  const f = frameStats(r.stamps);
  const pass = f.p95 != null && f.p95 < 16.7 * 1.05 && r.top < dist * 0.5;
  report("6", "fling p95 frame time (ms)", f.p95 ?? "n/a", "p95 frame < 16.7 ms (60 fps) through 2,000 rows", f.p95 == null ? null : pass,
    `${f.frames} frames, ${f.dropped} dropped, worst ${Math.round(f.max || 0)} ms; ${rows} rows in the DOM after Load earlier (${r.rows} after the fling; a windowed view mounts only what is near the viewport), scrolled ${Math.round(dist - r.top)} of ${dist} px at ${speed} px/s`);
  await B(`const tl = B.timeline(); tl.scrollTop = tl.scrollHeight; return true;`);
  await sleep(600);
}

// ---- 7: open a session ------------------------------------------------------------------------------------

async function openBudget() {
  await tab.go(`${world.url}/chat/thread/${encodeURIComponent(world.s40)}`, 300);
  let cold = null;
  for (let i = 0; i < 100 && cold == null; i++) { cold = await B("return B ? B.opened : null;").catch(() => null); if (cold == null) await sleep(150); }
  report("7.cold", "open a session cold, nav start to 20 rows (ms)", cold ?? "n/a", "< 1000 ms", cold == null ? null : cold < 1000,
    "full page load of /chat/thread/<40-row session>, the Deck's code included");
  await sleep(1500);
  // From cache: back to the list, then the same session again, in the app.
  const back = await B(`const b = document.querySelector(".session-back"); if (!b) return false; b.click(); return true;`);
  if (!back) { na("7.cache", "open a session from cache (ms)", "< 300 ms", "no Back control (.session-back) in the session view"); return; }
  await sleep(1500);
  const stays = await B(`return [...document.querySelectorAll(".thread-view")].filter(x => !x.closest(".away") && x.getBoundingClientRect().height > 0).length;`);
  const ms = await B(`
    const a = [...document.querySelectorAll('a[href*="${world.s40}"]')].find(x => !x.closest(".away") && x.getBoundingClientRect().height > 0);
    if (!a) return null;
    const t0 = performance.now();
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return await new Promise(res => { const tick = () => { const tl = document.querySelector(".thread-view:not(.away .thread-view)");
      const n = tl ? [...tl.querySelectorAll(".cv-row, .msg")].length : 0;
      if (n >= 20) res(performance.now() - t0); else if (performance.now() - t0 > 8000) res(-1); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });`);
  if (ms == null) { na("7.cache", "open a session from cache (ms)", "< 300 ms", "the session list shows no link to the seeded 40-row session"); return; }
  report("7.cache", "open a session again, click to 20 rows (ms)", ms < 0 ? "timeout" : ms, "< 300 ms", ms >= 0 && ms < 300, `Back to the list, then the same session, in the app${stays ? "; the session view stayed on screen after Back, so this may time a view that never left" : "; the view had left the screen"}`);
}

// ---- 11: idle ---------------------------------------------------------------------------------------------

async function idle() {
  await openSession(world.s40);
  await sleep(3000);
  const m0 = await tab.send("Performance.getMetrics");
  await B(`B.timerWatch = true; B.idleFrom = performance.now(); return true;`);
  await sleep(15_000);
  const m1 = await tab.send("Performance.getMetrics");
  const r = await B(`B.timerWatch = false; return { timers: B.timers.map(t => ({ kind: t.kind, ms: t.ms, t: t.t, src: t.src })), from: B.idleFrom };`);
  const td = (/** @type {any} */ m) => (m.result?.metrics || []).find((/** @type {any} */ x) => x.name === "TaskDuration")?.value || 0;
  const cpu = ((td(m1) - td(m0)) / 15) * 100;
  const intervals = r.timers.filter((/** @type {any} */ t) => t.kind === "interval" && t.ms < 60_000);
  const byKey = new Map();
  for (const t of r.timers.filter((/** @type {any} */ t) => t.kind === "timeout" && t.t >= r.from && t.ms > 0 && t.ms < 60_000)) {
    const k = t.ms + " " + t.src; byKey.set(k, (byKey.get(k) || 0) + 1);
  }
  const repeating = [...byKey].filter(([, n]) => n >= 2).map(([k, n]) => ({ ms: Number(k.split(" ")[0]), n, src: k.slice(k.indexOf(" ") + 1, k.indexOf(" ") + 50) }));
  const fastest = Math.min(...intervals.map((/** @type {any} */ t) => t.ms), ...repeating.map(t => t.ms));
  const pass = !intervals.length && !repeating.length;
  report("11", "fastest repeating timer while idle (ms)", Number.isFinite(fastest) ? fastest : "none", "no timer faster than 60 s", pass,
    `visible idle CPU ${cpu.toFixed(1)} % over 15 s; setInterval < 60 s: ${intervals.map((/** @type {any} */ t) => `${t.ms} ms (${t.src.replace(/\s+/g, " ").slice(0, 40)})`).join("; ") || "none"}; `
    + `re-armed setTimeout < 60 s: ${repeating.map(t => `${t.ms} ms x${t.n} (${t.src.replace(/\s+/g, " ").slice(0, 40)})`).join("; ") || "none"}; hidden CPU: n/a (a headless page cannot be hidden; use scripts/perf-check)`);
}

// ---- the streaming thread: 2, 3, 4, 5, 8, 9, 10 -----------------------------------------------------------------

async function startThread() {
  const r = await tool("threads.start", { cwd: world.cwd, prompt: "hello", name: "Northwind burst", surface: "deck" });
  if (!r.data) throw new Error("threads.start: " + JSON.stringify(r.error || r));
  const id = r.data.id;
  for (let i = 0; i < 100; i++) {
    const g = await tool("threads.get", { thread: id, limit: 1 });
    if (g.data && g.data.thread.turns >= 1 && g.data.thread.status === "idle") break;
    await sleep(200);
  }
  return id;
}

/** Sync the page clock to the server's with one round trip: server minus page, in ms. */
async function clockOffset() {
  return B(`const t0 = performance.now(); const r = await (await fetch("/__bar/now")).json(); const t1 = performance.now(); return r.now - B.epoch((t0 + t1) / 2);`);
}

async function waitEvent(/** @type {string} */ thread, /** @type {string} */ type, /** @type {number} */ from, ms = 30_000) {
  for (let t = 0; t < ms; t += 200) {
    const hit = await B(`return B.events.slice(${from}).find(e => e.thread === ${JSON.stringify(thread)} && e.type === ${JSON.stringify(type)}) || null;`);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}
const firstText = (/** @type {string} */ thread, /** @type {number} */ from) => B(`return B.events.slice(${from}).find(e => e.thread === ${JSON.stringify(thread)} && e.type === "thread.text" && e.len > 0) || null;`);

async function burst(/** @type {string} */ thread, /** @type {number} */ seed) {
  const from = await B(`return B.events.length;`);
  await B(`B.startSampler(${JSON.stringify(`[bar-${seed}]`)}); B.shiftFrom = performance.now(); return true;`);
  const s = await tool("threads.send", { thread, text: `burst ${seed}`, surface: "deck" });
  if (!s.data || s.data.sent === false) throw new Error("threads.send: " + JSON.stringify(s));
  for (let i = 0; i < 100 && !(await firstText(thread, from)); i++) await sleep(50);
  return from;
}

async function streamBudgets(/** @type {string} */ thread) {
  const offset = await clockOffset();
  const from = await burst(thread, 11);
  const fin = await waitEvent(thread, "thread.finished", from);
  await sleep(1500);
  const r = await B(`const S = B.sampler; S.stop = true;
    const ev = B.events.slice(${from}).filter(e => e.thread === ${JSON.stringify(thread)});
    return { samples: S.samples, firstPaint: S.firstPaint, ev };`);
  const texts = r.ev.filter((/** @type {any} */ e) => e.type === "thread.text" && e.len > 0);
  const first = texts[0];
  const fake = (await (await fetch(`${world.url}/__bar/log`)).json()).find((/** @type {any} */ l) => l.seed === 11);
  if (want("2")) {
    if (!first || r.firstPaint == null) na("2", "first streamed token painted (ms)", "< 100 ms after the SSE event", !first ? "no thread.text arrived" : "the live row never painted text");
    else report("2", "first token, SSE arrival to paint (ms)", r.firstPaint - first.arrive, "< 100 ms after the SSE event", r.firstPaint - first.arrive < 100);
  }
  if (want("3")) {
    if (!first || r.firstPaint == null || !fake) na("3", "box to screen, first token (ms)", "< 250 ms", "no first delta logged by the fake claude, or nothing painted");
    else {
      const paintServer = r.firstPaint + 0; // page ms
      const paintEpoch = await B(`return B.epoch(${paintServer});`) + offset;
      const arriveEpoch = await B(`return B.epoch(${first.arrive});`) + offset;
      report("3", "box to screen, SDK stream_event to paint (ms)", paintEpoch - fake.first, "< 250 ms on the tailnet", paintEpoch - fake.first < 250,
        `fake wrote the first delta, vyred stamped it +${first.at - fake.first} ms, the page got it +${Math.round(arriveEpoch - first.at)} ms, painted +${Math.round(paintEpoch - arriveEpoch)} ms; loopback, not the tailnet; clock offset ${offset.toFixed(1)} ms`);
    }
  }
  if (want("4")) {
    const lastArrive = texts.length ? texts[texts.length - 1].arrive : null;
    const win = r.samples.filter((/** @type {any} */ x) => r.firstPaint != null && x.t >= r.firstPaint && lastArrive != null && x.t <= lastArrive + 300);
    const g = streamGate(win);
    if (!win.length) na("4", "steady streaming", "cv < 2, p95 gap < 250 ms", "no frames sampled while streaming");
    else {
      report("4", "characters per frame coefficient of variation", g.cv ?? "n/a", "< 2", g.cv != null && g.cv < 2, `${g.frames} frames, ${g.updates} visible updates, ${texts.length} thread.text events, ${fake ? fake.chars : "?"} chars`);
      report("4.gap", "p95 gap between visible updates (ms)", g.p95Gap ?? "n/a", "< 250 ms", g.p95Gap != null && g.p95Gap < 250, `worst gap ${Math.round(g.maxGap || 0)} ms`);
    }
  }
  if (!fin) log("burst 11 never finished");
}

async function shiftBudget(/** @type {string} */ thread) {
  const from = await burst(thread, 12);
  await sleep(1000);
  const up = await wheelUp(400);
  await B(`await B.waitFrames(2); return B.holdAnchor();`);
  await waitEvent(thread, "thread.finished", from);
  await sleep(1500);
  const r = await B(`const S = B.sampler; S.stop = true;
    const live = S.el;
    const above = n => { if (!live || !n || !n.isConnected) return false; if (n === live || n.contains(live) || live.contains(n)) return false; return !!(live.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING); };
    const sh = B.shifts.filter(s => s.start >= B.shiftFrom && !s.input);
    const cls = sh.filter(s => s.nodes.some(above)).reduce((a, s) => a + s.value, 0);
    const all = sh.reduce((a, s) => a + s.value, 0);
    const fin = B.events.find(e => e.type === "thread.finished" && e.arrive >= B.shiftFrom);
    return { cls, all, n: sh.length, jumps: S.jumps, tlMove: S.tlMove || 0, stMove: S.stMove || 0,
      jumpAt: S.firstJumpAt == null ? null : S.firstJumpAt - B.shiftFrom, finAt: fin ? fin.arrive - B.shiftFrom : null };`);
  const lost = r.jumps.filter((/** @type {number} */ j) => j < 0).length;
  const jump = r.jumps.length ? Math.max(...r.jumps) : null;
  const pulled = up.kept < 100;
  const pass = r.cls === 0 && !pulled && jump != null && jump <= 1 && !lost;
  report("5", "layout shift above the live row (CLS)", r.cls, "CLS 0 above the live row; no viewport jump scrolled up", jump == null ? null : pass,
    `all shifts while streaming ${r.all.toFixed(4)} (${r.n} entries); wheel up 400 px reached ${up.reached} px and ${pulled ? `the view pulled the reader back to ${up.kept} px within 250 ms (so the anchor below is the view following the bottom)` : `kept ${up.kept} px`}; reading anchor moved at most ${jump == null ? "n/a" : jump.toFixed(1)} px over ${r.jumps.length} frames (timeline box moved ${Math.round(r.tlMove)} px, scrollTop changed ${Math.round(r.stMove)} px)${r.jumpAt != null ? `; it first moved ${Math.round(r.jumpAt)} ms after the send (thread.finished arrived at ${r.finAt == null ? "?" : Math.round(r.finAt)} ms)` : ""}${lost ? `, anchor row unmounted in ${lost} frames` : ""}`);
  await B(`const tl = B.timeline(); tl.scrollTop = tl.scrollHeight; return true;`);
  await sleep(800);
}

async function reconnectBudget(/** @type {string} */ thread) {
  const offset = await clockOffset();
  const from = await burst(thread, 13);
  await sleep(1500);
  const up = await wheelUp(300);
  await B(`await B.waitFrames(2); B.holdAnchor(); B.rowsAtDrop = B.rows().length; B.errFrom = B.esError.length; B.openFrom = B.esOpen.length; return true;`);
  const DOWN = 2500;
  await tab.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(400);
  let how = "Network.emulateNetworkConditions offline";
  // An EventSource Deck says it lost the stream; a fetch-stream Deck (work/pwa) may not notice an
  // offline emulation at all, so cut it at the proxy then.
  const dropped = await B(`return B.via !== "fetch" && (B.esError.length > B.errFrom || (B.es && B.es.readyState !== 1));`);
  if (!dropped) {
    // Offline emulation did not cut the open stream in this Chrome: cut it at the proxy, as a lost network would.
    await tab.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await fetch(`${world.url}/__bar/drop?ms=${DOWN}`, { method: "POST" });
    how = "sockets cut at the proxy (offline emulation left the stream open)";
    await sleep(DOWN);
  } else {
    await sleep(DOWN - 400);
    await tab.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }
  const tRestore = await B(`return performance.now();`);
  const restoreServer = (await B(`return B.epoch(${tRestore});`)) + offset;
  await waitEvent(thread, "thread.finished", from, 40_000);
  await sleep(2500);
  const r = await B(`const S = B.sampler; S.stop = true;
    const ev = B.events.slice(${from}).filter(e => e.thread === ${JSON.stringify(thread)});
    const tl = B.timeline(); const txt = tl.innerText;
    const count = s => txt.split(s).length - 1;
    const users = [...tl.querySelectorAll(".cv-user")].filter(u => u.textContent.includes("burst 13")).length;
    return { ev, jumps: S.jumps, blank: S.blank, rowsMin: S.rowsMin, rowsAtDrop: B.rowsAtDrop, done: count("Done with [bar-13]."), starts: count("[bar-13] Here is the plan"),
      users, jumpAt: S.firstJumpAt == null ? null : S.firstJumpAt - ${tRestore}, finAt: (B.events.find(e => e.type === "thread.finished" && e.arrive >= ${tRestore}) || {}).arrive - ${tRestore}, tlMove: S.tlMove || 0, stMove: S.stMove || 0, opens: B.esOpen.length - B.openFrom, errors: B.esError.length - B.errFrom, via: B.via,
      states: B.streamStates.filter(x => x.t >= ${tRestore} - ${DOWN} - 500).map(x => x.state + "@" + Math.round(x.t - ${tRestore})).join(" ") };`);
  const after = r.ev.find((/** @type {any} */ e) => e.at >= restoreServer - 5 && e.arrive >= tRestore);
  const catchup = after ? after.arrive - tRestore : null;
  const ids = r.ev.map((/** @type {any} */ e) => e.id);
  const dupEvents = ids.length - new Set(ids).size;
  const dups = Math.max(0, r.done - 1) + Math.max(0, r.starts - 1) + Math.max(0, r.users - 1);
  const missing = r.done === 0 ? 1 : 0;
  const jump = r.jumps.filter((/** @type {number} */ j) => j >= 0);
  const maxJump = jump.length ? Math.max(...jump) : null;
  const blankRows = r.rowsMin < r.rowsAtDrop * 0.5 ? 1 : 0;
  const pulled = up.kept < 100;
  const pass = catchup != null && catchup <= 1000 && !dups && !missing && !r.blank && !blankRows && !pulled && maxJump != null && maxJump <= 1;
  report("8", "reconnect, network back to caught up (ms)", catchup ?? "n/a", "caught up within 1 s; no blank, no duplicate row, no scroll jump", catchup == null ? null : pass,
    `${how} for ${DOWN} ms; the Deck reads the stream by ${r.via}${r.states ? ` (deck:stream ${r.states} ms after restore)` : ""}; reader scrolled up ${up.kept} px${pulled ? " (pulled back to the bottom)" : ""}; stream reopened ${r.opens}x (${r.errors} errors); duplicate rows ${dups} (reply end marker x${r.done}, start marker x${r.starts}, user row x${r.users}); `
    + `duplicate events ${dupEvents}; blank frames ${r.blank}${blankRows ? `, rows fell to ${r.rowsMin} of ${r.rowsAtDrop}` : ""}; anchor moved at most ${maxJump == null ? "n/a" : maxJump.toFixed(1)} px (the timeline box itself moved ${Math.round(r.tlMove)} px, scrollTop changed ${Math.round(r.stMove)} px${r.jumpAt != null ? `; first moved ${Math.round(r.jumpAt)} ms after the network came back, thread.finished at ${Number.isFinite(r.finAt) ? Math.round(r.finAt) : "?"} ms` : ""})`);
  await B(`const tl = B.timeline(); tl.scrollTop = tl.scrollHeight; return true;`);
  await sleep(800);
}

async function sendBudget(/** @type {string} */ thread) {
  const has = await B(`return !!document.querySelector(${JSON.stringify(composerSel)});`);
  if (!has) return na("9", "send, Enter to user row painted (ms)", "< 50 ms, no flicker or re-order", `no composer textarea (${composerSel})`);
  const text = `note from alex ${Date.now() % 100000}`;
  await B(`const ta = document.querySelector(${JSON.stringify(composerSel)}); ta.focus(); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event("input", { bubbles: true }));
    const W = B.send = { t0: null, first: null, frames: [], stop: false };
    document.addEventListener("keydown", e => { if (e.key === "Enter" && W.t0 == null) W.t0 = e.timeStamp; }, { capture: true, once: true });
    const tick = () => { if (W.stop) return;
      const m = [...document.querySelectorAll(".thread-view .cv-user")].filter(u => (u.querySelector(".cv-user-text") || u).textContent.trim() === ${JSON.stringify(text)});
      const at = performance.now();
      if (m.length && W.first == null && W.t0 != null) W.first = at;
      const prev = m[0] && m[0].previousElementSibling ? (m[0].previousElementSibling.textContent || "").slice(0, 60) : null;
      if (W.t0 != null) W.frames.push({ n: m.length, prev });
      requestAnimationFrame(tick); };
    requestAnimationFrame(tick); return true;`);
  await key("Enter", { text: "\r", code: "Enter", vk: 13 });
  await sleep(4000);
  const r = await B(`const W = B.send; W.stop = true; return { t0: W.t0, first: W.first, frames: W.frames };`);
  if (r.first == null) return report("9", "send, Enter to user row painted (ms)", "timeout", "< 50 ms, no flicker or re-order", false, "no user row with the sent words within 4 s");
  let seen = false, flicker = 0, dup = 0, reorder = 0, prev = null;
  /** @type {string[]} */ const changes = [];
  for (const f of r.frames) {
    if (f.n > 0) { if (seen && prev != null && f.prev !== prev) { reorder++; changes.push(`"${String(prev).slice(0, 30)}" to "${String(f.prev).slice(0, 30)}"`); } prev = f.prev; seen = true; }
    if (seen && f.n === 0) flicker++;
    if (f.n > 1) dup++;
  }
  const ms = r.first - r.t0;
  report("9", "send, Enter to user row painted (ms)", ms, "< 50 ms, no flicker or re-order", ms < 50 && !flicker && !dup && !reorder,
    `over ${r.frames.length} frames after Enter: ${flicker} frames without the row, ${dup} frames with two, the row above it changed ${reorder}x${changes.length ? ` (${changes.slice(0, 2).join("; ")})` : ""}`);
  await waitEvent(thread, "thread.finished", 0, 10_000);
  await sleep(1500);
}

async function stopBudget(/** @type {string} */ thread) {
  const from = await burst(thread, 14);
  await sleep(800);
  const r0 = await B(`const ta = document.querySelector(${JSON.stringify(composerSel)}); if (ta) ta.focus();
    const W = B.stopW = { t0: null, at: null, stop: false };
    const tl = B.timeline();
    const before = new Set([...tl.querySelectorAll(".cv-turn, .turn-foot")]);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && W.t0 == null) W.t0 = e.timeStamp; }, { capture: true, once: true });
    const shows = () => { const chip = document.querySelector(".cv-state"); if (chip && /stopp|interrupt/i.test(chip.textContent)) return "chip";
      const t = [...tl.querySelectorAll(".cv-turn, .turn-foot")].find(el => !before.has(el) && /stopped/i.test(el.textContent)); return t ? "turn row" : null; };
    const tick = () => { if (W.stop) return; if (W.t0 != null && W.at == null) { const s = shows(); if (s) { W.at = performance.now(); W.how = s; } } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return { focused: !!ta, chip: !!document.querySelector(".cv-state"), stopBtn: !!document.querySelector('.composer [aria-label="Stop"], .composer-stop, .cv-stop') };`);
  await key("Escape", { code: "Escape", vk: 27 });
  for (let i = 0; i < 25; i++) { if (await B(`return B.stopW.at != null;`)) break; await sleep(200); }
  const r = await B(`const W = B.stopW; W.stop = true; return { t0: W.t0, at: W.at, how: W.how };`);
  if (r.at == null) {
    if (!r0.chip && !r0.stopBtn) na("10", "Esc to stopped (ms)", "< 100 ms", "this tree has no Stop control: Esc in the composer does not stop a turn and the header has no state chip (.cv-state)");
    else report("10", "Esc to stopped (ms)", "timeout", "< 100 ms", false, `nothing read "stopped" within 5 s (chip ${r0.chip}, stop button ${r0.stopBtn})`);
  } else report("10", "Esc to stopped shown (ms)", r.at - r.t0, "< 100 ms", r.at - r.t0 < 100, `shown by the ${r.how}`);
  await waitEvent(thread, "thread.finished", from, 12_000);
}

// ---- run ------------------------------------------------------------------------------------------------------

async function guard(/** @type {string} */ id, /** @type {string} */ metric, /** @type {string} */ budget, /** @type {() => Promise<any>} */ fn) {
  if (!want(id)) return;
  try { await fn(); } catch (e) { na(id, metric, budget, "harness error: " + String(/** @type {any} */ (e)?.message || e).slice(0, 200)); }
}

try {
  await guard("7", "open a session", "< 300 ms cached, < 1 s cold", openBudget);
  await guard("1", "keystroke, 40 rows", "p95 processing < 16 ms, to next paint < 33 ms", async () => { await openSession(world.s40); await keystrokes("1.40", "40-row transcript"); });
  if (want("6") || want("1")) {
    await openSession(world.s2000);
    await guard("6", "fling p95 frame time", "p95 < 16.7 ms", fling);
    await guard("1", "keystroke, 2,000 rows", "p95 processing < 16 ms, to next paint < 33 ms", async () => { if (!want("6")) await loadAll(); await keystrokes("1.2000", "2,000-row transcript"); });
  }
  if (["2", "3", "4", "5", "8", "9", "10"].some(want)) {
    const thread = await startThread();
    await openSession(thread);
    if (["2", "3", "4"].some(want)) {
      try { await streamBudgets(thread); } catch (e) { for (const id of ["2", "3", "4"]) if (want(id)) na(id, "streaming", "see the doc", "harness error: " + String(/** @type {any} */ (e)?.message || e).slice(0, 200)); }
    }
    await guard("5", "layout shift while streaming", "CLS 0", () => shiftBudget(thread));
    await guard("8", "reconnect", "caught up within 1 s", () => reconnectBudget(thread));
    await guard("9", "send", "< 50 ms", () => sendBudget(thread));
    await guard("10", "Esc to stopped", "< 100 ms", () => stopBudget(thread));
  }
  await guard("11", "idle timers", "none faster than 60 s", idle);
} catch (e) {
  log("stopped early: " + String(/** @type {any} */ (e)?.stack || e));
} finally {
  const errors = tab.errors.filter(e => !/fonts\.g|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e));
  try { await tab.close(); } catch {}
  await stopAll();
  const cell = (/** @type {any} */ v) => String(v ?? "").replace(/\|/g, "\\|");
  const order = (/** @type {string} */ id) => Number(id.split(".")[0]);
  const rows = [...results].sort((a, b) => order(a.id) - order(b.id));
  const md = [`### ${LABEL}`, "", "| # | Metric | Value | Budget | Pass | Notes |", "|---|---|---|---|---|---|",
    ...rows.map(r => `| ${r.id} | ${cell(r.metric)} | ${cell(r.value)} | ${cell(r.budget)} | ${r.pass == null ? "n/a" : r.pass ? "yes" : "no"} | ${cell(r.detail)} |`)];
  if (errors.length) md.push("", `Page errors: ${errors.slice(0, 5).map(cell).join(" / ")}`);
  process.stdout.write("\n" + md.join("\n") + "\n");
  process.exit(0);
}
