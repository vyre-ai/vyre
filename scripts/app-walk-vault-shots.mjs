#!/usr/bin/env node
// app-walk-vault-shots: the Vault as a person sees it, against a real vyred with real items (never the sample world); with --routes, any other route the same way. One picture per page at 1280 and 390, light and dark. TEST ONLY; ssh login shell, foreground.
//   node scripts/app-walk-vault-shots.mjs --dist apps/app/dist --socket <home>/.vyre/vyred.sock --out <dir> [--only 1280:dark] [--step 2,4c] [--seed] [--old] [--routes u/now,u/chats]
// --seed puts a handful of believable items in the vault first (vault.put with the dev stand-in), so a fresh box has something to draw.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist"));
const SOCKET = flag("--socket", "");
const OUT = path.resolve(flag("--out", "vault-shots-out"));
const ONLY = flag("--only", "");
const STEPS = (flag("--step", "") || "").split(",").filter(Boolean); // only these steps (by their number: 2,4c), for a re-draw
const ROUTES = (flag("--routes", "") || "").split(",").filter(Boolean); // draw these routes (u/now, u/chats) instead of the Vault's pages
const OLD = args.includes("--old"); // the layout before R031-76: its own labels, for before and after pictures
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

if (args.includes("--seed")) {
  const items = [
    { name: "juniper-drive", kind: "login", fields: { username: "kit@juniper.example", password: "correct-horse-battery-1" }, url: "https://drive.juniper.example", hosts: ["https://drive.juniper.example"] },
    { name: "northwind-crm", kind: "login", fields: { username: "alex@northwind.example", password: "Tr0ub4dor&3-nw" }, url: "https://crm.northwind.example", hosts: ["https://crm.northwind.example"] },
    { name: "mail", kind: "login", fields: { username: "alex@example.com", password: "password123" }, url: "https://mail.example.com", hosts: ["https://mail.example.com"] },
    { name: "stripe-live", kind: "api-key", description: "Juniper Studio Stripe", fields: { value: "sk_live_FAKEFAKEFAKEFAKE0001" }, hosts: ["https://api.stripe.com"] },
    { name: "openai-key", kind: "api-key", fields: { value: "sk-FAKEFAKEFAKEFAKEFAKE0002" }, hosts: ["https://api.openai.com"] },
    { name: "anthropic-key", kind: "api-key", fields: { value: "sk-ant-FAKEFAKEFAKE0003" }, hosts: ["https://api.anthropic.com"] },
    { name: "firm-card", kind: "card", fields: { number: "4242424242424242", expiry: "12/28", cvc: "123" } },
  ];
  for (const it of items) await box("vault.put", it, { "x-vyre-presence": "stand-in" });
  await box("vault.vaults.create", { name: "Acme-client" }, { "x-vyre-presence": "stand-in" });
}

// A dev sign-in lapses after a few minutes, so each width and theme signs in again (the proxy below reads the latest).
let TOKEN = "";
const signIn = async () => { TOKEN = (await box("signin.dev", { node: "vault-shots", label: "walk" })).data?.token ?? TOKEN; };
await signIn();
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
const errors = [];
for (const [w, h] of [[1280, 900], [390, 844]]) for (const theme of ["dark", "light"]) {
  if (ONLY && ONLY !== `${w}:${theme}`) continue;
  await signIn();
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, serviceWorkers: "block", reducedMotion: ROUTES.length ? "reduce" : "no-preference", deviceScaleFactor: w > 600 ? 1 : 2 });
  // The app is a native window, not a browser: stand in for the Mac shell so the screen is the one a person has (Add, Share and Reveal are there, not "on your phone").
  await ctx.addInitScript(() => { window.__vyreShell = { kind: "mac", identity: { has: async () => false, public: async () => "", sign: async () => "" }, presence: async () => "x", notify: async () => {}, open: async () => {}, onCommand: () => () => {} }; });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errors.push(`${w}:${theme} ${String(e.message).slice(0, 160)}`));
  const shot = async (n) => { await pg.waitForTimeout(700); await pg.screenshot({ path: path.join(OUT, `${n}-${w}-${theme}.png`), fullPage: w < 600 }); };
  const click = async (name, o = {}) => { const l = pg.getByRole(o.role ?? "button", { name, exact: o.exact ?? true }).first(); await l.click({ timeout: 8000 }); await pg.waitForTimeout(o.wait ?? 600); };
  const step = async (n, fn) => { if (STEPS.length && !STEPS.includes(n.split("-")[0])) return; try { await fn(); } catch (e) { console.log(`${w}:${theme} STEP ${n} FAILED: ${String(e.message).split("\n")[0]}`); await pg.screenshot({ path: path.join(OUT, `${n}-FAIL-${w}-${theme}.png`) }).catch(() => {}); } };
  const home = async () => { await pg.goto(`${BASE}/u/vault`, { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(3500); };

  const menu = async (item) => { await click("Add"); await pg.getByRole("menuitem", { name: item, exact: true }).first().click({ timeout: 8000 }); await pg.waitForTimeout(700); };
  const section = async (label) => { await pg.getByRole("button", { name: label, exact: true }).first().click({ timeout: 8000 }).catch(async () => { await pg.getByText(label, { exact: true }).first().click({ timeout: 8000 }); }); await pg.waitForTimeout(1500); };
  if (ROUTES.length) {
    for (const r of ROUTES) await step(r.replace(/\//g, "_"), async () => { await pg.goto(`${BASE}/${r}`, { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(3500); await shot(r.replace(/\//g, "_")); });
    await ctx.close(); continue;
  }
  await step("1-home", async () => { await home(); await shot("1-home"); });
  await step("2-item", async () => { if (OLD) await pg.getByRole("tab", { name: "Keys" }).first().click({ timeout: 8000 }).catch(() => {}); await pg.getByText(/^stripe.live$/i).first().click({ timeout: 8000 }); await pg.waitForTimeout(900); await shot("2-item"); });
  await step("3-add", async () => { await home(); if (OLD) await click("Add an item"); else await menu("Login"); await shot("3-add"); });
  if (!OLD) await step("3b-add-filled", async () => { await home(); await menu("Login"); await pg.getByLabel("Name", { exact: true }).first().fill("Juniper Drive"); await pg.getByLabel("Username", { exact: true }).first().fill("kit@juniper.example"); await pg.getByRole("button", { name: "Generate a strong one" }).first().click(); await shot("3b-add-filled"); });
  await step("4-sharing", async () => { await home(); await section(OLD ? "Passes" : "Sharing"); await shot("4-sharing"); });
  if (OLD) await step("4b-shared", async () => { await home(); await section("Shared"); await shot("4b-shared"); });
  if (!OLD) {
    await step("4c-vaults", async () => { await home(); await section("Sharing"); await pg.getByText("Acme-client").first().scrollIntoViewIfNeeded({ timeout: 8000 }); await pg.waitForTimeout(500); await shot("4c-vaults"); });
    await step("4d-new-vault", async () => { await home(); await section("Sharing"); await click("New shared vault"); await shot("4d-new-vault"); });
    await step("4e-invite", async () => { await home(); await section("Sharing"); await click("Invite"); await shot("4e-invite"); });
    await step("4f-accept", async () => { await home(); await section("Sharing"); await click("Accept a share"); await shot("4f-accept"); });
  }
  await step("5-browsers", async () => { await home(); await section(OLD ? "Devices" : "Browsers"); await shot("5-browsers"); });
  await step("6-health", async () => { await home(); await section("Health"); await shot("6-health"); });
  await step("7-import", async () => { await home(); if (OLD) await click("Import"); else await menu("Bring in from another app"); await shot("7-import"); });
  await ctx.close();
}
console.log("page errors:", errors.slice(0, 5).join(" | ") || "none");
await browser.close(); server.close(); process.exit(0);
