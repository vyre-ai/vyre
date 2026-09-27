// @ts-check
// Windowed rendering in the session view, with a long session: 2,000 turns from a generated
// fixture, in the fake DOM (deck/test/fake-dom.js) given a tiny layout engine (rows stack in the
// timeline, each as tall as its kind and text say), so heights are measured the way a browser
// would give them. Asserts the mounted rows stay bounded, a streaming reply touches only the tail,
// the reading position holds while detached (a reply streams, history loads above), Jump to
// latest mounts the tail again, and a deep link mounts its row first. Prints the numbers.
// Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.addEventListener = () => {};
doc.removeEventListener = () => {};
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
const store = new Map();
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
  addEventListener: () => {}, removeEventListener: () => {},
  localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
});

const El = /** @type {any} */ (globalThis).Element;
const E = El.prototype;
const sibs = n => (n.parentNode ? n.parentNode.childNodes : []);
Object.defineProperties(E, {
  previousElementSibling: { get() { const s = sibs(this); for (let i = s.indexOf(this) - 1; i >= 0; i--) if (s[i] instanceof El) return s[i]; return null; } },
  nextElementSibling: { get() { const s = sibs(this); for (let i = s.indexOf(this) + 1; i < s.length; i++) if (s[i] instanceof El) return s[i]; return null; } },
  nextSibling: { get() { const s = sibs(this); return s[s.indexOf(this) + 1] || null; } },
  lastElementChild: { get() { const c = this.children; return c[c.length - 1] || null; } },
});
E.insertBefore = function (n, ref) { if (!ref) { this.append(n); return n; } n.remove(); this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); n.parentNode = this; return n; };
E.replaceWith = function (n) { const p = this.parentNode; if (!p) return; p.insertBefore(n, this); this.remove(); };
E.after = function (n) { this.parentNode.insertBefore(n, this.nextSibling); };

// ---- a tiny layout engine: the timeline's children stack with no gap -----------------------

/** @type {any} */ let timeline = null;
const VIEW = 800;
const has = (el, c) => el.className.split(/\s+/).includes(c);
/** How tall a row is: by kind, a reply by its length, a spacer by its style. */
function heightOf(el) {
  if (el.hidden) return 0;
  if (has(el, "cv-spacer")) return parseFloat(el.style.height) || 0;
  if (has(el, "day-rule")) return 24;
  if (has(el, "cv-head")) return 28;
  if (has(el, "cv-user")) return 70;
  if (has(el, "cv-text")) return 24 + 20 * Math.ceil(el.textContent.length / 60);
  if (has(el, "cv-think")) return 32;
  if (has(el, "cv-run")) return has(el, "cv-run") && el.hasAttribute("data-open") ? 200 : 34;
  if (has(el, "cv-turn")) return 22;
  if (has(el, "cv-tool")) return 60;
  return 40;
}
/** The timeline's child that holds `el`. */
function rowOf(el) { let n = el; while (n && n.parentNode !== timeline) n = n.parentNode; return n; }
function topOf(row) {
  let y = 0;
  for (const c of timeline.childNodes) { if (c === row) break; if (c instanceof El) y += heightOf(c); }
  return y;
}
const total = () => timeline.childNodes.reduce((n, c) => n + (c instanceof El ? heightOf(c) : 0), 0);
E.getBoundingClientRect = function () {
  if (this === timeline) return { top: 0, height: VIEW, bottom: VIEW };
  const row = rowOf(this);
  if (!row) return { top: 0, height: 0, bottom: 0 };
  const top = topOf(row) - timeline._st;
  const height = row === this ? heightOf(row) : 0;
  return { top, height, bottom: top + height };
};
E.scrollIntoView = function () { const row = timeline && rowOf(this); if (row) timeline.scrollTop = topOf(row) + heightOf(row) / 2 - VIEW / 2; };
function layoutTimeline(el) {
  timeline = el;
  el._st = 0;
  Object.defineProperty(el, "clientHeight", { get: () => VIEW });
  Object.defineProperty(el, "scrollHeight", { get: () => total() });
  Object.defineProperty(el, "scrollTop", { get: () => el._st, set: v => { el._st = Math.max(0, Math.min(Number(v) || 0, Math.max(0, total() - VIEW))); } });
}
/** The row at the top of the viewport and where it sits. */
function firstVisible() {
  let y = 0;
  for (const c of timeline.childNodes) {
    if (!(c instanceof El)) continue;
    const h = heightOf(c);
    if (y + h > timeline._st && !has(c, "cv-spacer") && h > 0) return { el: c, top: y - timeline._st };
    y += h;
  }
  return null;
}

// ---- mutations: which connected nodes a change touched ------------------------------------

let touched = /** @type {any[] | null} */ (null);
for (const m of ["append", "insertBefore", "replaceChildren", "setAttribute", "removeAttribute"]) {
  const orig = E[m];
  E[m] = function (...a) { if (touched && this.isConnected) touched.push(this); return orig.apply(this, a); };
}
const origRemove = E.remove;
E.remove = function () { if (touched && this.isConnected) touched.push(this.parentNode); return origRemove.call(this); };

// ---- a 2,000-turn session ---------------------------------------------------------------------

const TURNS = 2000;
const SID = "7c3d1e55-long-session";
const T0 = Date.now() - TURNS * 60_000;
function turnBlocks(i, seq) {
  const ts = T0 + i * 60_000;
  return [
    { seq: seq, kind: "user", ts, text: `Step ${i}: update the Harlow Legal intake for case ${i}` },
    { seq: seq + 1, kind: "thinking", ts: ts + 1000, text: "Check the form first." },
    { seq: seq + 2, kind: "text", ts: ts + 2000, message: `msg_${i}_a`, text: `Looking at the intake for case ${i}.` },
    { seq: seq + 3, kind: "tool", ts: ts + 3000, id: `toolu_${i}_r`, tool: "Read", input: { file_path: `/home/alex/work/harlow-legal/intake/${i}.js` }, output: "ok", error: false, done_ts: ts + 3100, duration_ms: 100 },
    { seq: seq + 4, kind: "tool", ts: ts + 4000, id: `toolu_${i}_b`, tool: "Bash", input: { command: "npm test" }, output: "# pass 3", error: false, done_ts: ts + 5000, duration_ms: 1000 },
    { seq: seq + 5, kind: "text", ts: ts + 6000, message: `msg_${i}_b`, text: `Done with case ${i}. The tests pass and the Northwind Bakery form is untouched.` },
    { seq: seq + 5, kind: "turn", ts, duration_ms: 6000, tokens: { input: 1200, output: 80 }, model: "sample-model" },
  ];
}
const all = [];
for (let i = 0; i < TURNS; i++) all.push(...turnBlocks(i, i * 6));
/** The box's first read is the tail from HOLD turns back; Load earlier reads the rest. */
const HOLD = 1500;
const firstSeq = (TURNS - HOLD) * 6;
const tail = all.filter(b => b.seq >= firstSeq);
const older = all.filter(b => b.seq < firstSeq);

const calls = [];
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  const input = JSON.parse(o.body);
  calls.push({ tool, input });
  let data;
  if (tool === "threads.get") data = { thread: { id: SID, name: "long intake run", cwd: "/home/alex/work/harlow-legal", status: "idle", holder: null, agent: null }, events: [], asks: [] };
  else if (tool === "recall.transcript") {
    if (input.before != null) data = { session: { id: SID }, blocks: older, next: TURNS * 6, first: 0 };
    else data = { session: { id: SID, cwd: "/home/alex/work/harlow-legal" }, blocks: input.from ? [] : tail, next: TURNS * 6, first: firstSeq };
  } else if (tool === "threads.asks") data = [];
  else if (tool === "memory.facts") data = { facts: [] };
  else data = {};
  return { status: 200, statusText: "", json: async () => ({ data }) };
});

let evId = 0;
class FakeES { constructor() { FakeES.last = this; this.l = new Map(); this.readyState = 1; } addEventListener(t, f) { (this.l.get(t) || this.l.set(t, []).get(t)).push(f); } }
/** @type {any} */ (FakeES).OPEN = 1;
Object.assign(globalThis, { EventSource: FakeES });
const emit = (type, payload, thread = SID) => { for (const f of FakeES.last.l.get(type) || []) f({ data: JSON.stringify({ id: ++evId, type, thread, at: Date.now(), payload }) }); };
const wait = (ms = 10) => new Promise(r => setTimeout(r, ms));
/** Until a condition holds (boot reads over fetch), at most `ms`. */
async function until(fn, ms = 5000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timed out"); await wait(5); } }
/** The reader scrolls: a wheel turned up first when the view goes up (only the reader's own intent detaches it). */
const scrollTo = y => {
  if (y < timeline.scrollTop) timeline.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: -120 }));
  timeline.scrollTop = y;
  timeline.dispatchEvent(new Event("scroll"));
};
const mountedRows = () => timeline.children.filter(c => !has(c, "cv-spacer") && has(c, "cv-row") || has(c, "day-rule")).length;

const { mountSession } = await import("./session.js");
const perf = /** @type {Record<string, any>} */ ({});

const container = new El("div");
doc.body.append(container);
const t0 = performance.now();
const stop = mountSession(container, { thread: SID, project: null, onBack() {} });
layoutTimeline($(container, ".cv-timeline"));
await until(() => $(container, ".cv-user"));
perf.openMs = Math.round(performance.now() - t0);

test("a 1,500-turn tail opens windowed: the mounted rows stay under 150, stuck to the bottom", () => {
  assert.ok(timeline.classList.contains("cv-windowed"));
  const n = mountedRows();
  perf.mountedAtOpen = n;
  perf.childrenAtOpen = timeline.children.length;
  assert.ok(n > 5 && n < 150, `mounted ${n}`);
  assert.ok(timeline.children.length < 150);
  assert.equal(timeline.scrollTop + VIEW, timeline.scrollHeight, "at the bottom");
  assert.match(text(timeline.children.at(-2)), /Done with case 1999|1\.2k in/, "the last turn is mounted");
});

test("history loads above without a jump, and the whole 2,000 turns stay bounded", async () => {
  scrollTo(500);
  await wait(40);
  const before = firstVisible();
  assert.ok(before);
  const btn = $(container, ".cv-earlier button");
  assert.ok(btn, "Load earlier");
  const t = performance.now();
  await btn.click();
  await until(() => $(container, ".cv-earlier").hidden);
  perf.loadEarlierMs = Math.round(performance.now() - t);
  const after = firstVisible();
  assert.equal(after.el, before.el, "the same row at the top");
  assert.ok(Math.abs(after.top - before.top) < 1, `moved ${after.top - before.top} px`);
  assert.ok(timeline.scrollTop > 100_000, "the older 500 turns are above, as spacer");
  const n = mountedRows();
  perf.mountedAfterHistory = n;
  assert.ok(n < 150, `mounted ${n}`);
});

test("scrolling through history keeps the window bounded and the rows real", async () => {
  let max = 0;
  const t = performance.now();
  for (let y = 0; y < timeline.scrollHeight; y += 20_000) {
    scrollTo(y);
    await wait(20);
    max = Math.max(max, mountedRows());
    const f = firstVisible();
    assert.ok(f && !has(f.el, "cv-spacer"), `a real row at the top at ${y}`);
  }
  perf.scrollSweepMs = Math.round(performance.now() - t);
  perf.maxMountedWhileScrolling = max;
  assert.ok(max < 150, `at most ${max} mounted`);
});

test("detached: a streaming reply at the tail does not move what is read", async () => {
  scrollTo(timeline.scrollHeight / 2);
  await wait(40);
  const before = firstVisible();
  emit("thread.sent", { text: "One more: case 2000", surface: "deck" });
  // A message typed into the session brings the reader down to it (the view's rule): scroll back.
  scrollTo(timeline.scrollHeight / 2);
  await wait(40);
  const mid = firstVisible();
  emit("thread.text", { message: "msg_x", delta: "Working on case 2000. " });
  for (let i = 0; i < 5; i++) { emit("thread.text", { message: "msg_x", delta: "More words about the Harlow Legal intake. " }); await wait(20); }
  const after = firstVisible();
  assert.equal(after.el, mid.el);
  assert.ok(Math.abs(after.top - mid.top) < 1);
  assert.ok(before);
  assert.equal($(container, ".jump-latest").hidden, false, "the pill says there is more below");
});

test("stuck: content that moves the view up without the reader (a clamp, a shrink) does not detach", async () => {
  await $(container, ".jump-latest").click();
  await wait(40);
  // A scroll event that moves up with no wheel, key, touch or scrollbar behind it.
  timeline.scrollTop = timeline.scrollTop - 300;
  timeline.dispatchEvent(new Event("scroll"));
  emit("thread.text", { message: "msg_x", delta: "Still following. " });
  await wait(60);
  assert.equal(timeline.scrollTop + VIEW, timeline.scrollHeight, "back at the bottom");
  assert.equal($(container, ".jump-latest").hidden, true);
  // An upward wheel does detach; scrolling back to the bottom sticks again.
  scrollTo(timeline.scrollTop - 400);
  emit("thread.text", { message: "msg_x", delta: "More while reading above. " });
  await wait(60);
  assert.ok(timeline.scrollTop + VIEW < timeline.scrollHeight - 100, "the reader stays where they went");
  scrollTo(timeline.scrollHeight);
  emit("thread.text", { message: "msg_x", delta: "Back at the tail. " });
  await wait(60);
  assert.equal(timeline.scrollTop + VIEW, timeline.scrollHeight, "stuck again");
  // Leave it detached for the next test, as the one before left it.
  scrollTo(timeline.scrollHeight / 2);
  emit("thread.text", { message: "msg_x", delta: "And more. " });
  await wait(60);
});

test("Jump to latest mounts the tail and sticks again", async () => {
  await $(container, ".jump-latest").click();
  await wait(40);
  assert.equal(timeline.scrollTop + VIEW, timeline.scrollHeight);
  assert.ok($(container, ".cv-live"), "the streaming reply is mounted");
  assert.ok(mountedRows() < 150);
});

test("stuck to the bottom, a streaming update touches only the tail row", async () => {
  const live = $(container, ".cv-live");
  assert.ok(live);
  const children = [...timeline.childNodes];
  touched = [];
  const t = performance.now();
  for (let i = 0; i < 20; i++) { emit("thread.text", { message: "msg_x", delta: `Line ${i} of the reply. ` }); await wait(20); }
  perf.streamMs = Math.round(performance.now() - t);
  const inTimeline = touched.filter(n => n === timeline || rowOf(n));
  const outside = inTimeline.filter(n => rowOf(n) !== live);
  perf.streamMutations = inTimeline.length;
  touched = null;
  assert.ok(inTimeline.length > 0, "the reply grew");
  assert.deepEqual(outside.map(n => n.className || n.tagName), [], "nothing but the tail row changed");
  assert.deepEqual([...timeline.childNodes], children, "no row mounted, moved or unmounted");
  assert.equal(timeline.scrollTop + VIEW, timeline.scrollHeight, "still at the bottom");
  emit("thread.text", { message: "msg_x", text: "Done.", done: true });
  emit("thread.finished", { ok: true, duration_ms: 1000, tokens: { input: 10, output: 5 } });
  await wait(30);
});

test("a deep link to a tool far up mounts its stretch first and opens its fold", async () => {
  const box = new El("div");
  doc.body.append(box);
  const saved = timeline;
  const stop2 = mountSession(box, { thread: SID, project: null, tool: `toolu_${TURNS - HOLD + 3}_b`, onBack() {} });
  layoutTimeline($(box, ".cv-timeline"));
  await until(() => $(box, ".cv-run[data-open]"), 5000);
  const run = $(box, ".cv-run[data-open]");
  assert.match(text(run), /npm test/);
  assert.ok($(box, ".cv-flash"), "flashed");
  assert.ok(mountedRows() < 150);
  assert.ok(timeline.scrollTop + VIEW < timeline.scrollHeight - 1000, "not at the bottom: the reader is on the link");
  stop2();
  timeline = saved;
});

test("the numbers", () => {
  stop();
  const mem = process.memoryUsage();
  perf.heapMB = Math.round(mem.heapUsed / 1e6);
  console.log("window perf " + JSON.stringify(perf));
});
