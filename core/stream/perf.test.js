// @ts-check
// Measured, not guessed: a real loopback WebSocket, a real server (serveWS), the real client.
// Prints JSON lines. Targets: emit to client onFrame p95 <= 50 ms (budget 300 ms to a screen),
// kill to first resumed frame <= 1 s.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SessionLog } from "./log.js";
import { serveWS } from "./server.js";
import { connect, wsDuplex } from "./client.js";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
/** @param {number[]} xs @param {number} p */
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN; };
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/** @param {SessionLog} log */
function listen(log) {
  /** @type {Set<import("node:net").Socket>} */ const socks = new Set();
  const server = http.createServer((_, res) => res.end());
  server.on("connection", s => { socks.add(s); s.on("close", () => socks.delete(s)); });
  server.on("upgrade", (req, socket, head) => serveWS(log, req, /** @type {any} */ (socket), head, {}));
  return new Promise(res => server.listen(0, "127.0.0.1", () => res({ server, socks, port: /** @type {any} */ (server.address()).port })));
}
const until = async (/** @type {() => boolean} */ p, ms = 10_000) => { const t = now(); while (!p() && now() - t < ms) await sleep(2); assert.ok(p(), "condition met in time"); };

test("perf: emit to client onFrame latency over a loopback WebSocket (text-delta)", async () => {
  const log = new SessionLog("perf");
  const { server, socks, port } = /** @type {any} */ (await listen(log));
  const N = 3000;
  const emitAt = new Float64Array(N + 2);
  /** @type {number[]} */ const lat = [];
  const client = connect({
    open: () => wsDuplex(`ws://127.0.0.1:${port}/`),
    onFrame: f => { const t = now(); if (f.type === "session.text-delta" && emitAt[f.cur]) lat.push(t - emitAt[f.cur]); },
  });
  try {
    await until(() => client.state === "live");
    await sleep(20);
    // About 300 deltas a second, with the jitter of a real model stream.
    for (let i = 0; i < N; i++) {
      const f = log.append("text-delta", { message: "m", index: 0, text: `tok${i} ` }, { turn: "1" });
      emitAt[f.cur] = now();
      if (i % 3 === 2) await sleep(1);
    }
    await until(() => lat.length >= N);
    const out = { test: "perf-latency", transport: "loopback ws, same process", frames: lat.length, p50_ms: r2(pct(lat, 50)), p95_ms: r2(pct(lat, 95)), p99_ms: r2(pct(lat, 99)), max_ms: r2(Math.max(...lat)), target_p95_ms: 50, budget_ms: 300 };
    console.log(JSON.stringify(out));
    assert.ok(out.p95_ms <= 50, `p95 ${out.p95_ms} ms is over the 50 ms target`);
    assert.ok(out.max_ms <= 300 || out.p99_ms <= 300, "p99 inside the 300 ms budget");
  } finally { client.close(); for (const s of socks) s.destroy(); server.close(); log.close(); }
});

test("perf: kill to first resumed frame", async () => {
  const log = new SessionLog("perf2");
  const { server, socks, port } = /** @type {any} */ (await listen(log));
  let text = "", all = "", seq = 0;
  /** @type {number|null} */ let killedAt = null;
  let reconnecting = false, liveAgain = false;
  /** @type {number[]} */ const resume = [];
  const client = connect({
    open: () => wsDuplex(`ws://127.0.0.1:${port}/`),
    onState: s => { if (s === "reconnecting") reconnecting = true; else if (s === "live" && reconnecting) liveAgain = true; },
    onFrame: f => {
      if (f.type === "session.text-delta") text += f.data.text;
      if (killedAt !== null && liveAgain) { resume.push(now() - killedAt); killedAt = null; reconnecting = false; liveAgain = false; }
    },
  });
  // A steady stream of frames the whole time, so there is always something to resume to.
  let running = true;
  const pump = (async () => { while (running) { const w = `w${seq++} `; all += w; log.append("text-delta", { message: "m", index: 0, text: w }); await sleep(4); } })();
  try {
    await until(() => client.state === "live");
    for (let k = 0; k < 30; k++) {
      await sleep(25);
      killedAt = now(); reconnecting = false; liveAgain = false;
      for (const s of socks) s.destroy();
      await until(() => killedAt === null, 5000);
    }
    running = false; await pump;
    await until(() => client.last === log.head);
    assert.equal(text, all, "nothing lost or repeated across 30 kills");
    const out = { test: "perf-resume", kills: resume.length, p50_ms: r2(pct(resume, 50)), p95_ms: r2(pct(resume, 95)), p99_ms: r2(pct(resume, 99)), max_ms: r2(Math.max(...resume)), target_ms: 1000 };
    console.log(JSON.stringify(out));
    assert.equal(resume.length, 30);
    assert.ok(out.p95_ms <= 1000, `resume p95 ${out.p95_ms} ms is over 1 s`);
  } finally { running = false; client.close(); for (const s of socks) s.destroy(); server.close(); log.close(); }
});
