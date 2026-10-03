// relay-bench.mjs: does the Vyre relay (relay/node/server.js) carry an arbitrary byte stream
// between a device and a box, and at what latency and throughput? Run from the repo root:
//   node scripts/spike-wink/relay-bench.mjs
// Box and device are the real core/relay/channel.js sides (Noise IK) over the real relay on
// 127.0.0.1. A Stream carries the bytes the way a wink peer connection would: opened with a
// head, data both ways, end.
import { createRelay } from "../../relay/node/server.js";
import { newRouteKey, routeId, authMessage, signRoute } from "../../core/relay/wire.js";
import { keyPair } from "../../core/relay/noise.js";
import { deviceSide, boxSide } from "../../core/relay/channel.js";

const relay = createRelay();
const base = await relay.listen();
const key = newRouteKey(), route = routeId(key.pub);
const boxStatic = keyPair(), devKeys = keyPair();

const open = ws => new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
const queue = ws => { const q = [], w = []; ws.onmessage = e => { const v = typeof e.data === "string" ? e.data : Buffer.from(e.data); const f = w.shift(); f ? f(v) : q.push(v); }; return () => q.length ? Promise.resolve(q.shift()) : new Promise(r => w.push(r)); };

// the box: control socket, signed challenge
const ctl = new WebSocket(`${base}/v1/box?route=${route}`); ctl.binaryType = "arraybuffer";
const next = queue(ctl); await open(ctl);
const ch = JSON.parse(await next());
ctl.send(JSON.stringify({ t: "auth", pub: key.pub.toString("base64url"), sig: signRoute(key.priv, authMessage(route, Buffer.from(ch.n, "base64url"))).toString("base64url") }));
const ready = JSON.parse(await next());

// echo service on the box: stream head {kind:"echo"} -> bytes come back; {kind:"sink",bytes}; {kind:"src",bytes}
const onStream = s => {
  const h = s.head || {};
  if (h.kind === "echo") { s.ondata = c => s.write(c); s.onend = () => s.end(); }
  else if (h.kind === "sink") { let n = 0; s.ondata = c => { n += c.length; }; s.onend = () => { s.write(Buffer.from(String(n))); s.end(); }; }
  else if (h.kind === "src") { const chunk = Buffer.alloc(60000, 7); for (let n = h.bytes; n > 0; n -= chunk.length) s.write(chunk.subarray(0, Math.min(n, chunk.length))); s.end(); }
};
(async () => { for (;;) {
  const m = JSON.parse(await next());
  if (m.t !== "open") continue;
  const data = new WebSocket(`${base}/v1/box?route=${route}&c=${m.c}&t=${ready.ticket}`); data.binaryType = "arraybuffer";
  const side = boxSide({ send: b => data.send(b), close: (c, r) => data.close(c, r) }, { s: boxStatic, route, admit: async () => ({ ok: true }) });
  data.onmessage = e => side.receive(Buffer.from(e.data));
  side.ready.then(({ channel }) => { channel.onstream = onStream; }, () => {});
} })();

// the device
const dws = new WebSocket(`${base}/v1/device?route=${route}`); dws.binaryType = "arraybuffer";
const t0 = performance.now(); await open(dws);
const dside = deviceSide({ send: b => dws.send(b), close: (c, r) => dws.close(c, r) }, { s: devKeys, box: boxStatic.pub, route, hello: { v: 1 } });
dws.onmessage = e => dside.receive(Buffer.from(e.data));
const { channel } = await dside.ready;
console.log(JSON.stringify({ ev: "connected", ms: Math.round(performance.now() - t0) }));

// latency: 1 byte ping-pong on one stream
{
  const s = channel.open({ kind: "echo" }); const rtts = []; let t, resolve;
  s.ondata = () => { rtts.push(performance.now() - t); resolve(); };
  for (let i = 0; i < 300; i++) { await new Promise(r => { resolve = r; t = performance.now(); s.write(Buffer.from([1])); }); }
  s.end(); rtts.sort((a, b) => a - b);
  console.log(JSON.stringify({ ev: "latency_ms", n: rtts.length, min: +rtts[0].toFixed(3), p50: +rtts[150].toFixed(3), p95: +rtts[285].toFixed(3), max: +rtts.at(-1).toFixed(3) }));
}
const MB = 32 * 1024 * 1024;
{ // device -> box
  const s = channel.open({ kind: "sink" }); const chunk = Buffer.alloc(60000, 1); const t = performance.now();
  const done = new Promise(r => { s.ondata = () => r(); });
  for (let n = MB; n > 0; n -= chunk.length) s.write(chunk.subarray(0, Math.min(n, chunk.length)));
  s.end(); await done; const sec = (performance.now() - t) / 1000;
  console.log(JSON.stringify({ ev: "device_to_box", mbit_s: +(MB * 8 / sec / 1e6).toFixed(1), secs: +sec.toFixed(2) }));
}
{ // box -> device
  const s = channel.open({ kind: "src", bytes: MB }); let n = 0; const t = performance.now();
  await new Promise(r => { s.ondata = c => { n += c.length; }; s.onend = r; });
  const sec = (performance.now() - t) / 1000;
  console.log(JSON.stringify({ ev: "box_to_device", bytes: n, mbit_s: +(n * 8 / sec / 1e6).toFixed(1), secs: +sec.toFixed(2) }));
}
{ // many streams at once: one slow bulk and a ping on another (head of line blocking)
  const bulk = channel.open({ kind: "src", bytes: MB }); bulk.ondata = () => {};
  const s = channel.open({ kind: "echo" }); const t = performance.now();
  await new Promise(r => { s.ondata = r; s.write(Buffer.from([1])); });
  console.log(JSON.stringify({ ev: "ping_during_bulk_ms", ms: +(performance.now() - t).toFixed(2) }));
}
console.log(JSON.stringify({ ev: "rss_mb", mb: Math.round(process.memoryUsage().rss / 1e6) }));
process.exit(0);
