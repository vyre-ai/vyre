// @ts-check
// platform's section 5 test for the camera page's hand-off, in real Chrome: `https://app.vyre.run/#pair=<ticket>`.
// The hosted app's loader (the real, sealed one) must (1) clear the fragment before any network call, (2) send nothing
// anywhere but the relay (no request to wink.vyre.run or any other host), and (3) not put the ticket in any URL.
// The relay is stood in for by Chrome's own request interception (Fetch.requestPaused): at the very moment the first
// outbound request is held, the page's own address is read. Run on a throwaway runner with CHROME set, never a Mac.
// The device key made at the app origin (and nothing at wink) holds by construction (the loader pairs with its own
// IndexedDB key store and imports nothing of wink's); this test does not run a real pairing to the end.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { CHROME_SAFE } from "../../../lib/chrome-flags/index.js";
import { keygen, loader } from "../release.js";
import worker from "../worker.js";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("set CHROME to a Chrome binary"); process.exit(3); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-pairfrag-"));
const key = path.join(tmp, "release.key");
keygen(key);
const out = path.join(tmp, "out");
await loader({ release: "1.0.0", key, out });

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html; charset=utf-8", ".css": "text/css", ".json": "application/json" };
const env = { ASSETS: { fetch: async req => {
  const p = new URL(req.url).pathname;
  const f = path.join(out, p === "/" ? "index.html" : p);
  return f.startsWith(out) && fs.existsSync(f) && fs.statSync(f).isFile() ? new Response(fs.readFileSync(f), { headers: { "content-type": TYPES[path.extname(f)] || "application/octet-stream" } }) : new Response("missing", { status: 404 });
} } };
/** @type {string[]} */ const localRequests = [];
const server = http.createServer(async (rq, rs) => {
  localRequests.push(`${rq.method} ${rq.url}`);
  const r = await worker.fetch(new Request(`http://localhost:${port}${rq.url}`), env);
  rs.writeHead(r.status, Object.fromEntries(r.headers)); rs.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
const port = /** @type {any} */ (server.address()).port;

const dbg = 9700 + Math.floor(Math.random() * 200);
const c = spawn(CHROME, [...CHROME_SAFE, "--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${dbg}`, `--user-data-dir=${path.join(tmp, "profile")}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); const pg = l.find(x => x.type === "page"); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(500); }
if (!ws) { console.log("Chrome did not start"); process.exit(1); }
await new Promise(r => ws.addEventListener("open", r));
let id = 0; const waits = new Map(); /** @type {any[]} */ const paused = [];
ws.addEventListener("message", e => {
  const m = JSON.parse(String(e.data));
  if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  if (m.method === "Fetch.requestPaused") paused.push(m.params);
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;

// Hold every request that is not to this page's own origin (the relay and anything else), so the page's address can be read at that moment.
await send("Page.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "http*://*", requestStage: "Request" }] });
const ticket = Buffer.from("0123456789abcdef", "latin1").subarray(0, 8).toString("base64url");
await send("Page.navigate", { url: `http://localhost:${port}/#pair=${ticket}` });

/** @type {Array<{ url: string, method: string, body: string, pageAddress: string }>} */ const outbound = [];
const end = Date.now() + 30000;
let settled = 0;
while (Date.now() < end && settled < 6) {
  while (paused.length) {
    const p = paused.shift();
    const u = new URL(p.request.url);
    // Only what the page itself asked for counts: Chrome's own background requests carry no frame.
    if (!p.frameId) { await send("Fetch.continueRequest", { requestId: p.requestId }); continue; }
    if (u.origin === `http://localhost:${port}`) { await send("Fetch.continueRequest", { requestId: p.requestId }); continue; }
    outbound.push({ url: p.request.url, method: p.request.method, body: p.request.postData || "", pageAddress: String(await evalIn("location.href")) });
    await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 404, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "access-control-allow-origin", value: "*" }], body: Buffer.from("{}").toString("base64") });
  }
  await sleep(500);
  if (outbound.length) settled++;
}
const addressAfter = String(await evalIn("location.href"));
const statusText = String(await evalIn("document.getElementById('vyre-status') ? document.getElementById('vyre-status').textContent : ''"));
c.kill(); server.close();

const failures = [];
const relay = outbound.filter(o => /^https:\/\/relay\.vyre\.run\//.test(o.url));
const elsewhere = outbound.filter(o => !/^https:\/\/relay\.vyre\.run\//.test(o.url));
if (!relay.length) failures.push("the loader never asked the relay to resolve the ticket");
for (const o of relay) {
  if (o.pageAddress.includes("#") || o.pageAddress.includes(ticket)) failures.push(`the fragment was still in the address at the first relay request: ${o.pageAddress}`);
  if (o.url.includes(ticket)) failures.push("the ticket is in a URL");
}
if (elsewhere.length) failures.push(`something other than the relay was contacted: ${elsewhere.map(o => o.url).join(", ")}`);
if (relay.some(o => o.method !== "POST" || !/\/v1\/pair$/.test(o.url))) failures.push("the relay was asked for something other than POST /v1/pair first");
if (addressAfter.includes("#pair") || addressAfter.includes(ticket)) failures.push(`the ticket is still in the address: ${addressAfter}`);
if (localRequests.some(r => r.includes(ticket))) failures.push("the ticket reached the page's own server");
console.log(JSON.stringify({ relayRequests: relay.map(o => [o.method, o.url, o.pageAddress]), elsewhere: elsewhere.map(o => o.url), addressAfter, statusText }, null, 2));
if (failures.length) { console.log("THE HAND-OFF DID NOT HOLD:\n- " + failures.join("\n- ")); process.exit(1); }
console.log("The fragment was cleared before the first request, only the relay was contacted, and the ticket was in no URL.");
await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
