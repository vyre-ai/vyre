// Chat performance, measured in headless Chromium on the exported web app and printed as JSON lines.
//   node perf/chat-perf.mjs [--dist dist] [--throttle 1] [--runs 1]
// Needs `playwright` resolvable (PW_FROM, default $HOME/shots/; it is on the test server, not in the app).
//   a. paint: a frame emitted by the mock (performance.now stamped in it) to the text painted.
//      `paint.first` is the first characters of a reply; `paint.delta` is every delta fully on
//      screen. Target p95 <= 300 ms.
//   b. scroll: frame rate and frame time while a fling scrolls the 10,000-message thread (rAF
//      deltas), at a fast phone fling and at a hard one. Target 60 fps.
//   c. keystroke: key down to the next paint in the composer while a reply streams.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const dist = path.resolve(flag("--dist", "dist"));
const throttle = Number(flag("--throttle", "1"));
const width = Number(flag("--w", "390"));
const only = flag("--only", "");
const require = createRequire(process.env.PW_FROM || path.join(process.env.HOME, "shots/"));
const { chromium } = require("playwright");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".ttf": "font/ttf" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/app/chat-demo`;

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const line = (o) => console.log(JSON.stringify(o));

const browser = await chromium.launch();
async function page(query) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, colorScheme: "dark" });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(String(e)));
  if (throttle > 1) { const c = await ctx.newCDPSession(pg); await c.send("Emulation.setCPUThrottlingRate", { rate: throttle }); }
  await pg.goto(`${base}${query}`, { waitUntil: "networkidle" });
  return { pg, ctx, errors };
}

try {
  line({ metric: "env", chromium: browser.version(), width, throttle, node: process.version });

  if (!only || only === "paint") {
    const { pg, ctx, errors } = await page("");
    await pg.waitForFunction(() => window.__chat?.source?.state() === "asking", null, { timeout: 60000 });
    await pg.waitForTimeout(400);
    const m = await pg.evaluate(() => ({ delta: window.__chat.meter.delta, first: window.__chat.meter.first }));
    line({ metric: "paint.first", unit: "ms", n: m.first.length, p50: pct(m.first, 0.5), p95: pct(m.first, 0.95), max: pct(m.first, 1), target: 300, pass: m.first.length > 0 && pct(m.first, 0.95) <= 300 });
    line({ metric: "paint.delta", unit: "ms", n: m.delta.length, p50: pct(m.delta, 0.5), p95: pct(m.delta, 0.95), max: pct(m.delta, 1), target: 300, pass: m.delta.length > 0 && pct(m.delta, 0.95) <= 300 });
    if (errors.length) line({ metric: "errors", errors: errors.slice(0, 3) });
    await ctx.close();
  }

  if (!only || only === "scroll") {
    // Two flings through the same 10,000-message thread while the mock reply streams at its tail:
    // "fling" is a fast phone fling (120 px a frame, about 7,000 px a second); "hard" is 250 px a frame and speeding up.
    for (const [name, base, accel] of [["fling", 120, 0], ["hard", 250, 20]]) {
      const t0 = Date.now();
      const { pg, ctx, errors } = await page("?n=10000");
      await pg.waitForSelector("[data-testid=transcript]");
      const loadMs = Date.now() - t0;
      const r = await pg.evaluate(async ({ base, accel }) => {
        const el = document.querySelector("[data-testid=transcript]");
        const rows = () => el.querySelectorAll("[data-k]").length;
        const mountedAtRest = rows();
        const deltas = [];
        let last = performance.now();
        let stop = false;
        const tick = (t) => { deltas.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        const t0 = performance.now();
        let y = 0, maxMounted = 0;
        await new Promise((done) => {
          const step = (t) => {
            const dt = t - t0;
            if (dt > 5000) return done();
            y -= base + (accel ? dt / accel : 0);
            el.scrollTop = y;
            maxMounted = Math.max(maxMounted, rows());
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        stop = true;
        return { deltas: deltas.slice(2), scrolled: Math.round(-y), mountedAtRest, maxMounted };
      }, { base, accel });
      const d = r.deltas;
      const fps = d.length / (d.reduce((a, b) => a + b, 0) / 1000);
      line({ metric: `scroll.${name}`, thread: 10000, fps: +fps.toFixed(1), p50_frame_ms: pct(d, 0.5), p95_frame_ms: pct(d, 0.95), max_frame_ms: pct(d, 1), frames: d.length, over_25ms: d.filter((x) => x > 25).length, scrolled_px: r.scrolled, mounted_rows_at_rest: r.mountedAtRest, max_mounted_rows: r.maxMounted, load_ms: loadMs, target_fps: 60, pass: fps >= 57 });
      if (errors.length) line({ metric: "errors", errors: errors.slice(0, 3) });
      await ctx.close();
    }
  }

  if (!only || only === "keystroke") {
    const { pg, ctx, errors } = await page("");
    await pg.waitForSelector("textarea");
    await pg.waitForFunction(() => window.__chat?.source?.state() === "working");
    await pg.evaluate(() => {
      window.__keys = [];
      document.addEventListener("keydown", () => {
        const t0 = performance.now();
        requestAnimationFrame(() => setTimeout(() => window.__keys.push(performance.now() - t0), 0));
      }, true);
    });
    await pg.click("textarea");
    for (const ch of "Please also check the leap day rule for the second filing date.") { await pg.keyboard.type(ch); await pg.waitForTimeout(45); }
    await pg.waitForTimeout(200);
    const { keys, streaming } = await pg.evaluate(() => ({ keys: window.__keys, streaming: window.__chat.source.state() }));
    line({ metric: "keystroke", unit: "ms", n: keys.length, p50: pct(keys, 0.5), p95: pct(keys, 0.95), max: pct(keys, 1), stream_state_at_end: streaming, target_p95: 33, pass: pct(keys, 0.95) <= 33 });
    if (errors.length) line({ metric: "errors", errors: errors.slice(0, 3) });
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
