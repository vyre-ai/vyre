#!/usr/bin/env node
// app-walk-records-ui: the Records screens as the box's owner (a stand-in person session): define a type in Customize (text, choice, link, sealed), add two records, open the list, the board and a record with its
// sealed field. One screenshot per step; prints what each screen says. TEST ONLY; ssh login shell, foreground.
//   node scripts/app-walk-records-ui.mjs --dist apps/app/dist-fr --socket <home>/.vyre/vyred.sock [--out dir]
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist-fr"));
const SOCKET = flag("--socket", "");
const OUT = path.resolve(flag("--out", "chat-out"));
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
const TOKEN = (await box("signin.dev", { node: "chat-walk", label: "walk" })).data?.token ?? "";
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
// The chat stream is a WebSocket: carry the upgrade to the box's socket, with the same caller and person cookie as the plain calls.
server.on("upgrade", (req, client, head) => {
  const up = net.createConnection({ path: SOCKET });
  const headers = { ...req.headers, host: "localhost", "x-vyre-caller": "cli", ...(TOKEN ? { cookie: `__Host-vyre_person=${TOKEN}` } : {}) };
  delete headers.origin;
  up.on("connect", () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    if (head && head.length) up.write(head);
    up.pipe(client); client.pipe(up);
  });
  up.on("error", () => client.destroy()); client.on("error", () => up.destroy());
});
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}/app`;
const browser = await chromium.launch({ args: [...CHROME_SAFE] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", serviceWorkers: "block" });
const pg = await ctx.newPage();
const errors = []; pg.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
// Every refused tool call, by name, so a wrong call is seen where it is made.
const refused = [];
pg.on("response", async (r) => { const u = r.url(); if (!/\/v1\/tools\//.test(u)) return; try { const j = await r.json(); if (j && j.error) refused.push(`${u.split("/v1/tools/")[1].split("?")[0]}: ${j.error.code} ${String(j.error.message).slice(0, 90)}`); } catch {} });
const text = async () => (await pg.locator("body").innerText()).replace(/\s+/g, " ");
const say = async (n) => { console.log(`${n}: ${(await text()).slice(0, 320)}`); await pg.screenshot({ path: path.join(OUT, `${n}.png`) }); };
const click = async (t, o = {}) => { await pg.getByText(t, { exact: o.exact ?? true }).first().click({ timeout: 15000 }); await pg.waitForTimeout(o.wait ?? 900); };
const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`STEP ${n} FAILED: ${String(e.message).split("\n")[0]}`); await pg.screenshot({ path: path.join(OUT, `${n}-fail.png`) }).catch(() => {}); } };
const go = async (route, ms = 4000) => { await pg.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(ms); };


let failed = 0;
const fail = (m) => { failed++; console.log("FAIL", m); };
const has = async (re, label) => { const t = await text(); if (!re.test(t)) { fail(`${label}: not on screen: ${re} | ${t.slice(0, 200)}`); return false; } return true; };
await step("1-chats-list", async () => {
  await go("/u/chats");
  await say("1-chats-list");
  if ((await text()).includes("Update your server to use Chats")) fail("the box does not have work.chat.list");
});
let chatUrl = "";
await step("2-new-chat", async () => {
  await go("/u/chats/new");
  await say("2-new-chat-open");
  await click("Start chat", { wait: 3500 });
  await say("2-new-chat-opened");
  chatUrl = pg.url();
  if (!/\/u\/chats\/[^/]+$/.test(chatUrl) || /\/new$/.test(chatUrl)) fail(`the new chat did not open: ${chatUrl}`);
});
await step("3-send", async () => {
  const box = pg.getByLabel("Message").first();
  await box.fill("hello from the walk");
  await pg.keyboard.press("Enter");
  await pg.waitForTimeout(6000);
  await say("3-send");
  await has(/echo: hello from the walk/i, "the reply");
});
await step("4-in-this-chat", async () => {
  await pg.getByLabel(/In this chat/).first().click({ timeout: 10000 });
  await pg.waitForTimeout(1200);
  await say("4-in-this-chat");
  await has(/In this chat/, "the sheet");
  const t = await text();
  if (/\b(session|thread|room|fan-?out)\b/i.test(t)) fail(`a banned word is on screen: ${t.match(/\b(session|thread|room|fan-?out)\b/i)[0]}`);
});
await step("5-list-again", async () => { await go("/u/chats"); await say("5-list-again"); await has(/hello from the walk|New chat|echo/i, "the new chat in the list"); });
console.log("refused calls:", refused.slice(0, 8).join(" | "));
console.log("page errors:", errors.slice(0, 3).join(" | "));
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
