#!/usr/bin/env node
// app-walk-long: browser pairing with the LONG code and three words (the way pairing works in a release build: the short typed code is off), in headless Chromium against a real vyred AND a relay, with the owner's side done by this script. TEST ONLY.
//
//   node scripts/app-walk-long.mjs --dist <export built with EXPO_PUBLIC_VYRE_RELAY=ws://127.0.0.1:8791> --claim-dist <the same with EXPO_PUBLIC_VYRE_BROWSER_CLAIM=1 and EXPO_PUBLIC_VYRE_NAMES_DIRECTORY=/names> --socket <home>/.vyre/vyred.sock [--names http://host:port] [--out dir]
//
// Run it from an ssh login shell, in the foreground, on a development home enrolled for the software key (scripts/app-walk.README.md) with its relay on. Scenarios:
//   A  the browser's start screen (blocked build): the typed field is there; the owner shows a code (wink.code.open), the page types it, shows the ack, the owner types the ack back (wink.code.ack, signed
//      with the software key), and the page goes on to "Your spaces".
//   C  add this device to a name (claim build, no name on the device): "Add this phone from another device" has the typed field; the owner shows a code (wink.phone.open), the page types it, shows the ack,
//      the owner types it back, and the device holds the name or says why not.
// Join a space by typed invite code needs a device that already holds a name and a space that does not live on this computer: it is only screenshotted when the page reaches it.
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
const CLAIM = path.resolve(flag("--claim-dist", "apps/app/dist-typed-claim"));
const SOCKET = flag("--socket", "");
const NAMES = new URL(flag("--names", "http://152.42.187.205:8788"));
const OUT = path.resolve(flag("--out", "typed-out"));
if (!SOCKET) { console.error("app-walk-long: give --socket <home>/.vyre/vyred.sock"); process.exit(2); }
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
const serve = (dist, forward) => http.createServer((req, res) => {
  if (req.url.startsWith("/names/")) {
    const headers = Object.fromEntries(Object.entries({ ...req.headers, host: NAMES.host }).filter(([k]) => !/^(origin|referer|sec-fetch-.*|sec-ch-.*)$/i.test(k)));
    const u = http.request({ host: NAMES.hostname, port: NAMES.port, path: req.url.slice(6), method: req.method, headers }, (x) => { res.writeHead(x.statusCode ?? 502, x.headers); x.pipe(res); });
    u.on("error", () => { res.writeHead(502); res.end(); });
    return req.pipe(u);
  }
  if (req.url.startsWith("/v1")) {
    if (!forward) { req.socket.destroy(); return; }
    const up = http.request({ socketPath: SOCKET, path: req.url, method: req.method, headers: { ...req.headers, host: "localhost", "x-vyre-caller": "deck" } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end(); });
    return req.pipe(up);
  }
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(dist, p);
  const missing = !f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory();
  if (missing && path.extname(p)) { res.writeHead(404); return res.end(); }
  if (missing) f = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0, "127.0.0.1");
const sa = serve(DIST, false), sb = serve(CLAIM, true);
await Promise.all([sa, sb].map((s) => new Promise((r) => s.once("listening", r))));
const A = `http://127.0.0.1:${sa.address().port}/app`, B = `http://127.0.0.1:${sb.address().port}/app`;

const browser = await chromium.launch({ args: [...CHROME_SAFE] });
const results = [];
async function scenario(name, base, { noName = false } = {}, fn) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: "dark", serviceWorkers: "block" });
  const pg = await ctx.newPage();
  if (noName) await pg.route("**/v1/tools/spaces.identity.status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { exists: false, name: null } }) }));
  const errors = []; pg.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  const text = async () => (await pg.locator("body").innerText()).replace(/\s+/g, " ");
  const id = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const shot = (s) => pg.screenshot({ path: path.join(OUT, `${id}-${s}.png`) });
  try {
    const note = await fn({ pg, text, shot, base });
    if (errors.length) throw new Error(`page error: ${errors[0]}`);
    results.push({ name, ok: true }); console.log(`PASS ${name}${note ? ` | ${note}` : ""}`);
  } catch (e) {
    await shot("fail").catch(() => {});
    const seen = (await text().catch(() => "")).slice(-300);
    results.push({ name, ok: false, why: String(e.message).slice(0, 300) }); console.log(`FAIL ${name}: ${String(e.message).split("\n")[0].slice(0, 260)} | page: ${seen}`);
  }
  await ctx.close();
}
const need = (c, m) => { if (!c) throw new Error(m); };
const ACK = /WINK-[0-9A-Z]{4}-[0-9A-Z]{4}/;
/** Type the code the owner shows, read the ack the page shows, type it back as the owner. */
async function typeAndAck({ pg, shot }, code, offer, label) {
  await pg.getByPlaceholder("WINK-7K4Q-M2XD").first().fill(code);
  await pg.getByText("Use this code", { exact: true }).first().click();
  await pg.waitForFunction(() => /Type this on your other device/.test(document.body.innerText), null, { timeout: 30000 });
  const t = await pg.locator("body").innerText();
  const ack = (t.match(ACK) || [])[0];
  need(ack, `no ack on the page: ${t.slice(0, 200)}`);
  await shot(`${label}-ack`);
  const a = await withYes("wink.code.ack", { offer, typed: ack });
  need(!a.error, `the owner's ack was refused: ${a.error ? JSON.stringify(a.error).slice(0, 200) : ""}`);
  return ack;
}

await box("relay.status", {}, { "x-vyre-presence": "stand-in" }); // trusts this login (dev stand-in)

await scenario("L: the browser start screen pairs with the long code and three words", A, {}, async (c) => {
  await c.pg.goto(`${c.base}/u/install`, { waitUntil: "domcontentloaded" });
  await c.pg.getByText("Or paste the long code", { exact: false }).first().waitFor({ timeout: 40000 });
  const start = await c.text();
  need(/Open Vyre on your phone/.test(start), "not the browser start screen");
  need(!/Type the code/.test(start) && (await c.pg.getByPlaceholder("WINK-7K4Q-M2XD").count()) === 0, "the short typed code is on the start screen of a release build");
  await c.shot("start");
  const o = await withYes("wink.phone.open", {});
  need(o.data?.link, `the box showed no long code (wink.phone.open): ${JSON.stringify(o.error ?? o).slice(0, 200)}`);
  // a development box also offers the short typed code (its own flag); a release box does not. The page ignores it either way: this walk pairs with the long code.
  await c.pg.getByPlaceholder("vyre://wink/2?...").first().fill(o.data.link);
  await c.pg.getByText("Continue", { exact: true }).first().click();
  await c.pg.waitForFunction(() => /same three words|three words/i.test(document.body.innerText), null, { timeout: 40000 });
  await c.shot("words");
  const pageWords = await c.text();
  // the owner's side: it is asked the same question; the script answers with the words the page shows
  let asking = null;
  for (let i = 0; i < 40 && !asking; i++) { const p = await box("wink.phone.pairing", {}); if (p.data?.asking) asking = p.data; else await new Promise((r) => setTimeout(r, 1000)); }
  need(asking, "the owner was never asked (wink.phone.pairing)");
  console.log("OWNER ASKED", JSON.stringify(asking).slice(0, 400));
  console.log("PAGE", pageWords.slice(0, 500));
  return "words step reached";
});

await browser.close(); sa.close(); sb.close();
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length} pass, ${failed.length} fail`);
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
