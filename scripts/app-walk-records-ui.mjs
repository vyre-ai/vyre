#!/usr/bin/env node
// app-walk-records-ui: the Records screens as the box's owner (a stand-in person session): define a type in Customize (text, choice, link, sealed), add two records, open the list, the board and a record with its
// sealed field. One screenshot per step; prints what each screen says. TEST ONLY; ssh login shell, foreground.
//   node scripts/app-walk-records-ui.mjs --dist apps/app/dist-fr --socket <home>/.vyre/vyred.sock [--out dir]
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
const OUT = path.resolve(flag("--out", "records-ui-out"));
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
const TOKEN = (await box("signin.dev", { node: "records-ui", label: "walk" })).data?.token ?? "";
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
const errors = []; pg.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
const text = async () => (await pg.locator("body").innerText()).replace(/\s+/g, " ");
const say = async (n) => { console.log(`${n}: ${(await text()).slice(0, 320)}`); await pg.screenshot({ path: path.join(OUT, `${n}.png`) }); };
const click = async (t, o = {}) => { await pg.getByText(t, { exact: o.exact ?? true }).first().click({ timeout: 15000 }); await pg.waitForTimeout(o.wait ?? 900); };
const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`STEP ${n} FAILED: ${String(e.message).split("\n")[0]}`); await pg.screenshot({ path: path.join(OUT, `${n}-fail.png`) }).catch(() => {}); } };
const go = async (route, ms = 4000) => { await pg.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(ms); };

await step("1-customize", async () => { await go("/u/settings/customize"); await say("1-customize"); });
await step("2-add-type", async () => { await click("Add a type"); await pg.getByLabel("Name (one of them)").first().fill(`Walk case ${Date.now().toString(36).slice(-3)}`); await say("2-add-type"); await click("Add type", { wait: 2500 }); await say("2b-type-added"); });
await step("3-type-screen", async () => { await click("Walk case ", { exact: false, wait: 2500 }); await say("3-type-screen"); });
for (const [label, kind] of [["Practice area", "Choice"], ["Client", "Link"], ["SSN", "Sealed"]]) {
  await step(`4-field-${label}`, async () => {
    await click("Add a field");
    await pg.getByLabel("Name").first().fill(label);
    await say(`4-field-${label}-open`);
    const b = pg.getByRole("button", { name: "Text", exact: true }).first();
    if (await b.count()) { await b.click(); await pg.waitForTimeout(800); console.log("roles:", await pg.evaluate(() => [...document.querySelectorAll("[role]")].map((e) => e.getAttribute("role")).filter((r) => /menu|option|listbox|dialog/.test(r)).join(","))); await say(`4-field-${label}-kinds`); const mi = pg.getByRole("menuitem", { name: kind, exact: true }).first(); if (await mi.count()) await mi.click(); else await pg.getByText(kind, { exact: true }).last().click().catch(() => {}); await pg.waitForTimeout(600); }
    await say(`4-field-${label}-form`);
    await click("Add field", { wait: 2000 });
  });
}
await step("5-type-with-fields", async () => { await say("5-type-with-fields"); });
console.log("page errors:", errors.slice(0, 3).join(" | "));
await browser.close(); server.close(); process.exit(0);
