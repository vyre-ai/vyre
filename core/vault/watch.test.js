// @ts-check
// watch tests: a fake watcher child that prints the signals a test asks for, and a fake clock for
// the wall-clock gap check. Nothing here waits on a real sleep or screen lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LockWatch, TICK_MS } from "./watch.js";
import { Helper } from "./mac/helper.js";
import { writeFakes } from "./mac/fakes.js";
import { SCRATCH } from "../../test/scratch.mjs";

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(20); }
  throw new Error("timed out waiting");
}

function rig(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-watch-"));
  const f = writeFakes(dir);
  const clock = { t: 0 };
  const ticks = new Set();
  const heard = [];
  const w = new LockWatch({
    helper: new Helper({ name: "watch", dir, command: f.helpers.watch }), platform: "darwin", role: "local",
    onSignal: why => heard.push(why), now: () => clock.t,
    timers: { every: fn => { ticks.add(fn); return fn; }, cancel: fn => { ticks.delete(fn); } },
    ...opts,
  });
  t.after(() => { w.idle(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = s => fs.writeFileSync(f.state.trigger, s);
  const tick = ms => { clock.t += ms; for (const fn of ticks) fn(); };
  return { w, heard, send, tick, ticks };
}

test("signals from the watcher lock; each config switch covers its own signals", async t => {
  const { w, heard, send } = rig(t);
  await w.ensure();
  send("screen-lock");
  await until(() => heard.length === 1);
  send("sleep");
  await until(() => heard.length === 2);
  send("nonsense");
  await wait(100);
  assert.deepEqual(heard, ["screen-lock", "sleep"]);

  const only = rig(t, { onScreenLock: false });
  await only.w.ensure();
  only.send("screen-lock");
  await wait(100);
  only.send("sleep");
  await until(() => only.heard.length === 1);
  assert.deepEqual(only.heard, ["sleep"]);
});

test("the gap check runs once a minute and notices a machine that slept", async t => {
  const { w, heard, tick, ticks } = rig(t);
  await w.ensure();
  assert.equal(ticks.size, 1, "one interval");
  tick(TICK_MS);
  tick(TICK_MS + 5000);
  assert.deepEqual(heard, [], "a late timer is not sleep");
  tick(30 * 60_000);
  assert.deepEqual(heard, ["wake-gap"]);
});

test("idle stops the child and the timer; ensure starts them once", async t => {
  const { w, ticks } = rig(t);
  await w.ensure();
  await w.ensure();
  assert.equal(ticks.size, 1);
  const c = w.child;
  assert.ok(c);
  w.idle();
  assert.equal(ticks.size, 0);
  assert.equal(w.child, null);
  await until(() => c.exitCode !== null || c.signalCode !== null);
});

test("no native watcher off a Mac, in the box role, or with both switches off", async t => {
  for (const o of [{ platform: "linux" }, { role: "box" }, { onSleep: false, onScreenLock: false }]) {
    const { w, ticks } = rig(t, o);
    await w.ensure();
    assert.equal(w.child, null, JSON.stringify(o));
    if (o.onSleep === false) assert.equal(ticks.size, 0, "no gap check without onSleep");
  }
});
