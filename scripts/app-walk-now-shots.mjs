#!/usr/bin/env node
// app-walk-now-shots: screenshots of Now (the vault health card and the work waiting on the owner) at 1440 and 390 wide, light and dark. TEST BOX ONLY. It starts a vyred of its own in a temp home (kernel on), seeds the
// Estate plan template, a project started from it (with its team, tasks, a file and a chat) and a free-flow project, serves a web export of the app in front of it and drives a browser.
//   node scripts/app-walk-now-shots.mjs --dist apps/app/dist [--out dir]
// The vault health counts come from the Watchtower reminders; with no vault unlocked on a throwaway home the walk answers vault.health.summary itself (a proxy answer, said on the console), the rest is the real box.
import "./mac-test-guard.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { start } from "../core/daemon/index.js";
import { paths } from "../core/config/index.js";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist-shots"));
const OUT = path.resolve(flag("--out", "now-shots"));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

// ---- a daemon of its own, seeded
const used = new Set();
const presence = { check: async (q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-now-shots-"));
const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
const space = d.kernel.id.space, owner = d.kernel.id.owner;
const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
const TOKEN = (await d.kernel.surfaces.open(ownerChain, {})).token;
const call = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: TOKEN }); if (r.error) throw new Error(`${tool}: ${r.error.message}`); return r.data; };
// work that waits on the owner: a project from the Estate plan template, and a task made for the owner
const lib = await call("work.template.install", { id: "law-firm/estate-plan" });
await call("work.template.golive", { template: lib.template, version: lib.version });
await call("work.start-project", { template: lib.template, name: "Rivera Family Trust", repo: "" });
for (const title of ["Review the engagement letter", "Call the Rivera family back", "Approve the draft trust"]) {
  await d.kernel.gateway.ask.request(ownerChain, { title, doer: { kind: "person", id: owner, space }, output: { kind: "decision" } }).catch((e) => console.log("no task:", e.message));
}
await new Promise((r) => setTimeout(r, 1500));
// the vault's own reminders are a daily Watchtower pass over unlocked items; a throwaway home has none, so the walk answers the health summary (counts only, as the tool does)
const HEALTH = { total: 4, rotate: 1, fix: 3, counts: { expiring: 1, reused: 3 }, dismissed_until: null };

// ---- the app in front of it
const SOCKET = paths(root).socket;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1")) {
    // the app's tool calls go straight to this process's registry as the owner's session (a socket client of a shell on this box is classed by where it runs, which a screenshot walk must not depend on)
    const u = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && u.pathname.startsWith("/v1/tools/")) {
      let raw = ""; req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        let input = {}; try { input = raw ? JSON.parse(raw) : {}; } catch { /* empty */ }
        const tool = decodeURIComponent(u.pathname.slice("/v1/tools/".length));
        if (tool === "vault.health.summary") return send(200, { data: HEALTH });
        const r = await d.registry.call(tool, input, "cli", { token: TOKEN });
        send(200, r.error ? { error: r.error } : { data: r.data });
      });
      return;
    }
    console.log("unserved:", req.method, u.pathname);
    return send(u.pathname === "/v1/health" ? 200 : 404, u.pathname === "/v1/health" ? { ok: true } : { error: { code: "not_found", message: "not served by the walk" } });
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
const SIZES = [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]];
for (const scheme of ["light", "dark"]) for (const [label, viewport] of SIZES) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/u/now`, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(4500);
  const text = (await pg.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 220);
  console.log(`now-${label}-${scheme}:`, text);
  await pg.screenshot({ path: path.join(OUT, `now-${label}-${scheme}.png`), fullPage: false });
  await ctx.close();
}
await browser.close(); server.close(); await d.stop(); process.exit(0);
