// Measures the chat stream over the real relay path and prints JSON lines. Two modes:
//
//   node core/stream/relay-perf.mjs relay [--host 0.0.0.0] [--port 39571]
//       Runs relay/node/server.js (the same relay code the product ships) and prints {"relay":"ws://..."}.
//       Run it on one machine.
//
//   node core/stream/relay-perf.mjs run --relay ws://HOST:PORT [--deltas 3000] [--kills 120] [--rate 100]
//       On another machine: a box (a real SessionLog served with serveWS, joined to the relay through
//       core/relay/link.js and core/relay/bridge.js, so a client's socket is a relay `ws` stream) and a
//       client (relay/client connect + core/stream/client.js over a RelaySocket). Box and client share
//       one process and one clock, so latency is a single clock's difference; every frame still crosses
//       box -> relay -> client over the network and the Noise channel. Phase 1 emits `--deltas` text
//       deltas at about `--rate` a second and prints emit-to-client p50/p95/p99. Phase 2 emits
//       continuously and cuts the client's relay socket `--kills` times, printing kill to first
//       resumed frame, and checks that the cursors delivered are exactly 1..N (no loss, no repeat) and
//       that the text equals what was emitted.
//
// Output lines: {"test":"relay-path",...}, {"test":"relay-latency",...}, {"test":"relay-resume",...}.

import { performance } from "node:perf_hooks";
import { createRelay } from "../../relay/node/server.js";
import { SessionLog } from "./log.js";
import { serveWS } from "./server.js";
import { connect as streamConnect, wsDuplex } from "./client.js";
import { startOf } from "./frame.js";
import { keyPair, newRouteKey, routeId, relayLink, bridge } from "../../scripts/relay-perf-deps.mjs";
import { connect as relayConnect } from "../../relay/client/client.js";
import { webCrypto, memoryKeyStore } from "../../relay/client/webcrypto.js";

const args = process.argv.slice(2);
const mode = args.shift();
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const out = o => console.log(JSON.stringify(o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN; };
const r2 = n => Math.round(n * 100) / 100;
const until = async (p, ms = 20000, what = "condition") => { const t = now(); while (!p() && now() - t < ms) await sleep(2); if (!p()) throw new Error("timed out: " + what); };

if (mode === "relay") {
  const relay = createRelay();
  const host = flag("--host", "0.0.0.0");
  const url = await relay.listen(Number(flag("--port", "39571")), host);
  out({ relay: url.replace(/^(wss?:\/\/)(0\.0\.0\.0|127\.0\.0\.1)/, `$1${host}`), host });
  process.on("SIGTERM", async () => { await relay.close(); process.exit(0); });
} else if (mode === "run") {
  const relayUrl = flag("--relay", "");
  if (!/^wss?:\/\//.test(relayUrl)) throw new Error("--relay ws://host:port is required");
  const DELTAS = Number(flag("--deltas", "3000"));
  const KILLS = Number(flag("--kills", "120"));
  const RATE = Number(flag("--rate", "100"));

  const log = new SessionLog("relay-perf");
  // The box: serveWS for the stream path, everything else 404.
  const http404 = (_req, res) => { res.statusCode = 404; res.end(); };
  const routeKey = newRouteKey(), boxKey = keyPair(), route = routeId(routeKey.pub);
  const link = relayLink({
    url: relayUrl, route, routeKey, boxKey,
    admit: async () => ({ v: 1, box: { name: "relay-perf" }, device: "perfdevice0000000" }),
    onchannel: channel => bridge(channel, {
      handler: http404, caller: "device:perfdevice0000000", peer: null,
      upgrade: () => (req, socket, head) => serveWS(log, req, socket, head, {}),
    }),
  });
  if (!(await link.ready())) throw new Error("the box could not join the relay at " + relayUrl);
  const conn = relayConnect({ relay: relayUrl, route, box: new Uint8Array(boxKey.pub), keyStore: memoryKeyStore(), crypto: webCrypto(), backoff: { min: 100, max: 500 } });

  // The stream client over a RelaySocket (WebSocket-shaped). One WS class per open() so each call is a fresh stream.
  const WS = function () { return conn.socket("/v1/streams/stream/session"); };
  const emitAt = new Map();           // cur -> performance.now() at append
  const lat = [];
  const seen = [];                    // every cur delivered, in order
  let text = "", killedAt = null, firstAfterKill = null, lastCur = 0;
  const resume = [];
  const client = streamConnect({
    open: () => wsDuplex("ws://relay/", WS),
    onFrame: f => {
      const t = now();
      seen.push([startOf(f), f.cur]);
      if (f.type === "session.text-delta") { text += f.data.text; const e = emitAt.get(f.cur); if (e !== undefined && killedAt === null) lat.push(t - e); }
      if (killedAt !== null && f.cur > lastCur) { resume.push(t - killedAt); killedAt = null; }
      lastCur = Math.max(lastCur, f.cur);
    },
  });
  await until(() => client.state === "live", 20000, "client live over the relay");
  await sleep(100);
  out({ test: "relay-path", relay: relayUrl, box_to_relay: "relayLink (Noise, ws)", client_to_relay: "relay/client Connection (Noise, ws)", stream: "core/stream serveWS via core/relay/bridge ws head",
    process: "box and client in one process, one clock", pid: process.pid, node: process.version });

  // Phase 1: latency.
  let emitted = "";
  const perTick = Math.max(1, Math.round(RATE / 100));
  for (let i = 0; i < DELTAS; i++) {
    const tok = `t${i} `;
    const f = log.append("text-delta", { message: "m", index: 0, text: tok }, { turn: "1" });
    emitAt.set(f.cur, now()); emitted += tok;
    if (i % perTick === perTick - 1) await sleep(10);
  }
  await until(() => client.last === log.head, 30000, "phase 1 drained");
  out({ test: "relay-latency", frames: lat.length, emitted: DELTAS, rate_per_s: RATE, p50_ms: r2(pct(lat, 50)), p95_ms: r2(pct(lat, 95)), p99_ms: r2(pct(lat, 99)), max_ms: r2(Math.max(...lat)), target_p95_ms: 300 });

  // Phase 2: kills while emitting.
  let running = true, n = DELTAS;
  const pump = (async () => { while (running) { const tok = `k${n++} `; log.append("text-delta", { message: "m", index: 0, text: tok }, { turn: "1" }); emitted += tok; await sleep(10); } })();
  for (let k = 0; k < KILLS; k++) {
    await sleep(300 + Math.floor(Math.random() * 400));
    await until(() => client.state === "live" && conn.state === "open", 20000, "live before kill " + k);
    killedAt = now();
    // Cut the real thing: the device's relay WebSocket (the Noise channel, and every stream on it).
    try { conn.ws.close(4000, "perf kill"); } catch {}
    await until(() => killedAt === null, 30000, "first resumed frame after kill " + k);
  }
  running = false; await pump;
  await until(() => client.last === log.head, 30000, "phase 2 drained");
  let end = 0, dupes = 0, gaps = 0;
  for (const [a, b] of seen) { if (a <= end) dupes++; else if (a !== end + 1) gaps++; end = Math.max(end, b); }
  const contiguous = dupes === 0 && gaps === 0 && end === log.head;
  out({ test: "relay-resume", kills: resume.length, p50_ms: r2(pct(resume, 50)), p95_ms: r2(pct(resume, 95)), p99_ms: r2(pct(resume, 99)), max_ms: r2(Math.max(...resume)), target_ms: 1000,
    frames_delivered: seen.length, log_head: log.head, ranges_contiguous_1_to_head: contiguous, gaps, repeats: dupes, text_equal: text === emitted });
  client.close(); conn.close(); link.stop(); log.close();
  process.exit(contiguous && text === emitted ? 0 : 1);
} else {
  console.error("usage: relay-perf.mjs relay [--host H] [--port P] | run --relay ws://H:P [--deltas N] [--kills N] [--rate N]");
  process.exit(2);
}
