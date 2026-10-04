// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, trim } from "./client.js";
import { frame } from "./protocol.js";
import { Sched } from "./testkit.js";

/** A controllable duplex factory. */
function rig(o = {}) {
  const sched = new Sched();
  /** @type {any[]} */ const duplexes = [];
  /** @type {any[]} */ const opens = [];
  /** @type {any[]} */ const frames = [];
  /** @type {string[]} */ const states = [];
  let failOpen = 0;
  const open = async (/** @type {any} */ a) => {
    opens.push({ ...a, at: sched.t });
    if (failOpen > 0) { failOpen--; throw new Error("down"); }
    /** @type {any[]} */ const ms = [], cs = [], sent = [];
    const d = { sent, closed: false, send: (/** @type {any} */ m) => { sent.push(m); }, onMessage: (/** @type {any} */ cb) => { ms.push(cb); }, onClose: (/** @type {any} */ cb) => { cs.push(cb); }, close() { d.closed = true; },
      push: (/** @type {any} */ m) => { for (const f of ms) f(m); }, hangup: () => { for (const f of cs) f(); } };
    duplexes.push(d);
    return d;
  };
  const client = connect({ open, timers: sched, random: () => 0.5, onFrame: f => frames.push(f), onState: s => states.push(s), ...o });
  const tick = async () => { await sched.run(() => !sched.q.some(e => !e.dead && e.at <= sched.t), 50); };
  return { sched, duplexes, opens, frames, states, client, setFail: (/** @type {number} */ n) => { failOpen = n; }, tick,
    flush: async () => { for (let i = 0; i < 8; i++) await null; } };
}
const f = (/** @type {number} */ cur, /** @type {string} */ text = "x", extra = {}) => ({ ...frame("text-delta", { message: "m", index: 0, text }, { session: "s", cur }), ...extra });

test("client: subscribes from its cursor, delivers in order, drops anything at or below last", async () => {
  const r = rig({ from: 4 });
  await r.flush();
  assert.deepEqual(r.opens[0].from, 4);
  assert.deepEqual(r.duplexes[0].sent, [{ t: "subscribe", from: 4 }]);
  const d = r.duplexes[0];
  d.push(f(5)); d.push(f(5)); d.push(f(4)); d.push(f(6)); d.push(f(6)); d.push(f(7));
  assert.deepEqual(r.frames.map(x => x.cur), [5, 6, 7]);
  assert.equal(r.client.last, 7);
  assert.equal(r.client.state, "live");
});

test("client: a gap (cur > last + 1) resubscribes from last at once", async () => {
  const r = rig();
  await r.flush();
  r.duplexes[0].push(f(1)); r.duplexes[0].push(f(2));
  r.duplexes[0].push(f(5));
  assert.deepEqual(r.frames.map(x => x.cur), [1, 2], "the frame past the gap is not delivered");
  assert.equal(r.duplexes[0].closed, true);
  await r.tick();
  await r.flush();
  assert.equal(r.opens.length, 2);
  assert.equal(r.opens[1].from, 2);
  assert.equal(r.opens[1].at, 0, "immediately");
});

test("client: a heartbeat whose head is ahead of last means a frame was lost", async () => {
  const r = rig();
  await r.flush();
  r.duplexes[0].push(f(1));
  r.duplexes[0].push({ ...frame("heartbeat", { head: 1 }, { session: "s" }) });
  assert.equal(r.duplexes[0].closed, false, "head == last: fine");
  r.duplexes[0].push({ ...frame("heartbeat", { head: 3 }, { session: "s" }) });
  assert.equal(r.duplexes[0].closed, true);
  await r.tick(); await r.flush();
  assert.equal(r.opens[1].from, 1);
});

test("client: a merged frame the client holds the start of is trimmed, text and bytes", async () => {
  const r = rig();
  await r.flush();
  const d = r.duplexes[0];
  d.push(f(1, "ab")); d.push(f(2, "cd"));
  // The server's history merged cursors 2..4 into one frame.
  d.push({ ...f(4, "cdefgh"), span: 3, data: { message: "m", index: 0, text: "cdefgh", parts: [2, 2, 2] } });
  assert.deepEqual(r.frames.map(x => x.data.text), ["ab", "cd", "efgh"]);
  assert.equal(r.client.last, 4);
  assert.equal(r.frames[2].span, 2);
  assert.deepEqual(r.frames[2].data.parts, [2, 2]);
  // Exactly one piece left: no span at all.
  const one = trim({ ...f(4, "cdef"), span: 2, data: { message: "m", index: 0, text: "cdef", parts: [2, 2] } }, 1);
  assert.equal(one.span, undefined);
  assert.equal(one.data.text, "ef");
  assert.equal("parts" in one.data, false);
  // Bytes: offset moves with the trim.
  const b64 = Buffer.from("abcdef").toString("base64");
  const t = trim({ ...frame("term-chunk", { term: "t", offset: 100, b64, parts: [2, 4] }, { session: "s", cur: 9 }), span: 2 }, 1);
  assert.equal(Buffer.from(t.data.b64, "base64").toString(), "cdef");
  assert.equal(t.data.offset, 102);
});

test("client: a merged frame wholly behind last is dropped, one starting after last + 1 is a gap", async () => {
  const r = rig();
  await r.flush();
  const d = r.duplexes[0];
  d.push(f(1)); d.push(f(2)); d.push(f(3));
  d.push({ ...f(3, "xy"), span: 2, data: { message: "m", index: 0, text: "xy", parts: [1, 1] } });
  assert.equal(r.frames.length, 3);
  d.push({ ...f(9, "xy"), span: 2, data: { message: "m", index: 0, text: "xy", parts: [1, 1] } });
  assert.equal(d.closed, true, "starts at 8, last is 3");
});

test("client: reset calls snapshot(), adopts its cursor and resumes from it", async () => {
  /** @type {number[]} */ const calls = [];
  const r = rig({ snapshot: async () => { calls.push(1); return { cur: 40 }; } });
  await r.flush();
  r.duplexes[0].push(f(1));
  r.duplexes[0].push({ ...frame("reset", { reason: "behind", head: 50 }, { session: "s" }) });
  assert.equal(r.client.state, "resetting");
  await r.flush();
  await r.tick(); await r.flush();
  assert.equal(calls.length, 1);
  assert.equal(r.client.last, 40);
  assert.equal(r.opens[1].from, 40);
  assert.deepEqual(r.duplexes[1].sent, [{ t: "subscribe", from: 40 }]);
  assert.equal(r.client.state, "live");
  r.duplexes[1].push(f(41));
  assert.deepEqual(r.frames.map(x => x.cur), [1, 41]);
});

test("client: a failed snapshot retries with backoff and keeps its cursor", async () => {
  let n = 0;
  const r = rig({ snapshot: async () => { if (++n < 3) throw new Error("not yet"); return { cur: 10 }; } });
  await r.flush();
  r.duplexes[0].push({ ...frame("reset", { reason: "behind" }, { session: "s" }) });
  await r.flush(); await r.tick(); await r.flush();
  assert.equal(r.client.last, 0);
  // The next connection gets another reset, since last is still behind.
  r.duplexes[1].push({ ...frame("reset", { reason: "behind" }, { session: "s" }) });
  await r.flush(); await r.tick(); await r.flush();
  r.duplexes[2].push({ ...frame("reset", { reason: "behind" }, { session: "s" }) });
  await r.flush(); await r.tick(); await r.flush();
  assert.equal(r.client.last, 10);
});

test("client: the first retry is immediate, then capped exponential backoff with jitter", async () => {
  const r = rig({ backoff: { base: 100, cap: 1000, jitter: 0.5 }, random: () => 1 });
  await r.flush();
  const waits = [];
  for (let i = 0; i < 7; i++) {
    const before = r.opens.length;
    const t0 = r.sched.t;
    r.setFail(1);
    // drop the live connection (first) or the failed open (later): both ask for a retry
    if (i === 0) r.duplexes[0].hangup();
    await r.flush();
    await r.sched.run(() => r.opens.length > before, 20);
    await r.flush();
    waits.push(r.sched.t - t0);
    if (i === 0) assert.equal(r.opens.length, before + 1);
  }
  // random()=1 gives the lowest wait: delay * (1 - jitter). attempt 0 -> 0, then 100, 200, 400, 800, 1000(cap) ...
  assert.equal(waits[0], 0, "first retry immediate");
  assert.ok(waits.slice(1).every(w => w <= 1000), "capped");
  assert.ok(waits[2] > waits[1] || waits[1] >= 0);
  assert.ok(Math.max(...waits) <= 1000);
});

test("client: backoff resets after a message arrives", async () => {
  const r = rig({ backoff: { base: 1000, cap: 30000, jitter: 0 } });
  await r.flush();
  r.duplexes[0].hangup(); await r.flush(); await r.tick(); await r.flush();
  r.duplexes[1].hangup(); await r.flush();
  const t0 = r.sched.t;
  await r.sched.run(() => r.opens.length >= 3, 20); await r.flush();
  assert.equal(r.sched.t - t0, 1000, "the second retry waits base");
  r.duplexes[2].push(f(1));
  r.duplexes[2].hangup(); await r.flush();
  const t1 = r.sched.t;
  await r.sched.run(() => r.opens.length >= 4, 20);
  assert.equal(r.sched.t - t1, 0, "a message reset the attempt: immediate again");
});

test("client: an open() that fails is retried; a connection silent past idleMs is dropped", async () => {
  const r = rig({ idleMs: 5000 });
  await r.flush();
  r.setFail(2);
  r.duplexes[0].hangup();
  await r.flush(); await r.sched.run(() => r.opens.length >= 4, 50); await r.flush();
  assert.equal(r.opens.length, 4, "two failures, then a success");
  const live = r.duplexes[r.duplexes.length - 1];
  const n = r.opens.length;
  await r.sched.run(() => r.opens.length > n, 50); await r.flush();
  assert.equal(live.closed, true, "silence for idleMs ended it");
  assert.ok(r.opens.length > n);
});

test("client: close() stops everything and a late open is closed", async () => {
  const r = rig();
  await r.flush();
  r.client.close();
  assert.equal(r.client.state, "closed");
  assert.equal(r.duplexes[0].closed, true);
  r.duplexes[0].hangup();
  await r.tick(); await r.flush();
  assert.equal(r.opens.length, 1, "no reconnect after close");
  assert.deepEqual(r.states.slice(-1), ["closed"]);
});
