// @ts-check
// The perf meter on a fake clock: frame drops, percentiles, marks, gaps, the verdict and ring bounds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMeter, percentile, BAR } from "./meter.js";

const P = 1000 / 60;

function clock() {
  let t = 0;
  return { now: () => t, set: (/** @type {number} */ v) => { t = v; } };
}

/** @param {ReturnType<typeof createMeter>} m @param {ReturnType<typeof clock>} c @param {number} n */
function steady(m, c, n, start = 0) {
  let t = start;
  for (let i = 0; i < n; i++) { t = start + i * P; m.frame(t); }
  c.set(t);
  return t;
}

/** @param {ReturnType<typeof createMeter>} m @param {string} id */
const check = (m, id) => /** @type {any} */ (m.report().verdict.find(v => v.id === id));

test("steady 60 Hz drops nothing", () => {
  const c = clock();
  const m = createMeter({ now: c.now });
  steady(m, c, 600);
  const w = m.window(10000);
  assert.equal(w.frames, 600);
  assert.equal(w.dropped, 0);
  assert.equal(w.droppedPct, 0);
  assert.ok(Math.abs(w.fps - 60) < 1e-6);
  assert.ok(Math.abs(w.worstMs - P) < 1e-6);
});

test("one 50 ms interval counts 2 dropped", () => {
  const c = clock();
  const m = createMeter({ now: c.now });
  const t = steady(m, c, 10);
  m.frame(t + 50);
  c.set(t + 50);
  const w = m.window();
  assert.equal(w.dropped, 2);
  assert.equal(w.worstMs, 50);
  assert.ok(Math.abs(w.droppedPct - (2 / 12) * 100) < 1e-9);
});

test("an interval under 1.5 periods is not a drop", () => {
  const c = clock();
  const m = createMeter({ now: c.now });
  m.frame(0); m.frame(24); c.set(24);
  assert.equal(m.window().dropped, 0);
});

test("window only counts frames inside it", () => {
  const c = clock();
  const m = createMeter({ now: c.now });
  steady(m, c, 1200);
  assert.ok(m.window(1000).frames <= 61);
  assert.equal(createMeter({ now: c.now }).window().frames, 0);
});

test("percentile is nearest rank", () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 100), 100);
  assert.equal(percentile(hundred, 0), 1);
});

test("mark and measure store every sample under the name", () => {
  const c = clock();
  const m = createMeter({ now: c.now });
  m.mark("a", 10); m.mark("b", 55);
  assert.equal(m.measure("tab.switch", "a", "b"), 45);
  c.set(80);
  assert.equal(m.measure("tab.switch", "a"), 70);
  assert.equal(m.measure("tab.switch", "missing", "b"), null);
  const s = m.report().metrics["tab.switch"];
  assert.deepEqual(s, { n: 2, p50: 45, p95: 70, max: 70 });
});

test("gap records nothing on its first call", () => {
  const c = clock();
  const m = createMeter({ now: c.now });
  m.gap("stream", 100);
  assert.equal(m.report().gaps.stream, undefined);
  m.gap("stream", 130);
  m.gap("stream", 170);
  assert.deepEqual(m.report().gaps.stream, { n: 2, p50: 30, p95: 40, max: 40 });
});

test("endGap ends a run: the idle time before the next run is not a gap", () => {
  const m = createMeter({ now: () => 0 });
  m.gap("stream", 0);
  m.gap("stream", 16);
  m.endGap("stream");
  m.gap("stream", 5000);
  m.gap("stream", 5020);
  assert.deepEqual(m.report().gaps.stream, { n: 2, p50: 16, p95: 20, max: 20 });
});

test("every BAR id is present and null with no samples", () => {
  const m = createMeter({ now: () => 0 });
  const v = m.report().verdict;
  assert.deepEqual(v.map(x => x.id), ["scroll", "tabSwitch", "coldOpen", "warmResume", "approve", "keyboardJump", "streamGap", "longTasks", "terminalEcho"]);
  assert.deepEqual(BAR.map(b => b.id), v.map(x => x.id));
  for (const x of v) assert.equal(x.pass, null, x.id);
});

test("scroll passes at steady 60 Hz and fails with drops", () => {
  const c = clock();
  const good = createMeter({ now: c.now });
  steady(good, c, 600);
  assert.equal(check(good, "scroll").pass, true);

  const bad = createMeter({ now: c.now });
  let t = 0;
  for (let i = 0; i < 300; i++) { t += i % 20 === 0 ? 50 : P; bad.frame(t); }
  c.set(t);
  const s = check(bad, "scroll");
  assert.equal(s.pass, false);
  assert.ok(s.value.droppedPct >= 1);
});

/** @type {[string, string, number, number][]} id, metric, passing value, failing value */
const METRIC_CASES = [
  ["tabSwitch", "tab.switch", 99, 100],
  ["coldOpen", "open.cold", 999, 1000],
  ["warmResume", "open.warm", 299, 300],
  ["approve", "approve.collapse", 17, 18],
  ["keyboardJump", "keyboard.jump", 0, 3],
  ["terminalEcho", "term.echo", 49, 50],
];

for (const [id, name, ok, ko] of METRIC_CASES) {
  test(`${id} passes at ${ok} and fails at ${ko}`, () => {
    const m = createMeter({ now: () => 0 });
    for (let i = 0; i < 20; i++) m.record(name, ok);
    assert.equal(check(m, id).pass, true);
    assert.equal(check(m, id).value, ok);
    m.record(name, ko); m.record(name, ko);
    assert.equal(check(m, id).pass, false);
  });
}

test("streamGap passes under 50 ms and fails at 50", () => {
  const m = createMeter({ now: () => 0 });
  for (let t = 0; t <= 400; t += 40) m.gap("stream", t);
  assert.equal(check(m, "streamGap").pass, true);
  const n = createMeter({ now: () => 0 });
  for (let t = 0; t <= 500; t += 50) n.gap("stream", t);
  assert.equal(check(n, "streamGap").pass, false);
});

test("longTasks passes while streaming with none over 50 and fails with one", () => {
  const m = createMeter({ now: () => 0 });
  m.gap("stream", 0); m.gap("stream", 30);
  assert.equal(check(m, "longTasks").pass, true);
  m.longTask(40, 10);
  assert.equal(check(m, "longTasks").pass, true);
  m.longTask(51, 20);
  assert.equal(check(m, "longTasks").pass, false);
  assert.deepEqual(m.report().longTasks, { n: 2, over50: 1 });
});

test("rings stay bounded after 10,000 frames and samples", () => {
  const c = clock();
  const m = createMeter({ now: c.now });
  steady(m, c, 10000);
  assert.equal(m.window(Infinity).frames, 2000);
  for (let i = 0; i < 10000; i++) { m.record("tab.switch", i); m.gap("stream", i); m.longTask(i); }
  const r = m.report();
  assert.equal(r.metrics["tab.switch"].n, 500);
  assert.equal(r.metrics["tab.switch"].max, 9999);
  assert.equal(r.gaps.stream.n, 500);
  assert.equal(r.longTasks.n, 500);
});

test("reset clears everything", () => {
  const c = clock();
  const m = createMeter({ now: c.now });
  steady(m, c, 100);
  m.record("open.cold", 5); m.gap("stream", 1); m.gap("stream", 2); m.longTask(80);
  m.reset();
  const r = m.report();
  assert.equal(r.frames.frames, 0);
  assert.deepEqual(r.metrics, {});
  assert.deepEqual(r.gaps, {});
  assert.deepEqual(r.longTasks, { n: 0, over50: 0 });
});

test("meter: a pause (page hidden) is not counted as dropped frames", () => {
  let clock = 0;
  const m = createMeter({ now: () => clock });
  for (let i = 0; i < 60; i++) m.frame(clock = i * (1000 / 60));
  m.pause();
  m.pause();
  for (let i = 0; i < 60; i++) m.frame(clock = 5000 + i * (1000 / 60));
  const w = m.window(10000);
  assert.equal(w.dropped, 0);
  assert.equal(w.frames, 120);
  assert.ok(w.fps > 59 && w.fps < 61, String(w.fps));
});
