// @ts-check
// The chaos harness (docs/adr/0029-resilience.md, R8): vyred in a temp home behind fault proxies,
// followed by the reference client (core/resilience), with one test per rule of the contract.
// Every test names its rule. Timings are shortened (a 300 ms heartbeat, a 50 ms backoff) so the
// file runs in seconds; the behaviour is the same at 15 s and 2 s.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tempHome, writeModule } from "../helpers.js";
import { proxy } from "./proxy.js";

process.env.VYRE_SSE_HEARTBEAT_MS = "300";
const { start } = await import("../../core/daemon/index.js");
const { follow } = await import("../../core/resilience/stream.js");
const { outbox, memoryStore } = await import("../../core/resilience/outbox.js");
const { backoff } = await import("../../core/resilience/backoff.js");
const node = await import("../../core/resilience/node.js");
const web = await import("../../core/resilience/web.js");

const quick = () => backoff({ min: 50, max: 400, jitter: 0 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 8_000) {
  const t0 = Date.now();
  while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}

/** A module with a write that counts itself in the event log, so the count survives restarts. */
function chaosModule(root) {
  writeModule(path.join(root, "modules"), "chaos", { does: { tools: ["chaos.add", "chaos.slow", "chaos.key", "chaos.read"] }, watches: { emits: ["chaos.added", "chaos.started"] } }, `export default { async start(ctx) {
    ctx.tool("chaos.add", { effect: "read", input: { type: "object", properties: { n: { type: "number" } } }, run: async i => ctx.events.emit("chaos.added", { n: i.n }) && { n: i.n } });
    ctx.tool("chaos.slow", { effect: "read", input: { type: "object", properties: { ms: { type: "number" }, n: { type: "number" } } },
      run: async i => { ctx.events.emit("chaos.started", { n: i.n }); await new Promise(r => setTimeout(r, i.ms)); ctx.events.emit("chaos.added", { n: i.n }); return { n: i.n }; } });
    ctx.tool("chaos.read", { effect: "read", input: { type: "object", properties: {} }, run: async () => ({ last_event: ctx.events.latestId() }) });
    ctx.tool("chaos.key", { effect: "read", input: { type: "object", properties: {} }, run: async (i, meta) => ({ key: meta.idempotencyKey ?? null }) });
    return {};
  } };`);
}

async function world(t, paths = 1) {
  const root = tempHome(t);
  chaosModule(root);
  let d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  const proxies = [];
  for (let i = 0; i < paths; i++) proxies.push(await proxy(d.paths.socket));
  const w = {
    root, proxies, get d() { return d; },
    applied: () => d.events.since(0, { type: "chaos.added", limit: 1000 }).map(e => e.payload.n),
    emit: n => d.events.emit("test", "thread.text", { n }),
    async restart() { await d.stop(); d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] }); },
  };
  t.after(async () => { for (const p of proxies) await p.close(); await d.stop(); });
  return w;
}

function watch(w, o = {}) {
  const got = [], resets = [], states = [];
  const s = follow({ paths: w.proxies.map(p => p.url), open: node.open, type: "thread.*", backoff: quick(), stallMs: 1_000, probeMs: 200,
    onEvent: e => got.push(e.payload.n), onReset: e => resets.push(e), onState: st => states.push(st), ...o });
  return { s, got, resets, states };
}
const opened = f => until(() => f.states.some(x => x.state === "open"), "the stream to open");

test("R1: a stream that drops before its first event replays the gap, not from 'latest'", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const f = watch(w);
  t.after(() => f.s.stop());
  await opened(f);
  const [p] = w.proxies;
  p.refuse(); p.drop();
  for (const n of [1, 2, 3]) w.emit(n);
  await sleep(150);
  p.heal();
  await until(() => f.got.length >= 3, "the gap to replay");
  assert.deepEqual(f.got, [1, 2, 3]);
});

test("R1: a stream cut mid-event delivers every event once", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const f = watch(w);
  t.after(() => f.s.stop());
  await opened(f);
  const [p] = w.proxies;
  p.cutAfter(90);                      // every connection now ends inside the next event frame
  for (const n of [1, 2]) w.emit(n);
  await sleep(300);
  p.heal(); p.drop();
  for (const n of [3, 4]) w.emit(n);
  await until(() => f.got.length >= 4, "all four events");
  await sleep(200);
  assert.deepEqual(f.got, [1, 2, 3, 4]);
});

test("R1: a partitioned path is noticed by the missing heartbeat and the stream comes back", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const f = watch(w);
  t.after(() => f.s.stop());
  await opened(f);
  const [p] = w.proxies;
  p.partition();
  w.emit(1);
  await until(() => f.states.some(x => x.state === "reconnecting"), "the stall to be noticed");
  p.heal();
  await until(() => f.got.length >= 1, "the event held up by the partition");
  assert.deepEqual(f.got, [1]);
});

test("R1: a cursor ahead of the box's log is announced with stream.reset, never a silent stall", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const f = watch(w, { cursor: w.d.events.latestId() + 500 });
  t.after(() => f.s.stop());
  await until(() => f.resets.length === 1, "a reset");
  w.emit(7);
  await until(() => f.got.length === 1, "live events after the reset");
  assert.deepEqual(f.got, [7]);
});

test("R1, R7: vyred restarting mid-stream loses nothing, and ids keep growing", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const f = watch(w);
  t.after(() => f.s.stop());
  await opened(f);
  w.emit(1);
  await until(() => f.got.length === 1, "the first event");
  const before = w.d.events.latestId();
  await w.restart();
  w.emit(2); w.emit(3);
  await until(() => f.got.length >= 3, "events after the restart");
  assert.deepEqual(f.got, [1, 2, 3]);
  assert.ok(w.d.events.latestId() > before);
});

test("R2: a retried write with the same key runs once, even when the retries overlap", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const call = node.caller(w.proxies[0].url);
  const [a, b] = await Promise.all([call("chaos.slow", { ms: 200, n: 1 }, "key-00000001"), call("chaos.slow", { ms: 200, n: 1 }, "key-00000001")]);
  const c = await call("chaos.slow", { ms: 200, n: 1 }, "key-00000001");
  assert.deepEqual([a.data, b.data, c.data], [{ n: 1 }, { n: 1 }, { n: 1 }]);
  assert.equal(/** @type {any} */ (c).replayed, true);
  assert.deepEqual(w.applied(), [1]);
  // A key belongs to one tool: the same key on another tool is another write.
  const other = await call("chaos.add", { n: 2 }, "key-00000001");
  assert.deepEqual(other.data, { n: 2 });
  assert.deepEqual(w.applied(), [1, 2]);
});

test("R2: the tool sees the call's key, so it can hand it on as the SDK message uuid (ADR 0030)", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const call = node.caller(w.proxies[0].url);
  assert.deepEqual((await call("chaos.key", {}, "key-00000009")).data, { key: "key-00000009" });
  assert.deepEqual((await call("chaos.key", {})).data, { key: null });
});

test("R1: a read returns last_event from ctx.events.latestId, and following from it misses nothing", { timeout: 20_000 }, async t => {
  const w = await world(t);
  w.emit(1);
  const call = node.caller(w.proxies[0].url);
  const { last_event } = /** @type {any} */ ((await call("chaos.read", {})).data);
  assert.equal(last_event, w.d.events.latestId());
  w.emit(2);
  const f = watch(w, { cursor: last_event });
  t.after(() => f.s.stop());
  await until(() => f.got.length === 1, "the event after the read");
  assert.deepEqual(f.got, [2]);
});

test("R2: the same key with other input is refused, not run", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const call = node.caller(w.proxies[0].url);
  await call("chaos.add", { n: 1 }, "key-00000002");
  const r = await call("chaos.add", { n: 9 }, "key-00000002");
  assert.equal(r.error?.code, "idempotency_conflict");
  assert.deepEqual(w.applied(), [1]);
});

test("R2: writes made offline wait in the outbox and land once, in order", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const [p] = w.proxies;
  p.refuse();
  const done = [];
  const box = await outbox({ store: memoryStore(), call: node.caller(p.url, { timeoutMs: 1_000 }), backoff: quick(), onChange: o => { if (o.done) done.push(o.done.entry.input.n); } });
  t.after(() => box.stop());
  for (const n of [1, 2, 3]) await box.add("chaos.add", { n });
  await sleep(300);
  assert.deepEqual(w.applied(), [], "nothing reached the box while it was out of reach");
  assert.equal(box.pending.length, 3);
  p.heal();
  await until(() => done.length === 3, "the outbox to drain");
  assert.deepEqual(w.applied(), [1, 2, 3]);
  assert.equal(box.pending.length, 0);
});

test("R2: an answer lost on the way back is retried on another path and applied once (reordered requests)", { timeout: 20_000 }, async t => {
  const w = await world(t, 2);
  const [slow, fast] = w.proxies;
  slow.delay(700);                     // the first attempt is held up; the client gives up on it
  let tries = 0;
  const call = (tool, input, key) => (tries++ === 0 ? node.caller(slow.url, { timeoutMs: 300 }) : node.caller(fast.url))(tool, input, key);
  const box = await outbox({ store: memoryStore(), call, backoff: quick() });
  t.after(() => box.stop());
  const { answered } = await box.add("chaos.slow", { ms: 50, n: 5 });
  const r = await answered;
  assert.deepEqual(/** @type {any} */ (r).data, { n: 5 });
  await sleep(1_000);                  // the held-up original lands after the retry
  assert.deepEqual(w.applied(), [5]);
});

test("R5: a failed path moves the stream to the next one, and it moves back when the first heals", { timeout: 20_000 }, async t => {
  const w = await world(t, 2);
  const [lan, tailnet] = w.proxies;
  const f = watch(w);
  t.after(() => f.s.stop());
  await opened(f);
  assert.equal(f.s.path, lan.url);
  lan.refuse(); lan.drop();
  w.emit(1);
  await until(() => f.got.length === 1 && f.s.path === tailnet.url, "the switch to the second path");
  lan.heal();
  await until(() => f.s.path === lan.url, "the move back to the first path");
  w.emit(2);
  await until(() => f.got.length === 2, "events after moving back");
  assert.deepEqual(f.got, [1, 2]);
});

test("R7: stop lets a running write finish, turns new ones away, and the outbox lands them after", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const call = node.caller(w.proxies[0].url, { timeoutMs: 2_000 });
  const running = call("chaos.slow", { ms: 400, n: 1 }, "key-00000007");
  // The write is running in vyred before stop begins; a fixed sleep let stop win the race on a loaded machine.
  await until(() => w.d.events.since(0, { type: "chaos.started" }).length === 1, "the write to be running");
  const stopping = w.d.stop();
  await sleep(50);
  const box = await outbox({ store: memoryStore(), call, backoff: quick() });
  t.after(() => box.stop());
  const { answered } = await box.add("chaos.add", { n: 2 });
  const first = await running;
  assert.deepEqual(first.data, { n: 1 }, `the write in flight was cut off by the restart: ${JSON.stringify(first)}`);
  await stopping;
  await w.restart();
  const r = await answered;
  assert.deepEqual(/** @type {any} */ (r).data, { n: 2 });
  assert.deepEqual(w.applied(), [1, 2]);
});

test("R3: backoff runs 2 s doubling to a 60 s cap, with jitter, and resets", () => {
  const b = backoff({ random: () => 0.5 });
  assert.deepEqual(Array.from({ length: 8 }, () => b.delay()), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  b.reset();
  assert.equal(b.delay(), 2000);
  const j = backoff({ random: () => 1 });
  assert.equal(j.delay(), 2400);
});

test("R3: a paused stream closes and resume() picks up from the cursor", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const f = watch(w);
  t.after(() => f.s.stop());
  await opened(f);
  f.s.pause();
  await until(() => w.proxies[0].open === 0, "the paused stream to close");
  w.emit(1); w.emit(2);
  await sleep(200);
  assert.deepEqual(f.got, [], "a paused stream heard nothing");
  f.s.resume();
  await until(() => f.got.length === 2, "the events missed while paused");
  assert.deepEqual(f.got, [1, 2]);
});

test("R1, R7: the CLI's live screen stream comes back after a vyred restart and misses nothing", { timeout: 30_000 }, async t => {
  const { stream } = await import("../../core/cli/screen/live.js");
  const w = await world(t);
  const got = [];
  let opens = 0;
  const s = stream({ root: w.root, onOpen: () => opens++, onEvent: e => { if (e.type === "thread.text") got.push(e.payload.n); } });
  t.after(() => s.stop());
  await until(() => opens === 1, "the first open");
  await w.restart();
  w.emit(1);
  await until(() => got.length === 1, "an event after the restart", 12_000);
  assert.deepEqual(got, [1]);
  assert.ok(opens >= 2, "the screen was told to refresh on reopen");
});

// The browser side (core/resilience/web.js): the same stream client and outbox over fetch, which
// Node 22 has too, through the same fault proxies.

test("R1: the browser transport replays a gap, survives a mid-event cut and a vyred restart, and delivers each event once", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const f = watch(w, { open: web.open });
  t.after(() => f.s.stop());
  await opened(f);
  const [p] = w.proxies;
  p.refuse(); p.drop();
  w.emit(1); w.emit(2);
  await sleep(150);
  p.heal();
  await until(() => f.got.length >= 2, "the gap to replay");
  p.cutAfter(90);
  w.emit(3);
  await sleep(300);
  p.heal(); p.drop();
  await until(() => f.got.length >= 3, "the event cut mid-frame");
  await w.restart();
  w.emit(4);
  await until(() => f.got.length >= 4, "an event after the restart");
  await sleep(200);
  assert.deepEqual(f.got, [1, 2, 3, 4]);
});

test("R1: the browser transport notices a partition by the missing heartbeat", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const f = watch(w, { open: web.open });
  t.after(() => f.s.stop());
  await opened(f);
  w.proxies[0].partition();
  w.emit(1);
  await until(() => f.states.some(x => x.state === "reconnecting"), "the stall to be noticed");
  w.proxies[0].heal();
  await until(() => f.got.length >= 1, "the event held up by the partition");
  assert.deepEqual(f.got, [1]);
});

test("R5: the browser transport fails over to the next path and moves back when the first heals", { timeout: 20_000 }, async t => {
  const w = await world(t, 2);
  const [lan, tailnet] = w.proxies;
  const f = watch(w, { open: web.open });
  t.after(() => f.s.stop());
  await opened(f);
  lan.refuse(); lan.drop();
  w.emit(1);
  await until(() => f.got.length === 1 && f.s.path === tailnet.url, "the switch to the second path");
  lan.heal();
  await until(() => f.s.path === lan.url, "the move back to the first path");
  w.emit(2);
  await until(() => f.got.length === 2, "events after moving back");
  assert.deepEqual(f.got, [1, 2]);
});

test("R3: the browser lifecycle closes a hidden page's stream and resumes it from the cursor when visible", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const f = watch(w, { open: web.open });
  t.after(() => f.s.stop());
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const off = web.lifecycle(f.s, { win: new EventTarget(), doc });
  t.after(off);
  await opened(f);
  doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
  await until(() => w.proxies[0].open === 0, "the hidden page's stream to close");
  w.emit(1); w.emit(2);
  await sleep(200);
  assert.deepEqual(f.got, [], "a hidden page heard nothing");
  doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
  await until(() => f.got.length === 2, "the events missed while hidden");
  assert.deepEqual(f.got, [1, 2]);
});

test("R2: the browser caller sends the key only when given, and a retried key runs once", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const call = web.caller(w.proxies[0].url);
  assert.deepEqual((await call("chaos.key", {}, "key-00000011")).data, { key: "key-00000011" });
  assert.deepEqual((await call("chaos.key", {}, "")).data, { key: null });
  const [a, b] = await Promise.all([call("chaos.slow", { ms: 200, n: 1 }, "key-00000012"), call("chaos.slow", { ms: 200, n: 1 }, "key-00000012")]);
  const c = await call("chaos.slow", { ms: 200, n: 1 }, "key-00000012");
  assert.deepEqual([a.data, b.data, c.data], [{ n: 1 }, { n: 1 }, { n: 1 }]);
  assert.equal(/** @type {any} */ (c).replayed, true);
  assert.deepEqual(w.applied(), [1]);
});

test("R2: the browser caller answers unreachable, timeout and restarting instead of throwing", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const [p] = w.proxies;
  p.refuse();
  assert.equal((await web.caller(p.url, { timeoutMs: 2_000 })("chaos.add", { n: 1 }, "key-00000013")).error?.code, "unreachable");
  p.heal(); p.partition();
  assert.equal((await web.caller(p.url, { timeoutMs: 300 })("chaos.add", { n: 2 }, "key-00000014")).error?.code, "timeout");
  p.heal(); p.drop();
  // A running write holds vyred's stop open; a call that arrives meanwhile is told it is restarting.
  const running = web.caller(p.url)("chaos.slow", { ms: 600, n: 3 }, "key-00000015");
  await sleep(100);
  const stopping = w.d.stop();
  await sleep(50);
  assert.equal((await web.caller(p.url)("chaos.add", { n: 4 }, "key-00000016")).error?.code, "restarting");
  assert.deepEqual((await running).data, { n: 3 });
  await stopping;
  await w.restart();
});

test("R2: offline writes wait in the browser outbox and land once, in order, when the network is back", { timeout: 20_000 }, async t => {
  const w = await world(t);
  const [p] = w.proxies;
  p.refuse();
  const done = [];
  const box = await outbox({ store: memoryStore(), call: web.caller(p.url, { timeoutMs: 1_000 }), backoff: backoff({ min: 60_000, max: 60_000, jitter: 0 }),
    onChange: o => { if (o.done) done.push(o.done.entry.input.n); } });
  t.after(() => box.stop());
  const win = new EventTarget();
  const off = web.lifecycle(null, { win, doc: new EventTarget(), outbox: box });
  t.after(off);
  for (const n of [1, 2, 3]) await box.add("chaos.add", { n });
  await until(() => box.pending[0]?.state === "waiting", "the first try to fail");
  p.heal();
  win.dispatchEvent(new Event("online"));   // the 60 s backoff is skipped: the network is back
  await until(() => done.length === 3, "the outbox to drain");
  assert.deepEqual(w.applied(), [1, 2, 3]);
});

test("R6: a ring answered from a device's own schedule while the box was out of reach is never rung by the box, and the answer lands once", { timeout: 30_000 }, async t => {
  const w = await world(t);
  const [p] = w.proxies;
  const call = node.caller(p.url, { headers: { "x-vyre-caller": "deck" }, timeoutMs: 1_000 });
  const timer = /** @type {any} */ ((await call("planner.add", { kind: "timer", title: "Tea", in_ms: 4_000 })).data);
  // The device schedules the ring itself, keyed as the box's push will be.
  const up = /** @type {any} */ ((await call("planner.upcoming", {})).data);
  const entry = up.entries.find(e => e.item === timer.id);
  assert.ok(entry, "the timer is in the device's schedule");
  assert.equal(entry.key, `planner-${timer.id}-${entry.due}`);
  assert.ok(up.last_event > 0);

  // The box goes out of reach; the person answers the ring on the device, into its outbox.
  p.partition();
  const done = [];
  const box = await outbox({ store: memoryStore(), call, backoff: quick(), onChange: o => { if (o.done) done.push(o.done.data); } });
  t.after(() => box.stop());
  await box.add("planner.done", { key: entry.key });
  await sleep(400);
  p.heal();
  p.drop();
  await until(() => done.length === 1, "the answer to land when the box is back");

  // Past the moment: the box never rang it, one ack says it was answered unrung.
  await sleep(Math.max(0, entry.at - Date.now()) + 1_500);
  const of = type => w.d.events.since(0, { type, limit: 100 }).filter(e => e.payload.item === timer.id);
  assert.deepEqual(of("planner.fired"), [], "the box rang a moment the device had answered");
  const acks = of("planner.acked");
  assert.deepEqual(acks.map(e => [e.payload.key, e.payload.unrung]), [[entry.key, true]]);
  // A retry of the same answer (no key, or after the key's day) is harmless and says so.
  assert.equal(/** @type {any} */ ((await call("planner.done", { key: entry.key })).data).already, true);
  assert.equal(of("planner.acked").length, 1);
  assert.ok(!(/** @type {any} */ ((await call("planner.upcoming", {})).data)).entries.some(e => e.item === timer.id), "an answered moment leaves the schedule");
});
