// @ts-check
// The passkey page's claim retry in a real browser (#23): a fresh Chrome profile opens the claim link, the box
// (a stand-in that answers like relay.setup.claim) refuses the first try, and the person must be able to Try again
// from the page, reload it without losing the link, and reach "Add a passkey". Run on a throwaway runner with CHROME set.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("set CHROME to a Chrome binary"); process.exit(3); }
const DECK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-claim-"));
const TYPES = { ".js": "text/javascript", ".html": "text/html; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };
let claimCalls = 0;
/** @type {any[]} */ const reports = [];

const server = http.createServer(async (rq, rs) => {
  const url = new URL(rq.url || "/", "http://localhost");
  if (url.pathname === "/__report") { let b = ""; for await (const c of rq) b += c; reports.push(JSON.parse(b)); rs.end("ok"); return; }
  if (url.pathname === "/v1/tools/relay.setup.claim") {
    let b = ""; for await (const c of rq) b += c;
    claimCalls++;
    rs.setHeader("content-type", "application/json");
    if (claimCalls === 1) { rs.statusCode = 403; rs.end(JSON.stringify({ error: { code: "denied", message: "that claim is not valid" } })); return; }
    rs.end(JSON.stringify({ data: { grant: "g".repeat(43), expires: Date.now() + 300000, rpId: "localhost" } })); return;
  }
  if (url.pathname.startsWith("/v1/")) { rs.setHeader("content-type", "application/json"); rs.end(JSON.stringify({ data: {} })); return; }
  let p = url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname;
  if (p === "/onboard/passkey") p = "/onboard/passkey/index.html";
  const f = path.join(DECK, p);
  if (f.startsWith(DECK) && fs.existsSync(f) && fs.statSync(f).isFile()) { rs.setHeader("content-type", TYPES[path.extname(f)] || "application/octet-stream"); rs.end(fs.readFileSync(f)); return; }
  rs.statusCode = 404; rs.end("missing");
});
await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
const port = /** @type {any} */ (server.address()).port;

// A tiny driver over Chrome's remote debugging port, so the test can read the page and click.
const dbg = 9300 + Math.floor(Math.random() * 400);
const c = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${dbg}`, `--user-data-dir=${path.join(tmp, "profile")}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); const pg = l.find(x => x.type === "page"); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(500); }
if (!ws) { console.log("Chrome did not start"); process.exit(1); }
await new Promise(r => ws.addEventListener("open", r));
let id = 0; const waits = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const text = async () => (await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true })).result.result.value || "";
const waitFor = async (re, ms = 15000) => { const end = Date.now() + ms; let t = ""; while (Date.now() < end) { t = await text(); if (re.test(t)) return t; await sleep(300); } return t; };
const click = label => send("Runtime.evaluate", { expression: `[...document.querySelectorAll("button,a")].find(b => b.textContent.trim() === ${JSON.stringify(label)})?.click()` });

const failures = [];
const base = `http://localhost:${port}/onboard/passkey`;
const link = `${base}#claim=${"A".repeat(128)}&spki=${"B".repeat(91)}`;
await send("Page.enable");
await send("Page.navigate", { url: link });
let t = await waitFor(/This link did not work/);
if (!/This link did not work/.test(t)) failures.push("the first refusal did not show the failure page: " + t.slice(0, 120));
if (!/Get a new link/.test(t) || !/Try again/.test(t)) failures.push("the failure page has no way on (Try again, Get a new link)");
// reload: the link is kept for this tab, so the page tries it again and gets through
await send("Page.reload");
t = await waitFor(/Add a passkey/);
if (!/Add a passkey/.test(t)) failures.push("a reload stranded the person: " + t.slice(0, 120));
// and Try again works from the failure page itself
claimCalls = 0;
await send("Page.navigate", { url: link + "x" });
await waitFor(/This link did not work/);
await click("Try again");
t = await waitFor(/Add a passkey/);
if (!/Add a passkey/.test(t)) failures.push("Try again did not recover: " + t.slice(0, 120));
c.kill(); server.close();
console.log(JSON.stringify({ claimCalls, failures }, null, 2));
if (failures.length) { console.log("THE CLAIM RETRY DID NOT HOLD:\n- " + failures.join("\n- ")); process.exit(1); }
console.log("A refused claim shows Try again and Get a new link, a reload keeps the link, and Try again reaches the passkey step.");
await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
