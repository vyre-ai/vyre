// @ts-check
// Row folding: frames in, rows and items out; dedupe by cursor; queued messages; asks; resets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFolder, headerState, busyState } from "./frames.js";

let cur = 0;
/** @param {string} type @param {any} data */
const fr = (type, data) => ({ v: 1, id: "x" + cur, cur: ++cur, session: "s", turn: "t", type: "session." + type, time: 0, corr: "t", data });

test("text deltas fold into one row and grow it", () => {
  cur = 0;
  const f = createFolder();
  const a = f.apply(fr("text-delta", { message: "a1", index: 0, text: "Hel" }));
  assert.equal(a.layout, true);
  assert.deepEqual(a.appended, { key: "a:a1", length: 3 });
  const b = f.apply(fr("text-delta", { message: "a1", index: 1, text: "lo" }));
  assert.equal(b.layout, false, "a delta on a known row is not a layout change");
  assert.equal(f.item("a:a1")?.text, "Hello");
  f.apply(fr("text-done", { message: "a1" }));
  assert.equal(f.item("a:a1")?.done, true);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rev("a:a1"), 3);
});

test("frames at or below the cursor are dropped, a gap is flagged", () => {
  cur = 0;
  const f = createFolder();
  const one = fr("text-delta", { message: "a", index: 0, text: "x" });
  f.apply(one);
  assert.equal(f.apply(one).dup, true);
  assert.equal(f.item("a:a")?.text, "x");
  const skip = { ...fr("text-delta", { message: "a", index: 1, text: "y" }), cur: 5 };
  assert.equal(f.apply(skip).gap, true);
  assert.equal(f.last, 5);
});

test("a tool runs, streams output and finishes with a block", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("tool-started", { tool_id: "t1", tool: "Bash", kind: "terminal", summary: "ls" }));
  f.apply(fr("tool-progress", { tool_id: "t1", text: "a\n" }));
  f.apply(fr("tool-progress", { tool_id: "t1", text: "b\n" }));
  assert.equal(f.item("t:t1")?.output, "a\nb\n");
  assert.equal(f.item("t:t1")?.status, "running");
  f.apply(fr("tool-finished", { tool_id: "t1", ok: false, result: { block: "terminal", output: "a\nb\n", exit: 1 } }));
  assert.equal(f.item("t:t1")?.status, "failed");
  assert.equal(f.item("t:t1")?.block.block, "terminal");
});

test("a queued message sits in the queue, not the transcript, until picked up", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("status", { state: "working" }));
  f.apply(fr("user-message", { message: "m2", text: "also this", state: "queued" }));
  assert.equal(f.queue().length, 1);
  assert.equal(f.rows.length, 0);
  const r = f.apply(fr("user-message", { message: "m2", text: "also this", state: "picked-up" }));
  assert.equal(r.layout, true);
  assert.equal(f.queue().length, 0);
  assert.equal(f.item("u:m2")?.pickedUp, true);
  assert.equal(f.rows[0].key, "u:m2");
});

test("an ask opens, then is answered", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("ask", { ask_id: "k1", kind: "approval", task: { block: "task", title: "Send" } }));
  assert.equal(f.item("k:k1")?.state, "open");
  f.apply(fr("ask-answered", { ask_id: "k1", decision: "approve" }));
  assert.equal(f.item("k:k1")?.state, "answered");
  assert.equal(f.item("k:k1")?.decision, "approve");
});

test("status sets the header state and leaves a line only for the ones that end or pause", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("status", { state: "working", turn: "t1" }));
  assert.equal(f.rows.length, 0);
  assert.equal(f.status.state, "working");
  f.apply(fr("status", { state: "paused" }));
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].kind, "notice");
});

test("a reset clears the rows and takes its cursor", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("text-delta", { message: "a", index: 0, text: "x" }));
  const r = f.apply(fr("reset", { reason: "old" }));
  assert.equal(r.reset, true);
  assert.equal(f.rows.length, 0);
  assert.equal(f.last, cur);
});

test("term chunks decode into a terminal row", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("term-chunk", { term: "1", offset: 0, b64: Buffer.from("hi\n").toString("base64") }));
  f.apply(fr("term-chunk", { term: "1", offset: 3, b64: Buffer.from("there\n").toString("base64") }));
  assert.equal(f.item("x:1")?.output, "hi\nthere\n");
});

test("the rows array is replaced only when a row is added", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("text-delta", { message: "a", index: 0, text: "x" }));
  const r1 = f.rows;
  f.apply(fr("text-delta", { message: "a", index: 1, text: "y" }));
  assert.equal(f.rows, r1);
  f.apply(fr("text-delta", { message: "b", index: 0, text: "z" }));
  assert.notEqual(f.rows, r1);
});

test("headerState: busy shows Stop, stopping does not", () => {
  assert.deepEqual(headerState({ state: "working" }), { word: "working", busy: true, canStop: true });
  assert.equal(headerState({ state: "working", stopping: true }).word, "stopping");
  assert.equal(headerState({ state: "asking" }).word, "needs you");
  assert.equal(headerState({ state: "waiting" }).canStop, false);
  assert.equal(busyState("paused"), false);
});

test("a long history folds fast", () => {
  cur = 0;
  const f = createFolder();
  const frames = [];
  for (let i = 0; i < 20000; i++) frames.push(fr("text-delta", { message: "m" + i, index: 0, text: "hello" }));
  const t = Date.now();
  const r = f.applyAll(frames);
  assert.equal(f.rows.length, 20000);
  assert.equal(r.layout, true);
  assert.ok(Date.now() - t < 2000);
});
