// @ts-check
// The perf meter on a fake clock: frame drops, percentiles, marks, gaps, the verdict and ring bounds.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMeter, percentile, cv, BAR } from "./meter.js";

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
  assert.deepEqual(v.map(x => x.id), ["scroll", "tabSwitch", "coldOpen", "warmResume", "approve", "keyboardJump", "streamGap", "longTasks", "terminalEcho",
    "keystroke", "firstToken", "boxToScreen", "streamCV", "streamGapBar", "cls", "viewJump", "openSessionCache", "openSessionCold", "send", "stop",
    "chat.keystroke", "chat.keystrokePaint", "chat.firstToken", "chat.streamGap", "chat.scrollJump", "chat.send", "chat.stop", "chat.reconnect"]);
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
  ["keystroke", "keystroke", 15, 16],
  ["firstToken", "stream.first", 99, 100],
  ["boxToScreen", "stream.box", 249, 250],
  ["cls", "cls", 0, 0.01],
  ["viewJump", "view.jump", 0, 1],
  ["openSessionCache", "open.session.cache", 299, 300],
  ["openSessionCold", "open.session.cold", 999, 1000],
  ["send", "send.paint", 49, 50],
  ["stop", "stop.paint", 99, 100],
  ["chat.keystroke", "keystroke.work", 15, 16],
  ["chat.keystrokePaint", "keystroke", 32, 33],
  ["chat.firstToken", "stream.first", 99, 100],
  ["chat.scrollJump", "view.jump", 0, 1],
  ["chat.send", "send.paint", 49, 50],
  ["chat.stop", "stop.paint", 99, 100],
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

test("the native bar's checks name their row in native-bar.md", () => {
  const nb = Object.fromEntries(BAR.filter(b => b.nb).map(b => [b.id, b.nb]));
  assert.deepEqual(nb, { keystroke: 1, firstToken: 2, boxToScreen: 3, streamCV: 4, streamGapBar: 4, cls: 5, viewJump: 5,
    openSessionCache: 7, openSessionCold: 7, send: 9, stop: 10 });
});

test("cv is the standard deviation over the mean, null when empty or the mean is 0", () => {
  assert.equal(cv([]), null);
  assert.equal(cv([0, 0]), null);
  assert.equal(cv([3, 3, 3]), 0);
  assert.ok(Math.abs(/** @type {number} */ (cv([1, 3])) - 0.5) < 1e-12);
});

test("streamCV passes on an even reveal and fails on lumps", () => {
  const m = createMeter({ now: () => 0 });
  for (let i = 0; i < 60; i++) m.record("stream.cpf", 2 + (i % 3));
  assert.equal(check(m, "streamCV").pass, true);
  const n = createMeter({ now: () => 0 });
  // One lump of 400 characters in 60 frames that showed 1: the jagged paint the pacer prevents.
  for (let i = 0; i < 60; i++) n.record("stream.cpf", 1);
  n.record("stream.cpf", 400);
  const c = check(n, "streamCV");
  assert.equal(c.pass, false);
  assert.ok(c.value > 2);
});

test("streamGapBar passes under 250 ms where the phone's streamGap (50 ms) fails", () => {
  const m = createMeter({ now: () => 0 });
  for (let t = 0; t <= 2000; t += 100) m.gap("stream", t);
  assert.equal(check(m, "streamGapBar").pass, true);
  assert.equal(check(m, "streamGap").pass, false);
  const n = createMeter({ now: () => 0 });
  for (let t = 0; t <= 2500; t += 250) n.gap("stream", t);
  assert.equal(check(n, "streamGapBar").pass, false);
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


test("chat.streamGap is 50 ms, the same as the phone's streamGap", () => {
  const m = createMeter({ now: () => 0 });
  for (let t = 0; t <= 400; t += 40) m.gap("stream", t);
  assert.equal(check(m, "chat.streamGap").pass, true);
  const n = createMeter({ now: () => 0 });
  for (let t = 0; t <= 500; t += 50) n.gap("stream", t);
  assert.equal(check(n, "chat.streamGap").pass, false);
});

test("chat.reconnect needs caught up under 1000 ms and 0 px of jump", () => {
  const m = createMeter({ now: () => 0 });
  m.record("reconnect.catchup", 400);
  assert.equal(check(m, "chat.reconnect").pass, null, "no jump sample yet");
  m.record("reconnect.jump", 0);
  assert.deepEqual(check(m, "chat.reconnect"), { id: "chat.reconnect", bar: check(m, "chat.reconnect").bar, value: { p95: 400, max: 0 }, pass: true });
  m.record("reconnect.jump", 2);
  assert.equal(check(m, "chat.reconnect").pass, false);
  const slow = createMeter({ now: () => 0 });
  slow.record("reconnect.catchup", 1000); slow.record("reconnect.jump", 0);
  assert.equal(check(slow, "chat.reconnect").pass, false);
});

test("chat.keystrokePaint (33 ms) passes where the native bar's keystroke (16 ms) fails", () => {
  const m = createMeter({ now: () => 0 });
  for (let i = 0; i < 20; i++) m.record("keystroke", 20);
  assert.equal(check(m, "chat.keystrokePaint").pass, true);
  assert.equal(check(m, "keystroke").pass, false);
});

test("the chat budgets have no nb and keep the rows above as they were", () => {
  const chat = BAR.filter(b => b.id.startsWith("chat."));
  assert.equal(chat.length, 8);
  for (const b of chat) assert.equal(b.nb, undefined, b.id);
});
