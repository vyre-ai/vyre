// @ts-check
// The chaos harness over the relay (docs/adr/0029-resilience.md, R1, R2, R5; ADR 0026): a real
// vyred with the relay module in a temp home, the Node relay from relay/node/, and kit (alex's
// phone) as relay/client's pair() and connect() on WebCrypto. The reference client from
// core/resilience runs on top through web.js's over(), with one logical path; relay/client's
// createPaths picks the way (a direct path through a fault proxy, then the relay). Every test
// names its rule. Timings are short (a 300 ms heartbeat, a 50 ms backoff); everything is on
// 127.0.0.1.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome, writeModule } from "../helpers.js";
import { proxy } from "./proxy.js";

process.env.VYRE_SSE_HEARTBEAT_MS = "300";
const { start } = await import("../../core/daemon/index.js");
const { HUMAN_ONLY } = await import("../../core/presence/index.js");
const { follow } = await import("../../core/resilience/stream.js");
const { outbox, memoryStore } = await import("../../core/resilience/outbox.js");
const { backoff } = await import("../../core/resilience/backoff.js");
const { over } = await import("../../core/resilience/web.js");
const { createRelay } = await import("../../relay/node/server.js");
const { pair, connect } = await import("../../relay/client/client.js");
const { createPaths } = await import("../../relay/client/paths.js");
const { webCrypto, memoryKeyStore } = await import("../../relay/client/webcrypto.js");

const quick = () => backoff({ min: 50, max: 400, jitter: 0 });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** @param {() => any} fn @param {string} what */
async function until(fn, what, ms = 10_000) {
  const t0 = Date.now();
  while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}

/** Asks for a proof on every human-only tool and takes any proof, as test/relay.test.js does. */
const lenient = {
  required: (/** @type {string} */ tool, /** @type {any} */ def, /** @type {any} */ input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async (/** @type {any} */ { proof }) => (proof ? { ok: true, method: "passkey" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
};
const PROOF = { proof: { method: "passkey", id: "x" } };

/** The write chaos.test.js uses: it counts itself in the event log. @param {string} root */
function chaosModule(root) {
  writeModule(path.join(root, "modules"), "chaos", { does: { tools: ["chaos.add", "chaos.slow"] }, watches: { emits: ["chaos.added"] } }, `export default { async start(ctx) {
    ctx.tool("chaos.add", { input: { type: "object", properties: { n: { type: "number" } } }, run: async i => ctx.events.emit("chaos.added", { n: i.n }) && { n: i.n } });
    ctx.tool("chaos.slow", { input: { type: "object", properties: { ms: { type: "number" }, n: { type: "number" } } },
      run: async i => { await new Promise(r => setTimeout(r, i.ms)); ctx.events.emit("chaos.added", { n: i.n }); return { n: i.n }; } });
    return {};
  } };`);
}

/**
 * The relay on a fixed port, which a test can kill and bring back, and every device socket it
 * accepted, so a test can cut one from the relay's side (as relay/client/e2e.test.js does).
 * @param {import("node:test").TestContext} t
 */
async function relayWorld(t) {
  /** @type {any[]} */ const devices = [];
  let relay = createRelay();
  let up = true;
  const track = (/** @type {ReturnType<typeof createRelay>} */ r) => r.server.on("upgrade", (req, socket) => { if (String(req.url).startsWith("/v1/device")) devices.push(socket); });
  track(relay);
  const url = await relay.listen();
  const port = Number(new URL(url).port);
  t.after(async () => { if (up) await relay.close(); });
  return {
    url, devices,
    /** The relay dies: every socket through it ends, and nothing answers on its port. */
    async kill() { if (!up) return; up = false; await relay.close(); },
    /** A fresh relay on the same port; the box's link finds it on its own backoff (1 s, 2 s, ...). */
    async revive() { relay = createRelay(); track(relay); await relay.listen(port); up = true; },
  };
}

/**
 * A box named alex behind the relay, with the chaos module, and kit paired to it.
 * @param {import("node:test").TestContext} t
 */
async function world(t) {
  const r = await relayWorld(t);
  const root = tempHome(t);
  chaosModule(root);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex" }, relay: { enabled: false, url: r.url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  const first = await d.registry.call("relay.pair.first", {}, "onboard", PROOF);
  assert.ok(first.data, JSON.stringify(first.error));
  const keyStore = memoryKeyStore(), crypto = webCrypto();
  const paired = await pair(first.data.url, { name: "kit", keyStore, crypto });
  const relayPath = { ...paired, keyStore, crypto, backoff: { min: 100, max: 400 } };
  return {
    ...r, d, relayPath,
    applied: () => d.events.since(0, { type: "chaos.added", limit: 1000 }).map((/** @type {any} */ e) => e.payload.n),
    emit: (/** @type {number} */ n) => d.events.emit("test", "thread.text", { n }),
    /** kit's connection to the box through the relay. */
    connect() { const c = connect(relayPath); t.after(() => c.close()); return c; },
    /** The box's socket, reachable over HTTP through a fault proxy: the direct path. */
    async direct() { const p = await proxy(d.paths.socket); t.after(() => p.close()); return p; },
  };
}

/**
 * follow() on one logical path over a path-fetch, as the phone app runs it.
 * @param {import("node:test").TestContext} t @param {import("../../core/resilience/web.js").PathFetch} f
 */
function watch(t, f) {
  /** @type {number[]} */ const got = [], ids = [];
  /** @type {any[]} */ const states = [];
  const s = follow({ paths: ["box"], open: over(f).open, type: "thread.*", backoff: quick(), stallMs: 1_500,
    onEvent: e => { got.push(e.payload.n); ids.push(e.id); }, onState: st => states.push(st) });
  t.after(() => s.stop());
  return { s, got, ids, states };
}
/** @param {{ states: any[] }} f */
const opened = f => until(() => f.states.some(x => x.state === "open"), "the stream to open")
  .catch(e => { throw new Error(`${e.message} (last: ${f.states.findLast(x => x.why)?.why ?? "no reason"})`); });
/** @param {number[]} ids */
const rising = ids => ids.every((id, i) => i === 0 || id > ids[i - 1]);

test("R1: a stream over the relay resumes from its cursor across a dropped device socket and a relay restart, each event once and in order", { timeout: 40_000 }, async t => {
  const w = await world(t);
  const conn = w.connect();
  const f = watch(t, (p, init) => conn.fetch(p, init));
  await opened(f);
  w.emit(1);
  await until(() => f.got.length === 1, "the first event");

  // The relay drops kit's socket; two events happen while kit is away.
  w.devices.at(-1).destroy();
  w.emit(2); w.emit(3);
  await until(() => f.got.length >= 3, "the gap after a dropped socket");

  // The whole relay dies and comes back on the same port; two events happen while it is gone.
  await w.kill();
  w.emit(4); w.emit(5);
  await sleep(300);
  await w.revive();
  w.emit(6);
  await until(() => f.got.length >= 6, "the gap after a relay restart", 20_000);
  await sleep(300);
  assert.deepEqual(f.got, [1, 2, 3, 4, 5, 6], "nothing lost, nothing twice");
  assert.ok(rising(f.ids), "ids only grow");
  assert.ok(f.states.filter(x => x.state === "open").length >= 3, "it reopened after each break");
});

test("R2: a write whose answer the dead relay lost is retried by the outbox with the same key and applied once", { timeout: 40_000 }, async t => {
  const w = await world(t);
  const conn = w.connect();
  const { caller } = over((p, init) => conn.fetch(p, init));
  // The box ran the write; the relay dies before the answer leaves it.
  let killed = false;
  const off = w.d.events.on("chaos.added", () => { if (!killed) { killed = true; w.kill(); } });
  t.after(off);
  const box = await outbox({ store: memoryStore(), call: caller({ timeoutMs: 700 }), backoff: quick() });
  t.after(() => box.stop());
  const { key, answered } = await box.add("chaos.slow", { ms: 150, n: 7 });
  await until(() => killed, "the box to run the write");
  await until(() => (box.pending[0]?.tries ?? 0) >= 2, "the outbox to try again while the relay is down");
  assert.deepEqual(w.applied(), [7], "the box ran it once");
  assert.equal(box.pending[0].key, key, "a retry keeps its key");

  await w.revive();
  const r = /** @type {any} */ (await Promise.race([answered, sleep(20_000).then(() => ({ error: { code: "test_timeout" } }))]));
  assert.deepEqual(r.data, { n: 7 }, JSON.stringify(r));
  assert.equal(r.replayed, true, "the box answered the retry from its record of the key");
  assert.deepEqual(w.applied(), [7], "applied once");
  assert.equal(box.pending.length, 0);
});

test("R5: a broken direct path moves the stream to the relay and back when it heals, missing nothing and doubling nothing", { timeout: 40_000 }, async t => {
  const w = await world(t);
  const direct = await w.direct();
  const paths = createPaths(/** @type {any} */ ({ paths: [{ kind: "direct", base: direct.url }, { kind: "relay", ...w.relayPath }],
    probeMs: 300, directTimeout: 500, report: false }));
  t.after(() => paths.close());
  const f = watch(t, paths.fetch);
  await opened(f);
  assert.equal(paths.current, "direct");
  w.emit(1);
  await until(() => f.got.length === 1, "the first event, direct");

  // The direct path breaks mid-stream (a Tailscale path gone); events keep happening.
  direct.refuse(); direct.drop();
  w.emit(2); w.emit(3);
  await until(() => f.got.length >= 3 && paths.current === "relay", "the switch to the relay");
  w.emit(4);
  await until(() => f.got.length >= 4, "a live event over the relay");

  // It heals: the prober finds it and the stream moves back.
  direct.heal();
  await until(() => paths.current === "direct", "the move back to direct");
  w.emit(5);
  await until(() => f.got.length >= 5, "an event after the move back");
  await sleep(300);
  assert.deepEqual(f.got, [1, 2, 3, 4, 5], "nothing lost, nothing twice");
  assert.ok(rising(f.ids));
  assert.ok(direct.open > 0, "the stream runs through the direct path again");
});

test("R5: with the relay gone for good, the stream and the outbox move to a direct path that heals", { timeout: 40_000 }, async t => {
  const w = await world(t);
  const direct = await w.direct();
  direct.refuse();
  const paths = createPaths(/** @type {any} */ ({ paths: [{ kind: "direct", base: direct.url }, { kind: "relay", ...w.relayPath }],
    probeMs: 300, directTimeout: 500, report: false }));
  t.after(() => paths.close());
  const f = watch(t, paths.fetch);
  await opened(f);
  assert.equal(paths.current, "relay");
  w.emit(1);
  await until(() => f.got.length === 1, "the first event, over the relay");

  // The relay dies and stays dead; the direct path comes up. A write is made in the gap.
  await w.kill();
  w.emit(2);
  const done = [];
  const box = await outbox({ store: memoryStore(), call: over(paths.fetch).caller({ timeoutMs: 1_000 }), backoff: quick(),
    onChange: o => { if (o.done) done.push(o.done.data); } });
  t.after(() => box.stop());
  await box.add("chaos.add", { n: 9 });
  direct.heal();
  await until(() => paths.current === "direct", "the move to direct");
  w.emit(3);
  await until(() => f.got.length >= 3 && done.length === 1, "the stream and the write over direct");
  await sleep(300);
  assert.deepEqual(f.got, [1, 2, 3]);
  assert.deepEqual(done, [{ n: 9 }]);
  assert.deepEqual(w.applied(), [9]);
});

// Known bugs in relay/ and core/relay/, owned by the relay team (marked todo until fixed there).
// Node 22's WebSocket (undici) answers a refused connection with `error` and never `close`.
// Both sides wait only for `close` (`ws.onerror = () => {}`), so a dial that lands on a dead relay
// is never seen to fail.

test("R5: kit redials within its backoff after dialing a dead relay, not after the 15 s handshake timeout",
  { timeout: 30_000, todo: "relay/client/client.js openChannel ignores ws.onerror; a refused dial waits HANDSHAKE_MS (15 s)" }, async t => {
    const w = await world(t);
    const conn = w.connect();
    await until(() => conn.state === "open", "kit's first connection");
    await w.kill();
    await sleep(500);                  // kit redials (100 ms to 400 ms) into the dead port
    await w.revive();
    const t0 = Date.now();
    await until(() => conn.state === "open", "kit back on the relay", 6_000);
    assert.ok(Date.now() - t0 < 6_000);
  });

test("R5: the box's relay link comes back after an outage longer than its first retry",
  { timeout: 30_000, todo: "core/relay/link.js connect ignores ws.onerror; a retry that hits a dead relay never schedules the next" }, async t => {
    const w = await world(t);
    let back = false;
    const off = w.d.events.on("relay.connected", () => { back = true; });
    t.after(off);
    await w.kill();
    await sleep(1_500);                // the box's first retry (1 s) lands on the dead port
    await w.revive();
    await until(() => back, "the box to reconnect to the relay", 8_000);   // its next retry is due 3 s after the outage began
  });
