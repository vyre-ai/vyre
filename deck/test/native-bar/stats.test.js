// @ts-check
// The native bar's pure helpers. Runs without Chrome:
//   node --test "deck/test/native-bar/stats.test.js"
import test from "node:test";
import assert from "node:assert/strict";
import { percentile, p95, mean, cv, streamGate, frameStats, rng, burstText, burstPlan } from "./stats.js";

test("p95 is the nearest-rank 95th percentile, ignoring non-numbers", () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(p95(xs), 95);
  assert.equal(p95([5]), 5);
  assert.equal(p95([]), null);
  assert.equal(p95([3, NaN, 1, 2]), 3);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 0), 10);
});

test("coefficient of variation is population sd over the mean", () => {
  assert.equal(cv([4, 4, 4]), 0);
  assert.equal(cv([]), null);
  assert.equal(cv([0, 0]), null);
  // mean 5, population sd 3 (values 2 and 8)
  assert.equal(cv([2, 8]), 0.6);
  assert.equal(mean([1, 2, 3]), 2);
});

test("streamGate counts zero frames in the rhythm and times gaps between visible updates", () => {
  const even = Array.from({ length: 11 }, (_, i) => ({ t: i * 16, len: i * 3 }));
  const g = streamGate(even);
  assert.equal(g.cv, 0);
  assert.equal(g.p95Gap, 16);
  const lumpy = [{ t: 0, len: 0 }, { t: 16, len: 0 }, { t: 32, len: 0 }, { t: 48, len: 90 }, { t: 64, len: 90 }, { t: 80, len: 90 }, { t: 96, len: 180 }];
  const l = streamGate(lumpy);
  assert.ok(Math.abs(/** @type {number} */ (l.cv) - Math.SQRT2) < 1e-9, `lumpy cv ${l.cv}`);
  assert.equal(l.p95Gap, 48);
});

test("frameStats reports p95 frame time and dropped frames at 60 Hz", () => {
  const f = frameStats([0, 16.7, 33.4, 83.5, 100.2]);
  assert.equal(f.frames, 4);
  assert.equal(f.dropped, 2);
  assert.ok(Math.abs(/** @type {number} */ (f.max) - 50.1) < 0.01);
});

test("the burst is deterministic, has a fence, a list and a table, and batches of 20 to 400 characters", () => {
  const a = burstText(7, "[bar-7]"), b = burstText(7, "[bar-7]");
  assert.equal(a, b);
  assert.notEqual(a, burstText(8, "[bar-7]"));
  assert.match(a, /^```js$/m); assert.match(a, /^- /m); assert.match(a, /^\| Item \| Price/m);
  const plan = burstPlan(a, 7);
  assert.deepEqual(plan, burstPlan(a, 7));
  assert.equal(plan.map(p => p.text).join(""), a);
  for (const p of plan.slice(0, -1)) assert.ok(p.text.length >= 20 && p.text.length <= 400, `batch ${p.text.length}`);
  for (const p of plan.slice(1)) assert.ok(p.wait >= 50 && p.wait < 250);
  const ms = plan.reduce((s, p) => s + p.wait, 0);
  assert.ok(ms > 3000 && ms < 12000, `stream lasts ${ms} ms`);
  const r = rng(1);
  assert.ok(r() >= 0 && r() < 1);
});

test("thresholdP95 is exact when enough events were reported, and a bound when not", async () => {
  const { thresholdP95 } = await import("./stats.js");
  // 200 events, 20 reported at 16..35: rank 190 is the 10th reported value.
  const rep = Array.from({ length: 20 }, (_, i) => 16 + i);
  assert.deepEqual(thresholdP95(rep, 200, 16), { value: 25, under: false });
  // 10 reported of 200: rank 190 falls among the unreported, so the p95 is under 16.
  assert.deepEqual(thresholdP95(rep.slice(0, 10), 200, 16), { value: null, under: true });
  assert.deepEqual(thresholdP95([], 200, 16), { value: null, under: true });
  // values under the threshold in the list are not counted as reported
  assert.deepEqual(thresholdP95([3, 40], 2, 16), { value: 40, under: false });
});
