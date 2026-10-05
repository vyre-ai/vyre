#!/usr/bin/env node
// Proves a relay and directory you run answer a pairing round trip: a box connects to the relay and registers a sealed pairing ticket, a device resolves it once (a second
// resolve finds nothing), and the directory answers a name check.
//   node scripts/relay-roundtrip.mjs ws://127.0.0.1:8080 http://127.0.0.1:8081
// Run it from a checkout against your own relay; it claims nothing and touches no name.
import { newRouteKey, routeId, authMessage, signRoute, ticketSeal } from "../core/relay/wire.js";

const [base, dir] = process.argv.slice(2);
if (!base) { console.error("usage: relay-roundtrip.mjs <ws://relay> [http://directory]"); process.exit(2); }
const step = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) process.exitCode = 1; return ok; };
const key = newRouteKey(), route = routeId(key.pub);
const ws = new WebSocket(`${base}/v1/box?route=${route}`);
const msgs = [], waiters = [];
ws.onmessage = e => { const m = JSON.parse(String(e.data)); const w = waiters.shift(); w ? w(m) : msgs.push(m); };
const next = () => msgs.length ? Promise.resolve(msgs.shift()) : new Promise(r => waiters.push(r));
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cannot reach the relay")); });
const ch = await next();
ws.send(JSON.stringify({ t: "auth", pub: key.pub.toString("base64url"), sig: signRoute(key.priv, authMessage(route, Buffer.from(ch.n, "base64url"))).toString("base64url") }));
step((await next()).t === "ready", "the box authenticated to the relay with its route key");
const loc = "L".repeat(43), sealed = ticketSeal(Buffer.alloc(8, 7), JSON.stringify({ v: 1, route }));
ws.send(JSON.stringify({ t: "ticket", loc, record: sealed, mac: "m".repeat(43), exp: Date.now() + 60_000 }));
const http = base.replace(/^ws/, "http");
const resolve = () => fetch(`${http}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc }) });
let r;
for (let i = 0; i < 50 && !(r = await resolve()).ok; i++) await new Promise(x => setTimeout(x, 50));
step(r.ok && (await r.json()).record === sealed, "a device resolved the box's sealed pairing ticket");
step((await resolve()).status === 404, "the ticket works once");
ws.close();
if (dir) {
  const h = await fetch(`${dir}/health`); step(h.ok, "the directory answers /health");
  const c = await fetch(`${dir}/v1/names/check?name=roundtrip-test`); const j = await c.json().catch(() => null);
  step(c.status < 500 && j !== null, `the directory answers a name check (${c.status} ${JSON.stringify(j).slice(0, 80)})`);
}
