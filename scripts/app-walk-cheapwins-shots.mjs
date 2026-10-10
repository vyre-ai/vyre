#!/usr/bin/env node
// app-walk-cheapwins-shots: the chat cheap wins as a person meets them, on a real daemon of its own (never the sample world): "Chat about this" on a project and on a record (the button, then the new chat that names it)
// and "Link this chat to Northwind?" after a message that names a client. 1440 and 390 wide, light and dark. TEST BOX ONLY.
//   node scripts/app-walk-cheapwins-shots.mjs --dist apps/app/dist [--out dir]
import "./mac-test-guard.mjs";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { start } from "../core/daemon/index.js";
import { paths } from "../core/config/index.js";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";
import { canonical } from "../kernel/core/canonical.js";
import { FAKE } from "../core/sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist"));
const OUT = path.resolve(flag("--out", "cheapwins-shots"));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

// ---- a daemon of its own, with the fake claude, seeded
const used = new Set();
const presence = { check: async (q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-cheapwins-shots-"));
const transcripts = path.join(root, "transcripts"); fs.mkdirSync(transcripts);
Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "shots-box", role: "box", transcripts: [transcripts], sessions: { install: false } }));
const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
const owner = d.kernel.id.owner;
const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
const TOKEN = (await d.kernel.surfaces.open(ownerChain, {})).token;
const COOKIE = d.registry.deps.cliSessions.startStandIn("cheapwins-shots").token;         // the person's own session: a chat is started and spoken in by a person acting directly
const SOCKET = paths(root).socket;
const door = (tool, input) => new Promise((resolve) => { const body = JSON.stringify(input); const r = http.request({ socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": "cli", cookie: `__Host-vyre_person=${COOKIE}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (x) => { let o = ""; x.on("data", (c) => { o += c; }); x.on("end", () => { try { resolve(JSON.parse(o)); } catch { resolve({ error: { message: o.slice(0, 120) } }); } }); }); r.on("error", (e) => resolve({ error: { message: String(e.message) } })); r.end(body); });
const call = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: TOKEN }); if (r.error) throw new Error(`${tool}: ${r.error.message}`); return r.data; };
const lib = await call("work.template.install", { id: "law-firm/estate-plan" });
await call("work.template.golive", { template: lib.template, version: lib.version });
const proj = await call("work.start-project", { template: lib.template, name: "Rivera Family Trust", repo: "" });
const PROJECT = String(proj.project).split("/").pop();
const client = await d.kernel.gateway.records.create(ownerChain, "organization", { name: "Northwind Bakery" });
const RECORD = String(client.urn || client.id || "").split("/").pop();
console.log("record:", client.urn || client.id);
const chat = await d.kernel.gateway.grants.chats.create(ownerChain, {});
await call("work.chat.rename", { chat: chat.id, title: "Northwind lease letter" }).catch(() => {});
const sent = await door("stream.send", { chat: chat.id, text: "Can you draft the lease letter for Northwind Bakery?", message: "m-1", surface: "deck" });
console.log("send:", sent.error ? sent.error.message : "ok");
await new Promise((r) => setTimeout(r, 4000));
// ---- the app in front of it
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1/events/stream")) { res.writeHead(404); return res.end(); }   // the sample stream of events is not part of this walk (it keeps a connection open per page)
  if (req.url.startsWith("/v1")) {
    const up = http.request({ socketPath: SOCKET, path: req.url, method: req.method, headers: { ...req.headers, host: "localhost", "x-vyre-caller": "cli", cookie: `__Host-vyre_person=${COOKIE}` } }, (r) => { if (process.env.TRACE || (r.statusCode || 0) >= 400) console.log("door:", r.statusCode, req.url.slice(0, 80)); res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    up.on("error", (e) => { console.log("proxy error:", req.url, String(e.message).slice(0, 80)); res.writeHead(502); res.end(); });
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
server.on("upgrade", (req, client, head) => {
  const up = net.createConnection({ path: SOCKET });
  const headers = { ...req.headers, host: "localhost", "x-vyre-caller": "cli", cookie: `__Host-vyre_person=${COOKIE}` };
  delete headers.origin;
  up.on("connect", () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    if (head && head.length) up.write(head);
    up.pipe(client); client.pipe(up);
  });
  up.on("error", () => client.destroy()); client.on("error", () => up.destroy());
});
const browser = await chromium.launch({ args: [...CHROME_SAFE] });
const SIZES = [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]];
let failed = 0;
for (const scheme of (process.env.SCHEMES || "light,dark").split(",")) for (const [label, viewport] of SIZES) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  const pg = await ctx.newPage();
  pg.setDefaultTimeout(10000);
  pg.on("requestfailed", (r) => console.log("request failed:", r.url().slice(0, 90), r.failure()?.errorText));
  pg.on("pageerror", (e) => console.log("page error:", String(e.message).slice(0, 200)));
  const shot = async (name, ms = 2500) => { await pg.waitForTimeout(ms); const text = (await pg.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 220); console.log(`${name}-${label}-${scheme}:`, text); await pg.screenshot({ path: path.join(OUT, `${name}-${label}-${scheme}.png`) }); };
  const must = (ok, what) => { if (!ok) { failed++; console.log("FAIL", what); } };
  await pg.goto(`${BASE}/u/now`, { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(5000);   // the app starts and signs in before the first screen asks
  // the button is "Chat about this" on a wide screen and "Chat" on a phone; it opens the new-chat screen that names the project or record.
  // (Pressing Start there needs this browser to be a device with a private-chat key, which a walk's stand-in session is not; the link a started chat makes is proven in core/work/work.test.js.)
  const button = () => pg.getByRole("button", { name: /^Chat( about this)?$/ }).first();
  for (const [what, route, names] of [["project", `/u/project/${PROJECT}`, "Rivera Family Trust"], ["record", `/u/record/${RECORD}`, "Northwind Bakery"]]) {
    await pg.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    await button().waitFor({ timeout: 20000 }).catch(() => must(false, `${what}: no Chat about this button`));
    await shot(`c4-${what}-button`, 1500);
    await button().click({ timeout: 20000 }).catch(() => must(false, `${what}: the button cannot be pressed`));
    await pg.getByText(`This chat is about ${names}.`).first().waitFor({ timeout: 20000 }).catch(() => must(false, `${what}: the new chat does not say it is about ${names}`));
    await shot(`c4-${what}-new-chat`, 800);
  }
  await pg.goto(`${BASE}/u/chats/${chat.id}`, { waitUntil: "domcontentloaded" });
  await pg.getByText("Link this chat to Northwind Bakery?", { exact: true }).first().waitFor({ timeout: 20000 }).catch(() => must(false, "no link suggestion after a message that names Northwind Bakery"));
  await shot("c6-link-suggestion", 800);
  await pg.getByRole("button", { name: "Link" }).first().click().catch(() => must(false, "no Link button"));
  await shot("c6-linked", 1500);
  const linked = await call("work.timeline", { record: String(client.urn) });
  must(JSON.stringify(linked).includes(chat.id), "after Link the chat is not on Northwind's timeline");
  await ctx.close();
}
await browser.close(); server.close(); await d.stop(); process.exit(failed ? 1 : 0);
