// @ts-check
// scripts/lib/perf-window.mjs: the idle CPU check judges the better of two windows when the first is over budget, so host load does not fail it and a real idle cost still does.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickWindow, cpuStats } from "../scripts/lib/perf-window.mjs";

const BUDGET = { cpuPct: 0.9, cpuSustainedPct: 1.8, cpuSustainedWindow: 5 };
const quiet = Array.from({ length: 40 }, (_, i) => (i % 8 === 0 ? 0.5 : 0.2));
const noisy = Array.from({ length: 40 }, (_, i) => (i < 6 ? 2.4 : 0.2));   // a neighbour's burst early in the window: p95 and the 5-sample mean both over
const busy = Array.from({ length: 40 }, () => 2.1);                        // a real, steady cost

test("a window within budget is judged as it is, and no second window is needed", () => {
  const r = pickWindow(quiet, null, BUDGET);
  assert.equal(r.chosen, "first");
  assert.equal(r.first.over, false);
});

test("a noisy first window is judged on the quiet second one", () => {
  assert.equal(cpuStats(noisy, BUDGET).over, true);
  const r = pickWindow(noisy, quiet, BUDGET);
  assert.equal(r.chosen, "second");
  assert.equal(r.second && r.second.over, false);
});

test("a real idle cost is over budget in both windows, and the check still fails", () => {
  const r = pickWindow(busy, busy, BUDGET);
  const chosen = r[r.chosen];
  assert.ok(chosen && chosen.over, "the chosen window is still over budget");
});

test("when the first window is over budget and there is no second yet, it is the one judged", () => {
  const r = pickWindow(noisy, null, BUDGET);
  assert.equal(r.chosen, "first");
  assert.equal(r.first.over, true);
});
