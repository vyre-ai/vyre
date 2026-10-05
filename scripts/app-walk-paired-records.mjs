#!/usr/bin/env node
// app-walk-paired-records: a browser paired by TYPED CODE (the owner types the ack back) then opens the records screens as that paired device. TEST ONLY; ssh login shell, foreground.
//   node scripts/app-walk-paired-records.mjs --dist <export built with EXPO_PUBLIC_VYRE_RELAY=ws://127.0.0.1:8791> --socket <home>/.vyre/vyred.sock [--out dir]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist-typed"));
const SOCKET = flag("--socket", "");
const OUT = path.resolve(flag("--out", "paired-records-out"));
if (!SOCKET) { console.error("give --socket"); process.exit(2); }
const HOME = path.dirname(SOCKET);
const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");
const box = (tool, input = {}, headers = {}) => new Promise((resolve) => {
  const body = JSON.stringify(input);
  const r = http.request({ socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": "cli", "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } }); });
  r.on("error", () => resolve({})); r.end(body);
});
const withYes = (tool, input) => {
  const p = spawnSync(process.execPath, [path.join(here, "dev-sign-proof.mjs"), "--home", HOME, "--yes", "pair", "--tool", tool, "--input", JSON.stringify(input), "--header"], { encoding: "utf8" });
  return box(tool, input, { "x-vyre-presence": p.stdout.trim() });
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1")) { req.socket.destroy(); return; }
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
await box("relay.status", {}, { "x-vyre-presence": "stand-in" });
const browser = await chromium.launch({ args: [...CHROME_SAFE] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", serviceWorkers: "block" });
const pg = await ctx.newPage();
const errors = []; pg.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
const text = async () => (await pg.locator("body").innerText()).replace(/\s+/g, " ");
const shot = (n) => pg.screenshot({ path: path.join(OUT, `${n}.png`) });
// 1. pair the browser by a typed code
await pg.goto(`${BASE}/u/install`, { waitUntil: "domcontentloaded" });
await pg.getByText("Type the code", { exact: false }).first().waitFor({ timeout: 40000 });
const o = await withYes("wink.phone.open", {});
if (!o.data?.code) { console.log("no code:", JSON.stringify(o).slice(0, 200)); process.exit(1); }
await pg.getByPlaceholder("WINK-7K4Q-M2XD").first().fill(o.data.code);
await pg.getByText("Use this code", { exact: true }).first().click();
await pg.waitForFunction(() => /Type this on your other device/.test(document.body.innerText), null, { timeout: 30000 });
const ack = ((await pg.locator("body").innerText()).match(/WINK-[0-9A-Z]{4}-[0-9A-Z]{4}/) || [])[0];
const a = await withYes("wink.code.ack", { offer: o.data.code_offer, typed: ack });
console.log("ack answered:", a.error ? JSON.stringify(a.error).slice(0, 160) : "yes");
await pg.waitForFunction(() => /Your spaces|Create a space|Paired, but|did not work|ran out|not right/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
console.log("after ack:", (await text()).slice(0, 300));
await shot("1-paired");
// A paired BROWSER is untrusted until its owner trusts it (the app's "Ask to trust", answered on the phone). The walk stands in for that answer by marking the row trusted in the throwaway home's database. TEST ONLY.
{ const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(path.join(HOME, "vyre.db")); db.exec("PRAGMA busy_timeout = 5000"); const n = db.prepare("UPDATE relay_devices SET trusted = 1 WHERE kind = 'web' AND removed_at IS NULL").run(); console.log("trusted browsers:", n.changes); db.close(); }
// 2. the records screens as that device
for (const [name, route] of [["2-records", "/u/records/contact"], ["3-customize", "/u/settings/customize"], ["4-now", "/u/now"]]) {
  await pg.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(6000);
  console.log(name, "->", (await text()).slice(0, 300));
  await shot(name);
}
if (errors.length) console.log("page errors:", errors.slice(0, 3).join(" | "));
await browser.close(); server.close(); process.exit(0);
