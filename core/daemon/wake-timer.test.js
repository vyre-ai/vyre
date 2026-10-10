import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createWakeTimer } from "./wake-timer.js";

/** A clock and timers by hand: three minutes of an idle box in no time. */
function rig(nextWake) {
  let t = 0; const timers = new Map(); let id = 0; const calls = { nextWake: 0, tick: 0 };
  const w = createWakeTimer({ nextWake: async () => { calls.nextWake++; return typeof nextWake === "function" ? nextWake(t) : nextWake; }, tick: async () => { calls.tick++; }, now: () => t,
    setTimer: (f, ms) => { const k = ++id; timers.set(k, { f, at: t + ms }); return k; }, clearTimer: k => timers.delete(k) });
  const advance = async ms => { const end = t + ms; for (;;) { const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); t = due[1].at; due[1].f(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); } t = end; };
  return { w, calls, advance, timers };
}

test("an idle box (nothing due) asks the store once to arm and then nothing for three minutes", async () => {
  const r = rig(null);
  await r.w.arm();
  assert.equal(r.calls.nextWake, 1);
  await r.advance(3 * 60_000);
  assert.deepEqual(r.calls, { nextWake: 1, tick: 0 }, "no look, no tick, no records query");
});

test("a wake that is due sleeps exactly until then, ticks once, and looks again", async () => {
  let due = 90_000;
  const r = rig(() => (due > 0 ? due : null));
  await r.w.arm();
  await r.advance(89_000); assert.equal(r.calls.tick, 0);
  due = 0;
  await r.advance(2_000);
  assert.equal(r.calls.tick, 1);
  assert.equal(r.calls.nextWake, 2);
});

test("an event that moves the next wake up wakes the timer sooner (a short wait on a quiet box), at most once a second", async () => {
  let next = null;
  const r = rig(() => next);
  await r.w.arm();
  next = 3_000; await r.advance(2_000);
  await r.w.poke();
  await r.advance(1_500);
  assert.equal(r.calls.tick, 1, "the 3 second wait came due on time, not after the long sleep");
  const before = r.calls.nextWake; for (let i = 0; i < 5; i++) await r.w.poke();
  assert.ok(r.calls.nextWake - before <= 2, "pokes within a second share one look (and the re-arm it causes)");
});
