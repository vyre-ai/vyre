// @ts-check
// deck/js/api.js's onResume contract (ADR 0029 R1), which the session view relies on: a reopened
// stream fires "reconnect", a `stream.reset` fires "reset" with vyred's id, and an event after the
// reset is heard although its id is below what was seen. Only the public on() and onResume() are
// used, so the test holds whatever the stream's internals are. A fake EventSource; no box.

import { test } from "node:test";
import assert from "node:assert/strict";

/** Every EventSource made, newest last. */
const made = [];
class FakeES {
  /** @param {string} url */
  constructor(url) { this.url = url; this.l = new Map(); this.readyState = 0; made.push(this); }
  addEventListener(t, f) { (this.l.get(t) || this.l.set(t, []).get(t)).push(f); }
  close() { this.readyState = 2; }
  /** @param {string} t @param {any} [ev] */
  fire(t, ev = {}) { for (const f of this.l.get(t) || []) f(ev); }
  open() { this.readyState = 1; this.fire("open"); }
  /** @param {string} type @param {number} id */
  emit(type, id, payload = {}) { this.fire(type, { data: JSON.stringify({ id, type, thread: "t-sample", at: Date.now(), payload }) }); }
}
/** @type {any} */ (FakeES).CONNECTING = 0;
/** @type {any} */ (FakeES).OPEN = 1;
/** @type {any} */ (FakeES).CLOSED = 2;

Object.assign(globalThis, {
  location: { search: "" },
  window: globalThis,
  document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  EventSource: FakeES,
  CustomEvent: class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});

const { on, onResume } = await import("../js/api.js");

const heard = [];
const resumes = [];
on("thread.*", e => heard.push(e.id));
const off = onResume((why, from) => resumes.push([why, from]));
const es = () => made[made.length - 1];

test("the first open is not a resume; a reopen fires reconnect", () => {
  es().open();
  assert.deepEqual(resumes, []);
  // The browser lost the box and came back on its own.
  es().readyState = 0; es().fire("error");
  es().open();
  assert.deepEqual(resumes, [["reconnect", undefined]]);
});

test("stream.reset fires reset with vyred's id, and events after it are heard once each", () => {
  resumes.length = 0;
  es().emit("thread.text", 40);
  es().emit("thread.text", 41);
  es().emit("thread.text", 41);
  assert.deepEqual(heard, [40, 41], "an id already seen is dropped");
  es().emit("stream.reset", 3, { from: 3, reason: "cursor_ahead" });
  assert.deepEqual(resumes, [["reset", 3]]);
  es().emit("thread.text", 4);
  es().emit("thread.sent", 5);
  es().emit("thread.text", 5);
  assert.deepEqual(heard, [40, 41, 4, 5]);
});

test("onResume returns an unsubscribe", () => {
  resumes.length = 0;
  off();
  es().emit("stream.reset", 1, { from: 1 });
  assert.deepEqual(resumes, []);
});
