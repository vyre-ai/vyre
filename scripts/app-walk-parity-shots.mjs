#!/usr/bin/env node
// app-walk-parity-shots: the chat as a person meets it, for the parity audit (team/0.3.1/CHAT-PARITY.md), on a real daemon with the fake claude: a rich turn, a message sent while the server is slow, the slash menu, a file dropped on the composer, on a real daemon of its own (never the sample world): "Chat about this" on a project and on a record (the button, then the new chat that names it)
// 1440 and 390 wide, light and dark. TEST BOX ONLY.
//   node scripts/app-walk-parity-shots.mjs --dist apps/app/dist [--out dir]
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
const OUT = path.resolve(flag("--out", "parity-shots"));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

// ---- a daemon of its own, with the fake claude, seeded
const used = new Set();
const presence = { check: async (q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-parity-shots-"));
const transcripts = path.join(root, "transcripts"); fs.mkdirSync(transcripts);
Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "shots-box", role: "box", transcripts: [transcripts], sessions: { install: false } }));
const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
const owner = d.kernel.id.owner;
const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
const TOKEN = (await d.kernel.surfaces.open(ownerChain, {})).token;
const COOKIE = d.registry.deps.cliSessions.startStandIn("parity-shots").token;         // the person's own session: a chat is started and spoken in by a person acting directly
const SOCKET = paths(root).socket;
const door = (tool, input) => new Promise((resolve) => { const body = JSON.stringify(input); const r = http.request({ socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": "cli", cookie: `__Host-vyre_person=${COOKIE}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (x) => { let o = ""; x.on("data", (c) => { o += c; }); x.on("end", () => { try { resolve(JSON.parse(o)); } catch { resolve({ error: { message: o.slice(0, 120) } }); } }); }); r.on("error", (e) => resolve({ error: { message: String(e.message) } })); r.end(body); });
const call = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: TOKEN }); if (r.error) throw new Error(`${tool}: ${r.error.message}`); return r.data; };
const chat = await d.kernel.gateway.grants.chats.create(ownerChain, {});
await call("work.chat.rename", { chat: chat.id, title: "Intake form date check" }).catch(() => {});
const sent = await door("stream.send", { chat: chat.id, text: "demo", message: "m-1", surface: "deck" });
console.log("send:", sent.error ? sent.error.message : "ok");
await new Promise((r) => setTimeout(r, 6000));
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
const must = (ok, what) => { if (!ok) { failed++; console.log("FAIL", what); } };
for (const scheme of (process.env.SCHEMES || "light,dark").split(",")) for (const [label, viewport] of SIZES) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  const pg = await ctx.newPage();
  pg.setDefaultTimeout(10000);
  pg.on("pageerror", (e) => console.log("page error:", String(e.message).slice(0, 200)));
  const shot = async (name, ms = 2500) => { await pg.waitForTimeout(ms); const text = (await pg.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200); console.log(`${name}-${label}-${scheme}:`, text); await pg.screenshot({ path: path.join(OUT, `${name}-${label}-${scheme}.png`) }); };
  await pg.goto(`${BASE}/u/now`, { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(5000);
  await pg.goto(`${BASE}/u/chats/${chat.id}`, { waitUntil: "domcontentloaded" });
  await shot("p1-rich-turn", 7000);
  const composer = pg.getByRole("textbox").last();
  // the slash menu
  await composer.click().catch(() => must(false, "no composer"));
  await pg.keyboard.type("/");
  await shot("p2-slash-menu", 1200);
  await pg.keyboard.type("mo");
  await shot("p2b-slash-menu-filtered", 800);
  await pg.keyboard.press("Escape");
  await composer.fill("");
  // a file dropped on the composer
  await pg.evaluate(() => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], "floorplan.png", { type: "image/png" }));
    const target = document.querySelector("textarea") || document.body;
    for (const t of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await shot("p3-file-dropped", 2000);
  must(/floorplan\.png/.test(await pg.locator("body").innerText()), "a dropped file does not show on the composer");
  await composer.click();
  await pg.getByText("Approve", { exact: true }).first().click({ timeout: 8000 }).catch(() => console.log("no Approve to press"));
  await shot("p5-after-approve", 7000);
  // instant send: the server is slow, the message is on screen at once
  await pg.route("**/v1/tools/stream.send", async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue(); });
  await composer.fill("and the other date?");
  const inThread = () => pg.evaluate(() => [...document.querySelectorAll("*")].some((e) => e.children.length === 0 && (e.textContent || "").trim() === "and the other date?" && !e.closest('textarea,[contenteditable],[role="textbox"]')));
  const t0 = Date.now();
  await pg.keyboard.press("Enter");
  let ms = -1;
  while (Date.now() - t0 < 3000) { if (await inThread()) { ms = Date.now() - t0; break; } await pg.waitForTimeout(10); }
  console.log(`instant-send-${label}-${scheme}: the message was in the thread after ${ms} ms with the server held for 3000 ms`);
  must(ms >= 0 && ms < 500, `the sent message took ${ms} ms to show in the thread`);
  await shot("p4-instant-send", 300);
  await pg.unroute("**/v1/tools/stream.send");
  await ctx.close();
}
await browser.close(); server.close(); await d.stop(); process.exit(failed ? 1 : 0);
