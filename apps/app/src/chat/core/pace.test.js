// @ts-check
// The paced reveal (after Paseo's text-reveal): ceil(backlog * dt / 150 ms) characters a frame, at
// least one, at most one step per 60 Hz frame, a stall capped, whole on done. Time is plain numbers.

import "../../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPacer, revealStep, PACE_HORIZON_MS, PACE_FRAME_MS } from "./pace.js";

test("revealStep: proportional to the backlog, at least one, the whole backlog past the horizon", () => {
  assert.equal(revealStep(0, 16), 0);
  assert.equal(revealStep(300, 0), 0, "no time, no step");
  assert.equal(revealStep(300, 15), 30);
  assert.equal(revealStep(1, 16), 1);
  assert.equal(revealStep(5, 1), 1, "the one-character floor");
  assert.equal(revealStep(300, PACE_HORIZON_MS), 300);
  assert.equal(revealStep(300, 10_000), 300);
  assert.equal(revealStep(300, 15, 0), 300, "no horizon: everything");
  assert.equal(revealStep(1000, 100), Math.ceil(1000 * 100 / 150));
});

test("a burst drains over about the horizon, faster when further behind", () => {
  const p = createPacer();
  p.push(1000, 0);
  assert.equal(p.visible(0), 0);
  const first = p.visible(17);
  assert.equal(first, Math.ceil(1000 * 17 / 150));
  let t = 17, v = first, steps = [first];
  while (v < 1000 && t < 5000) { t += 17; const n = p.visible(t); steps.push(n - v); v = n; }
  assert.equal(v, 1000);
  assert.ok(t <= 1500, `took ${t} ms`);
  assert.ok(steps[0] > steps[steps.length - 1], "bigger steps while further behind");
});

test("at most one step per 60 Hz frame, even on a 120 Hz display", () => {
  const p = createPacer();
  p.push(10_000, 0);
  const seen = [];
  for (let t = 0; t <= 200; t += 1000 / 120) seen.push(p.visible(t));
  const changes = seen.filter((v, i) => i && v !== seen[i - 1]).length;
  assert.ok(changes <= Math.ceil(200 / PACE_FRAME_MS), `${changes} steps in 200 ms`);
  assert.ok(changes >= 8, `${changes} steps in 200 ms`);
  assert.equal(p.visible(200), p.visible(200), "the same moment twice shows the same");
});

test("a stalled clock is capped, then the backlog finishes", () => {
  const p = createPacer();
  p.push(40, 0);
  p.visible(0);
  assert.equal(p.visible(10_000), 40, "250 ms capped is past the horizon: everything");
  const q = createPacer({ horizonMs: 1000 });
  q.push(1000, 0);
  assert.equal(q.visible(10_000), 250, "a stall counts as 250 ms, not 10 s");
});

test("never goes backwards while the text grows, and keeps up with a fast model", () => {
  const p = createPacer();
  let last = 0, len = 0;
  for (let t = 0; t <= 2000; t += 16) {
    if (t % 160 === 0) { len += 40; p.push(len, t); }
    const v = p.visible(t);
    assert.ok(v >= last, `went back at ${t}`);
    last = v;
  }
  assert.ok(len - last <= 40, `lag ${len - last}`);
});

test("done shows everything; a shorter target pulls back", () => {
  const p = createPacer();
  p.push(300, 0);
  assert.ok(p.visible(20) < 300);
  assert.equal(p.settled(20), false);
  p.done();
  assert.equal(p.visible(20), 300);
  assert.equal(p.settled(20), true);
  const q = createPacer();
  q.push(100, 0);
  q.visible(1000);
  assert.equal(q.visible(1000), 100);
  q.push(20, 1000);
  assert.equal(q.visible(1000), 20);
});

test("the earlier options still read: maxLagMs is the horizon, cps is ignored", () => {
  const p = createPacer({ cps: 1, maxLagMs: 300 });
  p.push(300, 0);
  assert.equal(p.visible(20), Math.ceil(300 * 20 / 300));
});
