// @ts-check
// deck/js/api.js's shared event stream (ADR 0029 R1): a `stream.reset` lowers the cursor so later
// events are heard, a reopened stream says so to onResume, and a stream the browser gave up on
// (CLOSED) is opened again with a backoff, from the last id seen, only while the page is visible.
// A fake EventSource and fake timers; no box.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const docListeners = new Map();
const doc = {
  visibilityState: "visible",
  addEventListener: (t, f) => { (docListeners.get(t) || docListeners.set(t, new Set()).get(t)).add(f); },
  removeEventListener: (t, f) => { docListeners.get(t)?.delete(f); },
};
const fire = t => { for (const f of [...(docListeners.get(t) || [])]) f(); };

/** Every EventSource made, newest last. */
const made = [];
class FakeES {
  /** @param {string} url */
  constructor(url) { this.url = url; this.l = new Map(); this.readyState = 0; this.closed = false; made.push(this); }
  addEventListener(t, f) { (this.l.get(t) || this.l.set(t, []).get(t)).push(f); }
  close() { this.closed = true; this.readyState = 2; }
  /** @param {string} t @param {any} [ev] */
  fire(t, ev = {}) { for (const f of this.l.get(t) || []) f(ev); }
  open() { this.readyState = 1; this.fire("open"); }
  /** @param {string} type @param {number} id */
  emit(type, id, payload = {}) { this.fire(type, { data: JSON.stringify({ id, type, thread: "t-sample", at: Date.now(), payload }) }); }
  gaveUp() { this.readyState = 2; this.fire("error"); }
}
/** @type {any} */ (FakeES).CONNECTING = 0;
/** @type {any} */ (FakeES).OPEN = 1;
/** @type {any} */ (FakeES).CLOSED = 2;

Object.assign(globalThis, {
  location: { search: "" },
  window: globalThis,
  document: doc,
  EventSource: FakeES,
  CustomEvent: class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});

mock.timers.enable({ apis: ["setTimeout"] });
const { on, onResume } = await import("../js/api.js");

const heard = [];
const resumes = [];
on("thread.*", e => heard.push(e.id));
onResume((why, from) => resumes.push([why, from]));
const es = () => made[made.length - 1];

test("the first stream starts at the newest event", () => {
  assert.equal(made.length, 1);
  assert.match(es().url, /since=latest/);
  es().open();
  assert.deepEqual(resumes, [], "the first open is not a resume");
});

test("an id at or below the last one is dropped; stream.reset lowers the cursor so later events are heard", () => {
  es().emit("thread.text", 40);
  es().emit("thread.text", 41);
  es().emit("thread.text", 41);
  assert.deepEqual(heard, [40, 41]);
  // vyred's store was reset: it follows from 3.
  es().emit("stream.reset", 3, { from: 3, reason: "cursor_ahead" });
  assert.deepEqual(resumes, [["reset", 3]]);
  es().emit("thread.text", 4);
  es().emit("thread.sent", 5);
  es().emit("thread.text", 5);
  assert.deepEqual(heard, [40, 41, 4, 5], "events after the reset are heard, and still once each");
});

test("the browser's own reconnect is a resume", () => {
  resumes.length = 0;
  es().readyState = 0; es().fire("error");
  es().open();
  assert.deepEqual(resumes, [["reconnect", undefined]]);
  assert.equal(made.length, 1, "the browser retried; no new EventSource");
});

test("a stream the browser gave up on is opened again, 1 s then doubling, from the last id seen", () => {
  resumes.length = 0;
  const first = es();
  first.gaveUp();
  assert.equal(first.closed, true);
  mock.timers.tick(999);
  assert.equal(made.length, 1);
  mock.timers.tick(1);
  assert.equal(made.length, 2);
  assert.match(es().url, /since=5\b/);
  // It fails again before opening: 2 s this time.
  es().gaveUp();
  mock.timers.tick(1999);
  assert.equal(made.length, 2);
  mock.timers.tick(1);
  assert.equal(made.length, 3);
  es().open();
  assert.deepEqual(resumes, [["reconnect", undefined]]);
  es().emit("thread.text", 6);
  assert.equal(heard.at(-1), 6, "the new stream delivers to the same subscribers");
  // Old streams are ignored.
  made[0].emit("thread.text", 99);
  assert.notEqual(heard.at(-1), 99);
});

test("backoff caps at 30 s and resets after an open", () => {
  let n = made.length;
  es().gaveUp();                     // 1 s after the open above
  mock.timers.tick(1000); assert.equal(made.length, ++n);
  for (const ms of [2000, 4000, 8000, 16000, 30000, 30000]) {
    es().gaveUp();
    mock.timers.tick(ms - 1); assert.equal(made.length, n, `not before ${ms} ms`);
    mock.timers.tick(1); assert.equal(made.length, ++n, `at ${ms} ms`);
  }
  es().open();
  es().gaveUp();
  mock.timers.tick(1000); assert.equal(made.length, ++n, "1 s again after an open");
  es().open();
});

test("while the page is hidden nothing is opened; it opens when the page is visible again", () => {
  const n = made.length;
  doc.visibilityState = "hidden";
  es().gaveUp();
  mock.timers.tick(60_000);
  assert.equal(made.length, n, "no retry while hidden");
  doc.visibilityState = "visible";
  fire("visibilitychange");
  assert.equal(made.length, n + 1, "opened at once when visible");
  assert.match(es().url, /since=6\b/);
});
