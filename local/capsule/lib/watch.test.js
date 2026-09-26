// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Watches, notice, watchWords } from "./watch.js";

test("watch: fires once when the thread finishes, with the last thing it said", () => {
  const w = new Watches();
  w.add("t1", "intake");
  assert.equal(w.onEvent({ type: "thread.text", thread: "t2", payload: { done: true, text: "other" } }), null);
  assert.equal(w.onEvent({ type: "thread.text", thread: "t1", payload: { done: true, text: "All 42 tests pass." } }), null);
  const r = w.onEvent({ id: 9, type: "thread.finished", thread: "t1", at: 5, payload: { ok: true, cost_usd: 0.01 } });
  assert.equal(r?.why, "finished");
  assert.equal(r?.text, "All 42 tests pass.");
  assert.equal(r?.cost, 0.01);
  assert.equal(w.has("t1"), false, "a watch fires once");
  assert.equal(w.onEvent({ type: "thread.finished", thread: "t1", payload: {} }), null);
  assert.deepEqual(notice(/** @type {any} */ (r)), { title: "intake is done", body: "All 42 tests pass." });
  assert.equal(w.unread().length, 1);
  w.read(r?.id);
  assert.equal(w.unread().length, 0);
});

test("watch: asks, failures and stops, each by what was asked for", () => {
  const w = new Watches();
  w.add("t1", "site", "asks");
  assert.equal(w.onEvent({ type: "thread.finished", thread: "t1", payload: { ok: true } }), null, "done is not what was asked");
  assert.equal(w.onEvent({ type: "ask.raised", thread: "t1", payload: { summary: "run npm test" } })?.why, "asked");
  w.add("t2", "deploy");
  assert.equal(w.onEvent({ type: "thread.finished", thread: "t2", payload: { ok: false, error: "exit 1" } })?.text, "exit 1");
  w.add("t3", "long");
  assert.equal(w.onEvent({ type: "thread.stopped", thread: "t3", payload: {} })?.why, "stopped");
});

test("watch: kept in a 0600 file across restarts", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-watch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "capsule", "watches.json");
  const a = new Watches({ file });
  a.add("t1", "intake");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = new Watches({ file });
  assert.deepEqual(b.list().map(x => x.thread), ["t1"]);
  b.onEvent({ type: "thread.finished", thread: "t1", payload: { ok: true } });
  assert.equal(new Watches({ file }).unread().length, 1);
});

test("watch: the words that mean watch", () => {
  assert.equal(watchWords("watch the intake thread"), "intake");
  assert.equal(watchWords("watch harlow site and tell me when it's done"), "harlow site");
  assert.equal(watchWords("tell me when the deploy thread is done"), "deploy");
  assert.equal(watchWords("what time is it"), null);
});
