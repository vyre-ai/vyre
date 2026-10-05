#!/usr/bin/env node
// app-walk-records-shots: screenshots of the Records list and board for one type (default walk_matter, made by scripts/app-walk-paired-device.mjs), as the box's owner (a stand-in person session). TEST ONLY; run it
// from an ssh login shell, in the foreground.
//   node scripts/app-walk-records-shots.mjs --dist apps/app/dist-fr --socket <home>/.vyre/vyred.sock [--type walk_matter] [--out dir]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist-fr"));
const SOCKET = flag("--socket", "");
const TYPE = flag("--type", "walk_matter");
const OUT = path.resolve(flag("--out", "records-shots"));
if (!SOCKET) { console.error("give --socket <home>/.vyre/vyred.sock"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");
const box = (tool, input = {}, headers = {}) => new Promise((resolve) => {
  const body = JSON.stringify(input);
  const r = http.request({ socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": "cli", "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } }); });
  r.on("error", () => resolve({})); r.end(body);
});
await box("relay.status", {}, { "x-vyre-presence": "stand-in" });
const si = await box("signin.dev", { node: "records-shots", label: "shots" });
const TOKEN = si.data?.token ?? "";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1")) {
    const up = http.request({ socketPath: SOCKET, path: req.url, method: req.method, headers: { ...req.headers, host: "localhost", "x-vyre-caller": "cli", ...(TOKEN ? { cookie: `__Host-vyre_person=${TOKEN}` } : {}) } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end(); });
    return req.pipe(up);
  }
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(DIST, p);
  const missing = !f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory();
  if (missing && path.extname(p)) { res.writeHead(404); return res.end(); }
  if (missing) f = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}/app`;
const browser = await chromium.launch({ args: [...CHROME_SAFE] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", serviceWorkers: "block" });
const pg = await ctx.newPage();
const text = async () => (await pg.locator("body").innerText()).replace(/\s+/g, " ");
await pg.goto(`${BASE}/u/records/${TYPE}`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(5000);
console.log("list:", (await text()).slice(0, 260));
await pg.screenshot({ path: path.join(OUT, `${TYPE}-list.png`) });
for (const v of ["Board", "Kanban", "Stage"]) { const b = pg.getByText(v, { exact: true }).first(); if (await b.count()) { await b.click().catch(() => {}); break; } }
await pg.waitForTimeout(2500);
console.log("board:", (await text()).slice(0, 260));
await pg.screenshot({ path: path.join(OUT, `${TYPE}-board.png`) });
await browser.close(); server.close();
