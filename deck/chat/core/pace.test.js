// @ts-check
// The paced reveal: steady at the display rate, faster when behind, never more than maxLagMs
// behind what arrived, whole on done. Time is plain numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPacer, PACE_MAX_LAG_MS } from "./pace.js";

test("reveals at the steady rate when text arrives slowly", () => {
  const p = createPacer({ cps: 100, maxLagMs: 1000 });
  p.push(1000, 0);
  assert.equal(p.visible(0), 0);
  // 100 cps would be 10 characters in 100 ms, but a 1000-character backlog drains over 1 s.
  const a = p.visible(100);
  assert.ok(a >= 10, `${a}`);
  const slow = createPacer({ cps: 100, maxLagMs: 100_000 });
  slow.push(1000, 0);
  assert.equal(slow.visible(100), 10);
  assert.equal(slow.visible(200), 20);
  assert.equal(slow.visible(200), 20, "the same moment twice shows the same");
});

test("never more than maxLagMs behind what had arrived", () => {
  const p = createPacer({ cps: 10, maxLagMs: 250 });
  p.push(500, 0);
  for (let t = 16; t <= 250; t += 16) p.visible(t);
  assert.equal(p.visible(250), 500);
  p.push(900, 300);
  assert.ok(p.visible(400) < 900);
  assert.equal(p.visible(550), 900);
});

test("a stalled clock does not stall the reveal past the bound", () => {
  const p = createPacer();
  p.push(40, 0);
  p.visible(0);
  assert.equal(p.visible(10_000), 40);
});

test("never goes backwards while the text grows, and speeds up when behind", () => {
  const p = createPacer({ cps: 50, maxLagMs: 250 });
  let last = 0, len = 0;
  const steps = [];
  for (let t = 0; t <= 2000; t += 16) {
    if (t % 160 === 0) { len += 40; p.push(len, t); }
    const v = p.visible(t);
    assert.ok(v >= last, `went back at ${t}`);
    steps.push(v - last);
    last = v;
  }
  // 40 characters every 160 ms is 250 cps, well past 50: it keeps up anyway.
  assert.ok(len - last <= 40 * 2, `lag ${len - last}`);
});

test("done shows everything; a shorter target pulls back", () => {
  const p = createPacer({ cps: 1 });
  p.push(300, 0);
  assert.ok(p.visible(50) < 300);
  assert.equal(p.settled(50), false);
  p.done();
  assert.equal(p.visible(50), 300);
  assert.equal(p.settled(50), true);
  const q = createPacer({ cps: 1000, maxLagMs: PACE_MAX_LAG_MS });
  q.push(100, 0);
  q.visible(1000);
  q.push(20, 1000);
  assert.equal(q.visible(1000), 20);
});
