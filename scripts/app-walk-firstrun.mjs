#!/usr/bin/env node
// app-walk-firstrun: the first-run screens (welcome, browser start, Who it is for, the Wink codes, the empty landing screens) in headless Chromium against a real vyred.
//
//   node scripts/app-walk-firstrun.mjs --dist <web export> --claim-dist <export built with EXPO_PUBLIC_VYRE_BROWSER_CLAIM=1> --socket <vyred.sock> [--out dir] [--caller cli]
//
// One screenshot per screen, and a check per screen for its words. A console or page error fails the step. Exit 0 when nothing failed. TEST ONLY: use a test box.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist"));
const CLAIM = path.resolve(flag("--claim-dist", flag("--dist", "apps/app/dist")));
const SOCKET = flag("--socket", "");
const CALLER = flag("--caller", "cli");
const OUT = path.resolve(flag("--out", "firstrun-out"));
if (!SOCKET) { console.error("app-walk-firstrun: give --socket <vyred.sock>"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
function serve(dist) {
  return http.createServer((req, res) => {
    if (req.url.startsWith("/v1")) {
      // The dev box's hand-made stand-in answers the proof these two ask for (method "stand-in", honoured only on a development build).
      const tool = /^\/v1\/tools\/([^/?#]+)/.exec(req.url)?.[1] ?? "";
      const proof = /^(wink\.phone\.open|spaces\.invites\.create)$/.test(tool) ? { "x-vyre-presence": "stand-in" } : {};
      const up = http.request({ socketPath: SOCKET, path: req.url, method: req.method, headers: { ...req.headers, ...proof, host: "localhost", "x-vyre-caller": CALLER } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
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
}
const a = serve(DIST), b = serve(CLAIM);
await Promise.all([a, b].map((s) => new Promise((r) => s.once("listening", r))));
const BASE = `http://127.0.0.1:${a.address().port}/app`, CBASE = `http://127.0.0.1:${b.address().port}/app`;

const browser = await chromium.launch({ args: [...CHROME_SAFE] });
const results = [];
async function step(name, { base = BASE, mac = false, width = 420, route, noName = false, fakeOpen = false, fakeInvite = false }, fn) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark", serviceWorkers: "block" });
  // The Mac app's window puts window.__vyreShell on the page; this stands in for it so the page takes the Mac's first run.
  if (mac) await ctx.addInitScript(() => { window.__vyreShell = { kind: "mac", presence: async () => "x", notify: async () => {}, open: async () => {}, onCommand: () => () => {} }; });
  const pg = await ctx.newPage();
  // A first run is a device with no name: the box's own owner is hidden from the page for the steps that start there.
  if (noName) await pg.route("**/v1/tools/spaces.identity.status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { exists: false, name: null } }) }));
  const errors = [];
  // STAND-IN: wink.phone.open needs a person's own proof, which a headless page cannot give (the dev stand-in does not cover it). The walk answers it with a made-up code so the screen that draws it can be seen.
  if (fakeOpen) await pg.route("**/v1/tools/wink.phone.open", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { qr: "vyre://wink/2?t=SGVsbG9TYW1wbGVTZWNyZQ&r=wss%3A%2F%2Frelay.example&k=phone", expires: Date.now() + 300000 } }) }));
  // STAND-IN: awbox's spaces live on this computer, and the box refuses invitations to such a space (this_computer). The walk answers spaces.invites.create with a made-up invitation so the card that draws it can be seen.
  if (fakeInvite) await pg.route("**/v1/tools/spaces.invites.create", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { id: "inv_walk", link: "https://harlow.vyre.run/join/SGVsbG9TYW1wbGVJbnZpdGU", valid_until: Date.now() + 7 * 864e5, needs_confirm: false } }) }));
  pg.on("response", async (r) => { if (/wink\.phone\.open/.test(r.url())) console.log("  wink.phone.open ->", r.status(), (await r.text().catch(() => "")).slice(0, 160)); });
  pg.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  const shot = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  try {
    await pg.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(3500);
    const text = async () => (await pg.locator("body").innerText()).replace(/\s+/g, " ");
    await fn(pg, text);
    await pg.screenshot({ path: path.join(OUT, `${shot}.png`) });
    if (errors.length) throw new Error(`page error: ${errors[0]}`);
    results.push({ name, ok: true }); console.log(`PASS ${name}`);
  } catch (e) {
    await pg.screenshot({ path: path.join(OUT, `${shot}-fail.png`) }).catch(() => {});
    const seen = (await pg.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(-420);
    results.push({ name, ok: false, why: String(e.message).slice(0, 300), seen }); console.log(`FAIL ${name}: ${String(e.message).split("\n")[0].slice(0, 200)} | page: ${seen}`);
  }
  await ctx.close();
}
const need = (t, re, what) => { if (!re.test(t)) throw new Error(`${what}: ${t.slice(0, 220)}`); };

await step("browser start: Open Vyre on your phone", { route: "/u/install?fresh=1" }, async (pg, text) => {
  const t = await text();
  // The page may open on a signed-in box; the walk asks for the step by its words and says what it saw otherwise.
  need(t, /Open Vyre on your phone/, "no browser start");
  need(t, /Devices, then Add a device, and scan or paste its code here/, "browser copy is not the ruled sentence");
  if (/curl|install line/i.test(t)) throw new Error("the browser shows a command");
});
await step("browser: set up Vyre first", { route: "/u/install" }, async (pg, text) => {
  await pg.getByText("Vyre is not set up yet?", { exact: true }).first().click();
  await pg.waitForTimeout(500);
  const t = await text();
  need(t, /Set up Vyre on a computer or server first/, "no not-set-up screen");
  need(t, /Open vyre\.run/, "no Open vyre.run button");
  if (/curl|\| sh/.test(t)) throw new Error("a command is shown");
});
await step("welcome (claim build)", { base: CBASE, route: "/u/install", noName: true }, async (pg, text) => {
  need(await text(), /Your assistants, your people and your work, in one place you control\./, "no welcome line");
  need(await text(), /Get started/, "no Get started");
  need(await text(), /I already have Vyre/, "no I already have Vyre");
});
await step("welcome to name", { base: CBASE, route: "/u/install", noName: true }, async (pg, text) => {
  await pg.getByText("Get started", { exact: true }).first().click();
  await pg.waitForTimeout(500);
  need(await text(), /Choose your Vyre name/, "no name step");
});
await step("create a space asks who it is for", { base: CBASE, route: "/u/install/create" }, async (pg, text) => {
  const t = await text();
  need(t, /Who it is for/, "no Who it is for");
  await pg.getByText("Just me", { exact: true }).first().click();
  need(await text(), /Setup skips inviting people/, "the personal line did not show");
});
await step("add a phone shows a Wink code, not a QR", { route: "/u/install/phone", fakeOpen: true }, async (pg, text) => {
  await pg.waitForTimeout(2500);
  const t = await text();
  need(t, /Add your phone/, "no Add your phone");
  need(t, /Add your device/, "no Wink kind words");
  if (!(await pg.locator("svg").count())) throw new Error("no drawn code");
});
await step("invite shows a Wink code, Copy link and Email it", { route: "/u/wink/invite", width: 1000, fakeInvite: true }, async (pg, text) => {
  const t = await text();
  need(t, /Invite someone/, "no invite page");
  await pg.getByText("Anyone with the link", { exact: true }).first().click();
  await pg.getByText("Make the invitation", { exact: true }).first().click();
  await pg.getByText("The invitation is ready").first().waitFor({ timeout: 15000 });
  const r = await text();
  need(r, /Join /, "no Join <space> words on the code");
  need(r, /Copy link/, "no Copy link");
  need(r, /Email it/, "no Email it");
  if (!(await pg.locator("svg").count())) throw new Error("no drawn code");
});
await step("Chats empty state says one thing and gives one action", { route: "/chats" }, async (pg, text) => {
  const t = await text();
  if (!/Chats/.test(t)) throw new Error(`no chats page: ${t.slice(0, 200)}`);
});
await browser.close(); a.close(); b.close();
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
