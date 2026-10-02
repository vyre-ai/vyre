// @ts-check
// platform's section 5 test for the camera page's hand-off, in real Chrome: `https://app.vyre.run/#pair=<ticket>`.
// The hosted app's loader (the real, sealed one) must (1) clear the fragment before any network call, (2) send nothing
// anywhere but the relay (no request to wink.vyre.run or any other host), and (3) not put the ticket in any URL.
// The relay is the REAL relay Worker, run locally by wrangler (relay/app/testing/real-relay.mjs), with a real ticket a box registered
// on it. Chrome's request interception sends the page's https://relay.vyre.run/v1/pair to it, and a host rule keeps any socket to
// relay.vyre.run on this machine, so nothing reaches the real internet. A hostile link (someone else's ticket) must show the confirm
// card and pair NOTHING without the tap: one lookup (which uses the ticket up, as the real relay does), no socket, no device key.
// Not now pairs nothing either; only the tap on Pair makes the key and opens the pairing channel; and a record that names another relay
// is refused with no card. Run on a throwaway runner with CHROME set, never a Mac.
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
import { startRelay, registerTicket } from "./real-relay.mjs";

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
const relay = await startRelay(8800 + Math.floor(Math.random() * 90));
const server = http.createServer(async (rq, rs) => {
  localRequests.push(`${rq.method} ${rq.url}`);
  const r = await worker.fetch(new Request(`http://localhost:${port}${rq.url}`), env);
  rs.writeHead(r.status, Object.fromEntries(r.headers)); rs.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
const port = /** @type {any} */ (server.address()).port;

const dbg = 9700 + Math.floor(Math.random() * 200);
const c = spawn(CHROME, [...CHROME_SAFE, "--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${dbg}`, "--host-resolver-rules=MAP relay.vyre.run 127.0.0.1", `--user-data-dir=${path.join(tmp, "profile")}`, "about:blank"], { stdio: "ignore" });
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

const sockets = [];
ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.method === "Network.webSocketCreated") sockets.push(m.params.url); });
await send("Page.enable");
await send("Network.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "http*://*", requestStage: "Request" }] });

const clickButton = label => evalIn(`(() => { const b = [...document.querySelectorAll("#vyre-loader button")].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (b) { b.click(); return true; } return false; })()`);
const loaderText = () => evalIn("document.getElementById('vyre-loader') ? document.getElementById('vyre-loader').innerText : ''");
const keyDatabases = async () => String(await evalIn("indexedDB.databases ? indexedDB.databases().then(d => JSON.stringify(d.map(x => x.name))) : '[]'"));
/** @type {Array<{ url: string, method: string, pageAddress: string }>} */ const outbound = [];
/** Send the page's relay lookups to the real relay Worker; refuse anything else it asks outside its own origin. */
async function pump(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    while (paused.length) {
      const p = paused.shift();
      const u = new URL(p.request.url);
      if (!p.frameId || u.origin === `http://localhost:${port}`) { await send("Fetch.continueRequest", { requestId: p.requestId }); continue; }
      outbound.push({ url: p.request.url, method: p.request.method, pageAddress: String(await evalIn("location.href")) });
      if (u.origin === "https://relay.vyre.run" && u.pathname === "/v1/pair") await send("Fetch.continueRequest", { requestId: p.requestId, url: `${relay.url}/v1/pair` });
      else await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 404, body: "" });
    }
    await sleep(300);
  }
}

const failures = [];
const note = (ok, why) => { if (!ok) failures.push(why); };
const resolveDirect = loc => fetch(`${relay.url}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });

// 1. A hostile link: someone else's ticket. One lookup, the card, and nothing paired without the tap.
const t1 = await registerTicket(relay.url);
await send("Page.navigate", { url: `http://localhost:${port}/#pair=${t1.ticket}` });
await pump(8000);
const card = String(await loaderText());
const addressAfter = String(await evalIn("location.href"));
const asks = outbound.filter(o => /^https:\/\/relay\.vyre\.run\/v1\/pair$/.test(o.url));
note(/says it is alex\.vyre\.run/.test(card), `the confirm card did not say who it claims to be: ${card.slice(0, 160)}`);
note(/fingerprint is [a-z2-7 ]{9}/.test(card), "the confirm card shows no key fingerprint");
note(!addressAfter.includes("#") && !addressAfter.includes(t1.ticket), `the ticket is still in the address: ${addressAfter}`);
note(asks.length === 1 && asks[0].method === "POST", `the loader should look the ticket up exactly once with POST /v1/pair, saw ${asks.length}`);
note(asks.every(o => !o.pageAddress.includes("#")), "the fragment was still in the address at the relay lookup");
note(outbound.every(o => /^https:\/\/relay\.vyre\.run\//.test(o.url)), `something other than the relay was contacted: ${outbound.filter(o => !/^https:\/\/relay\.vyre\.run\//.test(o.url)).map(o => o.url)}`);
note((await resolveDirect(t1.loc)).status === 404, "the real relay should have used the ticket up on that one lookup");
note(sockets.length === 0, `a socket to the relay opened before any tap: ${sockets}`);
note(!(await keyDatabases()).includes("vyre-relay"), `a device key store exists before any tap: ${await keyDatabases()}`);
note(await clickButton("Not now"), "no Not now button on the card");
await pump(1500);
note(/Nothing was paired/.test(String(await loaderText())), "Not now did not say nothing was paired");
note(sockets.length === 0, "a socket opened after Not now");
note(!(await keyDatabases()).includes("vyre-relay"), "a device key store exists after Not now");

// 2. Only the tap on Pair makes the key and opens the pairing channel.
const t2 = await registerTicket(relay.url);
outbound.length = 0;
await send("Page.navigate", { url: `http://localhost:${port}/#pair=${t2.ticket}` });
await pump(6000);
note(sockets.length === 0, "a socket opened before the tap on Pair");
note(await clickButton("Pair this device"), "no Pair button on the card");
await pump(6000);
note(outbound.filter(o => /\/v1\/pair$/.test(o.url)).length === 1, "pairing must use the record already held, not a second lookup");
note(sockets.some(u => /^wss:\/\/relay\.vyre\.run\//.test(u)), `the tap on Pair did not start pairing over the relay (sockets: ${sockets})`);

// 3. A record that names another relay is refused with no card and no socket.
sockets.length = 0;
const t3 = await registerTicket(relay.url, { relay: "wss://evil.example" });
await send("Page.navigate", { url: `http://localhost:${port}/#pair=${t3.ticket}` });
await pump(6000);
const refused = String(await loaderText());
note(!/Pair this device/.test(refused), `a record naming another relay still showed a card: ${refused.slice(0, 160)}`);
note(sockets.length === 0, `a socket opened for a record naming another relay: ${sockets}`);

for (const t of [t1, t2, t3]) try { t.ws.close(); } catch {}
c.kill(); server.close(); await relay.stop();

console.log(JSON.stringify({ outbound: outbound.map(o => [o.method, o.url]), sockets, card: card.slice(0, 200), refused: refused.slice(0, 160) }, null, 2));
if (failures.length) { console.log("THE HAND-OFF DID NOT HOLD:\n- " + failures.join("\n- ")); process.exit(1); }
console.log("A #pair= link shows its card and pairs nothing without the tap; one lookup, the fragment gone first; the tap alone starts pairing; a record naming another relay is refused.");
await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
