// relay-soak.mjs: does a box's relay control link stay up, and does a typed-code redeem work after a long uptime? (testbox only, never the Mac)
//
//   node scripts/relay-soak.mjs [--minutes 25] [--grace-ms 0] [--ping-ms 60000] [--relay ws://host:port]
//
// A real relay (relay/node/server.js, or --relay for one already running) and a real box link (core/relay/link.js, the same code vyred runs) on one route. The relay's code grace is switched
// OFF by default (--grace-ms 0), so a control socket that drops loses its typed code at once: if the link flaps at all during the run, a redeem fails and the log says when the link dropped and why.
// Every state change of the link is logged with a time. A typed-code redeem (the typist's POST /v1/wink/code, step 1) is tried at the start, every 5 minutes and at the end; each is a fresh allocation.
// Prints one JSON line per event and PASS/FAIL. Exit 0 when the link never dropped and every redeem was answered by the box.
import { createRelay } from "../relay/node/server.js";
import { relayLink } from "../core/relay/link.js";
import { newRouteKey, routeId } from "../core/relay/wire.js";
import { keyPair } from "../core/relay/noise.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg("minutes", 25));
const GRACE = Number(arg("grace-ms", 0));
const PING = Number(arg("ping-ms", 60_000));
const out = (ev, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let relay = null, url = arg("relay", "");
if (!url) { relay = createRelay({ code: { graceMs: GRACE } }); url = await relay.listen(); }
out("relay", { url, graceMs: GRACE, pingMs: PING });

const rk = newRouteKey(), route = routeId(rk.pub), box = keyPair();
let drops = 0, ups = 0, since = Date.now();
const link = relayLink({ url, route, routeKey: rk, boxKey: box, admit: async () => { throw new Error("soak: no devices"); }, onchannel: () => {}, pingMs: PING, log: m => out("link-log", { m }),
  oncode: m => { link.codeReply(m.q, "AAAAAAAAAAAAAAAAAAAAAA"); },
  onstate: (s, why) => { if (s === "connected") { ups++; out("link", { state: s, upForMs: 0 }); since = Date.now(); } else { drops++; out("link", { state: s, why, upForMs: Date.now() - since }); } } });
await link.ready(10_000);

let redeems = 0, ok = 0;
async function redeem(label) {
  redeems++;
  const a = await link.codeAlloc();
  if (!a) { out("redeem", { label, ok: false, why: "no allocation (link down?)" }); return; }
  const r = await fetch(`${url.replace(/^ws/, "http")}/v1/wink/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rv: a.rv, s: "A".repeat(22), n: 1, m: "AAAA" }) }).catch(e => ({ status: 0, text: async () => String(e) }));
  const good = r.status === 200;
  if (good) ok++;
  out("redeem", { label, ok: good, status: r.status, linkUp: link.connected, upForMs: Date.now() - since });
  link.codeRelease();
}

await redeem("start");
const end = Date.now() + MINUTES * 60_000;
let next = Date.now() + 5 * 60_000;
while (Date.now() < end) {
  await sleep(Math.min(5000, end - Date.now()));
  if (Date.now() >= next && Date.now() < end) { await redeem(`t+${Math.round((Date.now() - (end - MINUTES * 60_000)) / 60_000)}min`); next += 5 * 60_000; }
}
// the long-uptime redeem: the first one after the whole run, on a link that has been up since the start
await redeem(`end after ${MINUTES}min`);
const good = drops === 0 && ok === redeems;
out(good ? "PASS" : "FAIL", { minutes: MINUTES, redeems, answered: ok, drops, reconnects: Math.max(0, ups - 1) });
link.stop();
if (relay) await relay.close();
process.exit(good ? 0 : 1);
