// @ts-check
// The mock session: cadence of text deltas (about 40 tokens a second), gapless cursors, the scripted
// turn's contents, the queue, the approval gate, and resume. Loaded through Node's type stripping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFolder } from "./frames.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./mock-stream.ts");

/** A fake scheduler: timers run in time order when `run` is called. */
function fake() {
  let now = 0;
  /** @type {{ at: number, fn: () => void, id: number }[]} */ const q = [];
  let id = 0;
  return {
    now: () => now,
    setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { q.push({ at: now + ms, fn, id: ++id }); return id; },
    clearTimer: (/** @type {number} */ h) => { const i = q.findIndex((t) => t.id === h); if (i >= 0) q.splice(i, 1); },
    run(/** @type {number} */ until) {
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!q.length || q[0].at > until) break;
        const t = q.shift();
        if (!t) break;
        now = t.at;
        t.fn();
      }
      now = until;
    },
  };
}

test("text deltas arrive at about 40 tokens a second", { skip: !strip }, async () => {
  const { script } = await load();
  const segs = script({ tps: 40 });
  const a1 = segs[0].steps.filter((s) => s.type === "text-delta" && s.data.message === "a1");
  assert.ok(a1.length > 8);
  const gaps = a1.slice(1).map((s, i) => s.at - a1[i].at);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(mean > 22 && mean < 28, `mean gap ${mean}`);
  const perSec = 1000 / mean;
  assert.ok(perSec > 36 && perSec < 44, `tokens per second ${perSec}`);
});

test("frames carry gapless cursors and fold into every kind of row", { skip: !strip }, async () => {
  const { createMockStream } = await load();
  const k = fake();
  const m = createMockStream({ now: k.now, setTimer: k.setTimer, clearTimer: k.clearTimer });
  const folder = createFolder();
  const curs = [];
  m.connect({ from: 0, onFrame: (f) => { curs.push(f.cur); folder.apply(f); } });
  k.run(60000);
  assert.deepEqual(curs, curs.map((_, i) => i + 1), "gapless from 1");
  assert.equal(folder.status.state, "asking", "waits at the approval");
  const kinds = new Set([...folder.rows].map((r) => r.kind));
  for (const kind of ["user", "text", "block", "ask"]) assert.ok(kinds.has(kind), kind);
  const blocks = new Set(folder.rows.map((r) => folder.item(r.key)?.block?.block).filter(Boolean));
  for (const b of ["terminal", "diff", "record"]) assert.ok(blocks.has(b), b);
  assert.equal(folder.queue().length, 0, "the queued message was picked up");
  assert.equal(folder.item("u:m2")?.pickedUp, true);
  m.answer("k1", "approve");
  k.run(120000);
  assert.equal(folder.status.state, "waiting");
  const after = new Set(folder.rows.map((r) => folder.item(r.key)?.block?.block).filter(Boolean));
  for (const b of ["answer", "draft", "flow-change", "diff"]) assert.ok(after.has(b), b);
});

test("a queued message shows in the queue while working, then is picked up at a tool boundary", { skip: !strip }, async () => {
  const { createMockStream } = await load();
  const k = fake();
  const m = createMockStream({ now: k.now, setTimer: k.setTimer, clearTimer: k.clearTimer });
  const seen = [];
  m.connect({ from: 0, onFrame: (f) => seen.push(f) });
  k.run(300);
  m.send("one more thing");
  const queued = seen.find((f) => f.type === "session.user-message" && f.data.text === "one more thing");
  assert.equal(queued?.data.state, "queued");
  k.run(2500);
  const pick = seen.find((f) => f.type === "session.user-message" && f.data.message === queued?.data.message && f.data.state === "picked-up");
  assert.ok(pick, "picked up");
  const before = seen[seen.indexOf(pick) - 1];
  assert.equal(before.type, "session.tool-finished", "at a safe point, never mid-tool");
});

test("resume replays only what is after the cursor", { skip: !strip }, async () => {
  const { createMockStream } = await load();
  const k = fake();
  const m = createMockStream({ now: k.now, setTimer: k.setTimer, clearTimer: k.clearTimer });
  const first = [];
  const c = m.connect({ from: 0, onFrame: (f) => first.push(f.cur) });
  k.run(2000);
  c.close();
  const have = first[first.length - 1];
  const replay = [];
  m.connect({ from: have - 5, onFrame: (f) => replay.push(f.cur) });
  assert.deepEqual(replay, [have - 4, have - 3, have - 2, have - 1, have].filter((n) => n <= m.log.length));
});

test("startAt fast-forwards the first segment at connect", { skip: !strip }, async () => {
  const { createMockStream } = await load();
  const k = fake();
  const m = createMockStream({ startAt: 3000, now: k.now, setTimer: k.setTimer, clearTimer: k.clearTimer });
  let n = 0;
  m.connect({ from: 0, onFrame: () => n++ });
  assert.ok(n > 20, `frames at connect ${n}`);
});

test("history frames fold to the requested message count", { skip: !strip }, async () => {
  const { historyFrames } = await load();
  const f = createFolder();
  f.applyAll(historyFrames(1000));
  assert.ok(f.rows.length >= 1000 && f.rows.length < 1010, String(f.rows.length));
});

test("stop emits a stopped status and ends the script", { skip: !strip }, async () => {
  const { createMockStream } = await load();
  const k = fake();
  const m = createMockStream({ now: k.now, setTimer: k.setTimer, clearTimer: k.clearTimer });
  const seen = [];
  m.connect({ from: 0, onFrame: (f) => seen.push(f) });
  k.run(500);
  m.stop();
  const n = seen.length;
  k.run(5000);
  assert.equal(seen.length, n);
  assert.equal(seen[n - 1].data.state, "stopped");
});
