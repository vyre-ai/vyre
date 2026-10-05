#!/usr/bin/env node
// BROKEN since 0.2.9 (one way to pair): this walk pairs a browser by the relay.pair.start offer, which is gone. It needs to type the box's WINK code on the page's start screen (wink.phone.open, then the ack) like
// scripts/app-walk-paired-device.mjs does for a Node device. app-wire to move it.
// app-walk-paired: a browser PAIRED to a box through a relay (a device caller), asking for the owner's yes and answered by the STAND-IN PHONE (scripts/standin-phone.mjs). TEST ONLY.
//
//   node scripts/app-walk-paired.mjs --dist <web export> --socket <home>/.vyre/vyred.sock [--out dir]
//
// Run it from an ssh login shell, in the foreground, on a development-kind home enrolled with scripts/dev-enrol-software-key.mjs (see scripts/app-walk.README.md), whose relay is on (relay.enable at a relay the browser
// can reach: relay/node/server.js). The script: (1) trusts this login once (the stand-in header), (2) mints a pairing (relay.pair.start, signed with the software key), (3) opens the app at /pair?offer=... in
// headless Chromium and checks it paired, (4) adds a rule in the paired browser: the page says "Approve on your phone", the stand-in phone approves, the rule is listed, (5) says no to a second one and checks
// nothing was added. The page's own /v1 is NOT forwarded to the box: everything the paired browser does goes over the relay.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist"));
const SOCKET = flag("--socket", "");
const OUT = path.resolve(flag("--out", "paired-out"));
if (!SOCKET) { console.error("app-walk-paired: give --socket <home>/.vyre/vyred.sock"); process.exit(2); }
const HOME = path.dirname(SOCKET);
const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

const box = (tool, input = {}, headers = {}) => new Promise((resolve) => {
  const body = JSON.stringify(input);
  const r = http.request({ socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": "cli", "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({ error: { code: "bad_reply", message: s.slice(0, 100) } }); } }); });
  r.on("error", (e) => resolve({ error: { code: "unreachable", message: String(e.message) } })); r.end(body);
});
const withYes = (tool, input) => {
  const p = spawnSync(process.execPath, [path.join(here, "dev-sign-proof.mjs"), "--home", HOME, "--yes", "pair", "--tool", tool, "--input", JSON.stringify(input), "--header"], { encoding: "utf8" });
  if (p.status !== 0) throw new Error(p.stderr.trim());
  return box(tool, input, { "x-vyre-presence": p.stdout.trim() });
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  // Nothing at this origin answers /v1 (the connection is cut), like app.vyre.run: a paired browser reaches its box only through the relay.
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

function phone(answer, seconds) {
  const p = spawn(process.execPath, [path.join(here, "standin-phone.mjs"), "--home", HOME, "--answer", answer, "--seconds", String(seconds), "--once"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  return { kill: () => p.kill(), done: new Promise((r) => p.on("exit", () => r({ out: out.trim(), err: err.trim() }))) };
}

const results = [];
const check = async (name, fn) => {
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}${note ? ` | ${note}` : ""}`); }
  catch (e) { results.push({ name, ok: false, why: String(e.message).slice(0, 400) }); console.log(`FAIL ${name}: ${String(e.message).slice(0, 400)}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

await box("relay.status", {}, { "x-vyre-presence": "stand-in" }); // trusts this login for the session (dev stand-in)
const browser = await chromium.launch({ args: [...CHROME_SAFE] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: "dark", serviceWorkers: "block" });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
const text = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });

await check("the relay is on and the browser pairs by the offer", async () => {
  const st = await box("relay.status", {});
  assert(st.data?.enabled && st.data?.connected, `the box's relay is not on and connected: ${JSON.stringify(st)}`);
  const o = await withYes("relay.pair.start", {});
  assert(o.data?.url, `no pairing offer: ${JSON.stringify(o.error ?? o).slice(0, 200)}`);
  await page.goto(`${BASE}/pair?offer=${encodeURIComponent(o.data.url)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /Paired with|Nothing was|failed|did not/i.test(document.body.innerText), null, { timeout: 60000 });
  await shot("paired");
  const t = await text();
  assert(/Paired with/.test(t), `the page did not pair: ${t.slice(0, 200)}`);
  const dev = await box("relay.devices.list", {});
  const n = (dev.data?.devices ?? dev.data ?? []).length;
  assert(n >= 1, `the box lists no paired device: ${JSON.stringify(dev).slice(0, 200)}`);
  return `${t.slice(0, 60)}; devices on the box: ${n}`;
});

async function addRule(label) {
  await page.goto(`${BASE}/u/settings/rules`, { waitUntil: "domcontentloaded" });
  await page.getByText("Add a rule", { exact: true }).first().click({ timeout: 30000 }).catch(async (e) => { await shot("rules-fail"); throw new Error(`${String(e.message).split("\n")[0]} | page: ${(await text()).slice(0, 300)}`); });
  await page.getByLabel("Actions").first().fill("mail.send");
  await page.getByLabel("Name").first().fill(label);
  await page.getByText("Add the rule", { exact: true }).first().click();
}
await check("yes: the paired browser asks, the stand-in phone approves, the rule is added", async () => {
  const label = `Walk rule ${Date.now().toString(36).slice(-4)}`;
  const ph = phone("yes", 90);
  await addRule(label);
  await page.waitForFunction(() => /Approve on your phone/.test(document.body.innerText), null, { timeout: 30000 });
  await shot("asking");
  await page.waitForFunction((l) => document.body.innerText.includes(l), label, { timeout: 60000 });
  await shot("added");
  const said = await ph.done;
  return `phone: ${said.out.slice(0, 160) || said.err}`;
});
await check("no: the stand-in phone says no and nothing is added", async () => {
  const label = `Walk no ${Date.now().toString(36).slice(-4)}`;
  const ph = phone("no", 90);
  await addRule(label);
  await page.waitForFunction(() => /said no|not approved|Nothing changed/i.test(document.body.innerText), null, { timeout: 60000 });
  await shot("refused");
  assert(!(await text()).includes(label) || /said no|Nothing changed/i.test(await text()), "the rule shows as added");
  await ph.done;
  return "refused";
});
await browser.close(); server.close();
if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`);
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
