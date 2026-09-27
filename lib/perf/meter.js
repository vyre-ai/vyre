// @ts-check
// Frame meter and metric recorder, shared by the one app (ADR 0027) and the Deck's native-bar
// harness. A pure helper: no DOM, no React, no RN, no imports. The app's web feeds it from
// requestAnimationFrame, native from Reanimated's useFrameCallback, both by pushing timestamps in
// ms. Every store is a bounded ring, so a long session never grows it.

const FRAME_CAP = 2000;
const SAMPLE_CAP = 500;
const LONG_TASK_MS = 50;

/**
 * @typedef {'frames'|'metrics'|'gaps'|'longTasks'} Source
 * @typedef {'<'|'<='|'>='|'=='} Op
 * @typedef {{ source: Source, name?: string, stat: string, op: Op, limit: number }} Test
 * @typedef {{ id: string, text: string, tests: Test[], windowMs?: number, nb?: number }} Bar
 *   nb: the row of docs/design/native-bar.md's budget table this check is (the same number there).
 * @typedef {{ frames: number, dropped: number, droppedPct: number, fps: number, worstMs: number, p95Ms: number }} FrameStats
 * @typedef {{ n: number, p50: number|null, p95: number|null, max: number|null }} Summary
 * @typedef {{ id: string, bar: string, value: number|Record<string, number|null>|null, pass: boolean|null }} Check
 */

/** The acceptance criteria. A check passes when every one of its tests holds. @type {readonly Bar[]} */
export const BAR = Object.freeze(/** @type {Bar[]} */ ([
  { id: "scroll", text: "dropped frames under 1% over 10 s, fps at least 58", windowMs: 10000, tests: [
    { source: "frames", stat: "droppedPct", op: "<", limit: 1 },
    { source: "frames", stat: "fps", op: ">=", limit: 58 },
  ] },
  { id: "tabSwitch", text: "p95 tab.switch under 100 ms", tests: [{ source: "metrics", name: "tab.switch", stat: "p95", op: "<", limit: 100 }] },
  { id: "coldOpen", text: "p95 open.cold under 1000 ms", tests: [{ source: "metrics", name: "open.cold", stat: "p95", op: "<", limit: 1000 }] },
  { id: "warmResume", text: "p95 open.warm under 300 ms", tests: [{ source: "metrics", name: "open.warm", stat: "p95", op: "<", limit: 300 }] },
  { id: "approve", text: "p95 approve.collapse at most 17 ms (same frame at 60 Hz)", tests: [{ source: "metrics", name: "approve.collapse", stat: "p95", op: "<=", limit: 17 }] },
  { id: "keyboardJump", text: "max keyboard.jump equals 0 px", tests: [{ source: "metrics", name: "keyboard.jump", stat: "max", op: "==", limit: 0 }] },
  { id: "streamGap", text: "p95 stream gap under 50 ms", tests: [{ source: "gaps", name: "stream", stat: "p95", op: "<", limit: 50 }] },
  { id: "longTasks", text: "no long task over 50 ms while streaming", tests: [{ source: "longTasks", stat: "over50", op: "==", limit: 0 }] },
  { id: "terminalEcho", text: "p95 term.echo under 50 ms", tests: [{ source: "metrics", name: "term.echo", stat: "p95", op: "<", limit: 50 }] },
  // The native bar (docs/design/native-bar.md): nb is the budget's row in its table.
  { id: "keystroke", nb: 1, text: "p95 keystroke to paint under 16 ms", tests: [{ source: "metrics", name: "keystroke", stat: "p95", op: "<", limit: 16 }] },
  { id: "firstToken", nb: 2, text: "p95 first streamed token painted under 100 ms after the event arrives", tests: [{ source: "metrics", name: "stream.first", stat: "p95", op: "<", limit: 100 }] },
  { id: "boxToScreen", nb: 3, text: "p95 box to screen for the first token under 250 ms", tests: [{ source: "metrics", name: "stream.box", stat: "p95", op: "<", limit: 250 }] },
  { id: "streamCV", nb: 4, text: "characters per frame while streaming: coefficient of variation under 2", tests: [{ source: "metrics", name: "stream.cpf", stat: "cv", op: "<", limit: 2 }] },
  { id: "streamGapBar", nb: 4, text: "p95 stream gap under 250 ms", tests: [{ source: "gaps", name: "stream", stat: "p95", op: "<", limit: 250 }] },
  { id: "cls", nb: 5, text: "layout shift of rows above the live row equals 0", tests: [{ source: "metrics", name: "cls", stat: "max", op: "==", limit: 0 }] },
  { id: "viewJump", nb: 5, text: "scrolled up, the viewport moves 0 px while the tail changes", tests: [{ source: "metrics", name: "view.jump", stat: "max", op: "==", limit: 0 }] },
  { id: "openSessionCache", nb: 7, text: "p95 open a session to its last rows from cache under 300 ms", tests: [{ source: "metrics", name: "open.session.cache", stat: "p95", op: "<", limit: 300 }] },
  { id: "openSessionCold", nb: 7, text: "p95 open a session from cold under 1000 ms", tests: [{ source: "metrics", name: "open.session.cold", stat: "p95", op: "<", limit: 1000 }] },
  { id: "send", nb: 9, text: "p95 Send to the user row painted under 50 ms", tests: [{ source: "metrics", name: "send.paint", stat: "p95", op: "<", limit: 50 }] },
  { id: "stop", nb: 10, text: "p95 Stop to the state chip changed under 100 ms", tests: [{ source: "metrics", name: "stop.paint", stat: "p95", op: "<", limit: 100 }] },
  // Chat's budgets, the ids native-core judges its chat by. The metric names are the ones the app
  // already marks, so one run feeds both the rows above and these; only keystroke.work and the
  // reconnect.* pair are new names.
  { id: "chat.keystroke", text: "p95 keystroke work (input handler start to the end of its synchronous work) under 16 ms", tests: [{ source: "metrics", name: "keystroke.work", stat: "p95", op: "<", limit: 16 }] },
  { id: "chat.keystrokePaint", text: "p95 keystroke to the next paint under 33 ms", tests: [{ source: "metrics", name: "keystroke", stat: "p95", op: "<", limit: 33 }] },
  { id: "chat.firstToken", text: "p95 first token painted under 100 ms after it arrives", tests: [{ source: "metrics", name: "stream.first", stat: "p95", op: "<", limit: 100 }] },
  { id: "chat.streamGap", text: "p95 stream gap under 50 ms", tests: [{ source: "gaps", name: "stream", stat: "p95", op: "<", limit: 50 }] },
  { id: "chat.scrollJump", text: "scrolled up, the viewport moves 0 px", tests: [{ source: "metrics", name: "view.jump", stat: "max", op: "==", limit: 0 }] },
  { id: "chat.send", text: "p95 send to the user row painted under 50 ms", tests: [{ source: "metrics", name: "send.paint", stat: "p95", op: "<", limit: 50 }] },
  { id: "chat.stop", text: "p95 Esc (or Stop) to stopped shown under 100 ms", tests: [{ source: "metrics", name: "stop.paint", stat: "p95", op: "<", limit: 100 }] },
  { id: "chat.reconnect", text: "p95 reconnect to caught up under 1000 ms, and the viewport moves 0 px", tests: [
    { source: "metrics", name: "reconnect.catchup", stat: "p95", op: "<", limit: 1000 },
    { source: "metrics", name: "reconnect.jump", stat: "max", op: "==", limit: 0 },
  ] },
]).map(b => Object.freeze(b)));

/**
 * Nearest-rank percentile of an ascending array. p is 0 to 100. Null when empty.
 * @param {readonly number[]} sorted @param {number} p @returns {number|null}
 */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const i = Math.ceil((p / 100) * n) - 1;
  return sorted[Math.min(n - 1, Math.max(0, i))];
}

/** @param {number[]} values @returns {Summary} */
function summarize(values) {
  const s = values.slice().sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s.length ? s[s.length - 1] : null };
}

/**
 * Coefficient of variation (standard deviation over the mean, population). Null when empty or
 * the mean is 0.
 * @param {readonly number[]} values @returns {number|null}
 */
export function cv(values) {
  const n = values.length;
  if (!n) return null;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  if (!mean) return null;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return Math.sqrt(sq / n) / mean;
}

/** @param {number} v @param {Op} op @param {number} limit */
function holds(v, op, limit) {
  if (op === "<") return v < limit;
  if (op === "<=") return v <= limit;
  if (op === ">=") return v >= limit;
  return v === limit;
}

/** @param {Map<string, number[]>} store @param {string} name @param {number} v */
function push(store, name, v) {
  let arr = store.get(name);
  if (!arr) store.set(name, arr = []);
  arr.push(v);
  if (arr.length > SAMPLE_CAP) arr.splice(0, arr.length - SAMPLE_CAP);
}

/** @param {Map<string, number[]>} store */
function summaries(store) {
  /** @type {Record<string, Summary>} */ const out = {};
  for (const [name, values] of store) out[name] = summarize(values);
  return out;
}

/** @param {{ refreshHz?: number, now?: () => number }} [opts] */
export function createMeter({ refreshHz = 60, now = () => performance.now() } = {}) {
  const period = 1000 / refreshHz;
  const ring = new Float64Array(FRAME_CAP);
  let head = 0, count = 0;
  /** @type {Map<string, number>} */ const marks = new Map();
  /** @type {Map<string, number[]>} */ const metrics = new Map();
  /** @type {Map<string, number>} */ const lastGap = new Map();
  /** @type {Map<string, number[]>} */ const gaps = new Map();
  /** @type {number[]} */ let longTasks = [];

  /** @param {number} interval */
  const droppedIn = interval => interval > 1.5 * period ? Math.round(interval / period) - 1 : 0;

  /** @param {number} t */
  function frame(t) {
    ring[head] = t;
    head = (head + 1) % FRAME_CAP;
    if (count < FRAME_CAP) count++;
  }

  /** A break (the page hidden, the app backgrounded): the next frame starts a new run, so the gap is not counted as dropped frames. */
  function pause() {
    if (count && Number.isNaN(ring[(head - 1 + FRAME_CAP) % FRAME_CAP])) return;
    frame(NaN);
  }

  /** @param {number} [ms] @returns {FrameStats} */
  function window(ms = 10000) {
    const from = now() - ms;
    /** @type {number[]} */ const intervals = [];
    let frames = 0, dropped = 0, span = 0, prev = NaN;
    for (let k = 0; k < count; k++) {
      const t = ring[(head - count + k + FRAME_CAP) % FRAME_CAP];
      if (Number.isNaN(t)) { prev = NaN; continue; }
      if (t < from) continue;
      frames++;
      if (!Number.isNaN(prev)) {
        const iv = t - prev;
        intervals.push(iv);
        span += iv;
        dropped += droppedIn(iv);
      }
      prev = t;
    }
    const expected = intervals.length + dropped;
    intervals.sort((a, b) => a - b);
    return {
      frames,
      dropped,
      droppedPct: expected ? (dropped / expected) * 100 : 0,
      fps: span > 0 ? (intervals.length * 1000) / span : 0,
      worstMs: intervals.length ? intervals[intervals.length - 1] : 0,
      p95Ms: percentile(intervals, 95) ?? 0,
    };
  }

  /** @param {string} name @param {number} [t] */
  function mark(name, t = now()) { marks.set(name, t); }

  /** Duration between two marks, stored under name. The end mark defaults to now. Null when the start mark is missing. @param {string} name @param {string} startMark @param {string} [endMark] @returns {number|null} */
  function measure(name, startMark, endMark) {
    const start = marks.get(startMark);
    const end = endMark === undefined ? now() : marks.get(endMark);
    if (start === undefined || end === undefined) return null;
    const ms = end - start;
    push(metrics, name, ms);
    return ms;
  }

  /** A value measured some other way, such as keyboard.jump in px. @param {string} name @param {number} value */
  function record(name, value) { push(metrics, name, value); }

  /** @param {string} name @param {number} [t] */
  function gap(name, t = now()) {
    const last = lastGap.get(name);
    lastGap.set(name, t);
    if (last !== undefined) push(gaps, name, t - last);
  }

  /** The run of updates is over (a reply finished): the next gap(name) starts a new run, so the idle time between runs is not a gap. @param {string} name */
  function endGap(name) { lastGap.delete(name); }

  /** t is the task's start, taken for the caller's timeline; the verdict uses only ms. @param {number} ms @param {number} [t] */
  function longTask(ms, t) {
    longTasks.push(ms);
    if (longTasks.length > SAMPLE_CAP) longTasks.splice(0, longTasks.length - SAMPLE_CAP);
  }

  /** @param {Test} test @param {FrameStats} fw @returns {number|null} */
  function valueOf(test, fw) {
    if (test.source === "frames") return fw.frames < 2 ? null : /** @type {any} */ (fw)[test.stat];
    if (test.source === "longTasks") {
      // Judged only once something streamed or a long task was seen; otherwise there is nothing to judge.
      if (!longTasks.length && !gaps.has("stream")) return null;
      return longTasks.filter(ms => ms > LONG_TASK_MS).length;
    }
    const values = (test.source === "metrics" ? metrics : gaps).get(/** @type {string} */ (test.name));
    if (!values || !values.length) return null;
    if (test.stat === "cv") return cv(values);
    return /** @type {any} */ (summarize(values))[test.stat];
  }

  /** @returns {Check[]} */
  function verdict() {
    return BAR.map(b => {
      const fw = window(b.windowMs ?? 10000);
      const values = b.tests.map(t => valueOf(t, fw));
      const pass = values.some(v => v === null) ? null : b.tests.every((t, i) => holds(/** @type {number} */ (values[i]), t.op, t.limit));
      /** @type {Check['value']} */ let value;
      if (b.tests.length === 1) value = values[0];
      else value = Object.fromEntries(b.tests.map((t, i) => [t.stat, values[i]]));
      return { id: b.id, bar: b.text, value, pass };
    });
  }

  function report() {
    return {
      at: now(),
      refreshHz,
      frames: window(10000),
      metrics: summaries(metrics),
      gaps: summaries(gaps),
      longTasks: { n: longTasks.length, over50: longTasks.filter(ms => ms > LONG_TASK_MS).length },
      verdict: verdict(),
    };
  }

  function reset() {
    head = 0; count = 0;
    marks.clear(); metrics.clear(); lastGap.clear(); gaps.clear();
    longTasks = [];
  }

  return { frame, pause, window, mark, measure, record, gap, endGap, longTask, report, reset };
}
