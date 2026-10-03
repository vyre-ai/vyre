// @ts-check
// js/context-report.js: the Deck tells cohesion's context where the person is (ADR 0036 part 2),
// only the project and thread, once per place, again on coming back, never while hidden.

import test from "node:test";
import assert from "node:assert/strict";
import { placeOf, reportContext } from "./context-report.js";

test("placeOf: the project and thread each Deck path names", () => {
  assert.deepEqual(placeOf("/projects/harlow-legal"), { project: "harlow-legal", thread: null });
  assert.deepEqual(placeOf("/projects/harlow-legal/t1"), { project: "harlow-legal", thread: "t1" });
  assert.deepEqual(placeOf("/threads/t2"), { project: null, thread: "t2" });
  assert.deepEqual(placeOf("/chat/northwind/t3?x=1#y"), { project: "northwind", thread: "t3" });
  assert.deepEqual(placeOf("/chat/thread/t4"), { project: null, thread: "t4" });
  assert.deepEqual(placeOf("/now"), { project: null, thread: null });
  assert.deepEqual(placeOf("/chat"), { project: null, thread: null });
});

/** A window and document whose events are fired by hand. */
function world() {
  /** @type {Record<string, Function[]>} */ const w = {}, d = {};
  const add = (/** @type {any} */ m) => (/** @type {string} */ t, /** @type {Function} */ f) => { (m[t] ||= []).push(f); };
  const rm = (/** @type {any} */ m) => (/** @type {string} */ t, /** @type {Function} */ f) => { m[t] = (m[t] || []).filter((/** @type {Function} */ x) => x !== f); };
  const win = { addEventListener: add(w), removeEventListener: rm(w) };
  const doc = { visibilityState: "visible", addEventListener: add(d), removeEventListener: rm(d) };
  return { win: /** @type {any} */ (win), doc: /** @type {any} */ (doc), fireW: (/** @type {string} */ t) => (w[t] || []).forEach(f => f()), fireD: (/** @type {string} */ t) => (d[t] || []).forEach(f => f()) };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test("reportContext: once per place, again on a return (focus and visibility count once), nothing while hidden", async () => {
  const sent = /** @type {any[]} */ ([]);
  let path = "/now";
  const W = world();
  const stop = reportContext({ attempt: async (n, i) => { sent.push([n, i]); return { data: {} }; }, surface: () => "phone", path: () => path, win: W.win, doc: W.doc });
  await tick();
  assert.deepEqual(sent, [["context.report", { surface: "phone", project: null, thread: null }]]);
  W.fireW("deck:navigate");
  await tick();
  assert.equal(sent.length, 1, "the same place again: nothing");
  path = "/chat/harlow-legal/t1";
  W.fireW("deck:navigate");
  await tick();
  assert.deepEqual(sent.at(-1), ["context.report", { surface: "phone", project: "harlow-legal", thread: "t1" }]);
  W.doc.visibilityState = "hidden";
  path = "/agents";
  W.fireW("deck:navigate");
  W.fireD("visibilitychange");
  await tick();
  assert.equal(sent.length, 2, "hidden: nothing");
  W.doc.visibilityState = "visible";
  W.fireD("visibilitychange");
  W.fireW("focus");
  await tick();
  assert.equal(sent.length, 3, "one return, one report");
  assert.deepEqual(Object.keys(sent[2][1]).sort(), ["project", "surface", "thread"], "never text, selection or a URL; no device until the hub names one");
  stop();
});

test("reportContext: a server without context is asked once", async () => {
  let asked = 0, path = "/now";
  const W = world();
  reportContext({ attempt: async () => { asked++; return { error: { code: "no_such_tool" } }; }, surface: () => "deck", path: () => path, win: W.win, doc: W.doc });
  await tick();
  path = "/projects/harlow-legal";
  W.fireW("deck:navigate");
  W.fireW("focus");
  await tick();
  assert.equal(asked, 1);
});

test("reportContext: the device settings.snapshot echoed goes with the report", async () => {
  const sent = /** @type {any[]} */ ([]);
  const W = world();
  reportContext({ attempt: async (n, i) => { sent.push(i); return { data: {} }; }, surface: () => "phone", path: () => "/now", device: () => "tailnet:alex-phone", win: W.win, doc: W.doc });
  await tick();
  assert.deepEqual(sent, [{ surface: "phone", project: null, thread: null, device: "tailnet:alex-phone" }]);
});
