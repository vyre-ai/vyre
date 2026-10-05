#!/usr/bin/env node
// app-walk-shell: the app's one shell at phone width (390x844) against a real vyred, as the box's owner (a stand-in person session): the tab bar, Now, Chat, New chat, Search, Assistants and the More menu.
// One screenshot each; fails on a page error or when a route the shell points at is missing. TEST ONLY; ssh login shell, foreground.
//   node scripts/app-walk-shell.mjs --dist apps/app/dist-shell --socket <home>/.vyre/vyred.sock [--out dir] [--width 390]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist-shell"));
const SOCKET = flag("--socket", "");
const OUT = path.resolve(flag("--out", "shell-out"));
const WIDTH = Number(flag("--width", "390"));
if (!SOCKET) { console.error("give --socket"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");
const box = (tool, input = {}, headers = {}) => new Promise((resolve) => {
  const body = JSON.stringify(input);
  const r = http.request({ socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": "cli", "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } }); });
  r.on("error", () => resolve({})); r.end(body);
});
await box("relay.status", {}, { "x-vyre-presence": "stand-in" });
const TOKEN = (await box("signin.dev", { node: "shell-walk", label: "walk" })).data?.token ?? "";
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
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 844 }, deviceScaleFactor: 2, isMobile: WIDTH < 600, hasTouch: WIDTH < 600, colorScheme: "dark", serviceWorkers: "block" });
const pg = await ctx.newPage();
const errors = []; pg.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
const text = async () => (await pg.locator("body").innerText()).replace(/\s+/g, " ");
let failed = 0;
const shot = async (n, expect) => {
  await pg.waitForTimeout(3500);
  const t = await text();
  const ok = !expect || expect.test(t);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${n}: ${t.slice(0, 200)}`);
  await pg.screenshot({ path: path.join(OUT, `${n}.png`) });
};
await pg.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await shot("1-root-opens-on-now", /Now/);
console.log("path after root:", new URL(pg.url()).pathname);
for (const [n, route, re] of [["2-chat", "/u/chats", /Chat/], ["3-new-chat", "/u/chats/new", /New chat|Who do you want to talk to/], ["4-search", "/u/search", /Search/], ["5-assistants", "/u/assistants", /Assistants/]]) {
  await pg.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  await shot(n, re);
}
await pg.goto(`${BASE}/u/search`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(3000);
await pg.getByLabel("Search").first().fill("jane");
await shot("6-search-jane", /Jane/);
await pg.goto(`${BASE}/u/now`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(3000);
const more = pg.getByText("More", { exact: true }).last();
if (await more.count()) { await more.click(); await shot("7-more-menu", /Flows|Calendar|Memory/); }
// The look survives a restart: choose Compact density in Appearance, see it kept, reload the page, see it still chosen.
await pg.goto(`${BASE}/u/appearance`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(3500);
await pg.getByText("Compact", { exact: true }).first().click().catch(() => {});
await pg.getByText("Reduce motion", { exact: false }).first().waitFor({ timeout: 5000 }).catch(() => {});
await pg.waitForTimeout(1200);
const kept = await pg.evaluate(() => localStorage.getItem("vyre.appearance"));
console.log(`${/"density":"compact"/.test(kept ?? "") ? "PASS" : "FAIL"} 8-appearance-kept: ${kept}`);
if (!/"density":"compact"/.test(kept ?? "")) failed++;
await pg.reload({ waitUntil: "domcontentloaded" });
await pg.waitForTimeout(4000);
await pg.screenshot({ path: path.join(OUT, "8-appearance-after-reload.png") });
const after = await text();
const still = /compact density/.test(after);
console.log(`${still ? "PASS" : "FAIL"} 9-compact-still-chosen-after-reload: ${after.match(/with accent[^.]*/)?.[0] ?? ""}`);
if (!still) failed++;
console.log("page errors:", errors.slice(0, 3).join(" | "));
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
