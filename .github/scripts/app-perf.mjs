// @ts-check
// The app's web perf guard for CI (ADR 0027, section 6): apps/app/dist served at /app/ on the same
// origin as apps/test/world.js, opened at /app/?perf=1 in headless Chromium at 390x844 with the
// CPU throttled 4x. It waits for Now, switches tabs 5 times, opens a session and scrolls it,
// then reads window.__vyrePerf.report(). Numbers of record come from real phones; this only
// guards against regressions: a tracked measure more than 20% worse than the last green run
// fails, and a measure with no samples is "not measured", never a failure.
//
//   node .github/scripts/app-perf.mjs --dist apps/app/dist --out perf.json [--baseline old.json]
//
// Needs `playwright` resolvable (CI installs it outside the repo) and the root npm install for
// the world. Starts only its own processes and stops them.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const arg = (name, dflt) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : dflt; };
const DIST = path.resolve(arg("dist", "apps/app/dist"));
const OUT = arg("out", "perf.json");
const BASELINE = arg("baseline", "");
const WORLD_PORT = 4810, PORT = 4811;
const require = createRequire(process.env.PLAYWRIGHT_DIR ? path.join(process.env.PLAYWRIGHT_DIR, "x.js") : import.meta.url);
const { chromium } = require("playwright");

/** Tracked measures: where each lives in report(), and whether lower is better. */
const TRACKED = [
  { id: "tab.switch p95", get: r => r.metrics?.["tab.switch"], stat: "p95" },
  { id: "open.cold p95", get: r => r.metrics?.["open.cold"], stat: "p95" },
  { id: "approve.collapse p95", get: r => r.metrics?.["approve.collapse"], stat: "p95" },
  { id: "frames.droppedPct", get: r => r.frames, stat: "droppedPct", always: true },
  { id: "longTasks.over50", get: r => r.longTasks, stat: "over50", always: true },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".ico": "image/x-icon", ".map": "application/json" };

/** /app/* from dist (an unknown path is the SPA's index.html), everything else to the world. */
function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      let rel = decodeURIComponent(url.pathname.slice(4)) || "/";
      let file = path.join(DIST, rel);
      if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        const html = path.join(DIST, rel.replace(/\/$/, "") + ".html");
        file = fs.existsSync(html) ? html : path.join(DIST, "index.html");
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const up = http.request({ host: "127.0.0.1", port: WORLD_PORT, path: req.url, method: req.method, headers: req.headers }, r => {
      res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  return new Promise(resolve => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

async function startWorld() {
  const child = spawn(process.execPath, ["apps/test/world.js", String(WORLD_PORT)], { env: { ...process.env, VYRE_NO_DIALOGS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${WORLD_PORT}/v1/health`); if (r.status < 500) return child; } catch {}
    if (child.exitCode !== null) throw new Error("the world exited: " + log.slice(-2000));
    await sleep(500);
  }
  throw new Error("the world did not answer in 60 s: " + log.slice(-2000));
}

/** The first of several selectors that is there, or null. */
async function first(page, selectors) {
  for (const s of selectors) { const l = page.locator(s).first(); if (await l.count()) return l; }
  return null;
}

async function drive(page) {
  const notes = [];
  await page.goto(`http://127.0.0.1:${PORT}/app/?perf=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /** @type {any} */ (window).__vyrePerf, null, { timeout: 60_000 });
  // Now is drawn when open.cold has a sample (it is marked when Needs is drawn).
  await page.waitForFunction(() => (/** @type {any} */ (window).__vyrePerf.report().metrics?.["open.cold"]?.n || 0) > 0, null, { timeout: 60_000 })
    .catch(() => notes.push("open.cold never marked: Now did not draw"));
  for (let i = 0; i < 5; i++) {
    for (const name of ["Chats", "Agents", "Now"]) {
      const tab = await first(page, [`[data-testid="tab-${name.toLowerCase()}"]`, `role=tab[name=/${name}/]`, `text="${name}"`]);
      if (!tab) { notes.push(`no ${name} tab`); continue; }
      await tab.click(); await sleep(300);
    }
  }
  const row = await first(page, ['[data-testid="now-row"]', '[data-testid="session-row"]']);
  if (row) {
    await row.click();
    const list = await first(page, ['[data-testid="transcript"]']);
    if (list) { for (let i = 0; i < 10; i++) { await list.hover(); await page.mouse.wheel(0, 600); await sleep(100); } }
    else notes.push("no transcript to scroll");
  } else notes.push("no now-row or session-row to open");
  await sleep(1000);
  return { report: await page.evaluate(() => /** @type {any} */ (window).__vyrePerf.report()), notes };
}

function compare(report, base) {
  const rows = [];
  for (const t of TRACKED) {
    const cur = t.get(report), was = base ? t.get(base) : null;
    const n = cur && "n" in cur ? cur.n : (cur ? 1 : 0);
    const v = cur ? cur[t.stat] : null;
    if (!n || v === null || v === undefined) { rows.push({ id: t.id, value: null, note: "not measured" }); continue; }
    const b = was && (!("n" in was) || was.n) ? was[t.stat] : null;
    // over50 and droppedPct start at 0: from 0, any new long task or dropped frame counts as worse only past a floor.
    const floor = t.stat === "over50" ? 1 : t.stat === "droppedPct" ? 1 : 0;
    const worse = b !== null && b !== undefined && v > Math.max(b * 1.2, b + floor);
    rows.push({ id: t.id, value: v, baseline: b ?? null, pass: !worse });
  }
  return rows;
}

async function main() {
  const world = await startWorld();
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const { report, notes } = await drive(page);
    const base = BASELINE && fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")).report : null;
    const rows = compare(report, base);
    fs.writeFileSync(OUT, JSON.stringify({ report, rows, notes, at: new Date().toISOString() }, null, 2));
    console.log(`app perf (Chromium, 390x844, CPU 4x)${base ? "" : ", no baseline yet"}`);
    for (const r of rows) console.log(`  ${r.value === null ? "----" : r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(22)} ${r.value === null ? r.note : `${round(r.value)}${r.baseline !== null && r.baseline !== undefined ? `  (last green ${round(r.baseline)})` : ""}`}`);
    for (const n of notes) console.log("  note: " + n);
    process.exitCode = rows.some(r => r.pass === false) ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
    server.close();
    world.kill("SIGTERM");
    await Promise.race([new Promise(r => world.once("exit", r)), sleep(5000)]);
  }
}

const round = v => Math.round(v * 10) / 10;
main().catch(e => { console.error("app-perf: " + (e.stack || e.message)); process.exitCode = 1; });
