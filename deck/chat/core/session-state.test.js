// @ts-check
// The shared session core: live thread.* events (old and ADR 0030 shapes) and recall.transcript
// blocks folded into one keyed list, with the keys each call touched. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, applyEvent, applyBlocks } from "./session-state.js";

const T = "th-harlow";
/** @param {any} s */
const keys = s => s.items.map((/** @type {any} */ i) => i.key);
/** @param {any} s @param {string} type @param {any} payload @param {any} [extra] */
const ev = (s, type, payload, extra = {}) => applyEvent(s, { type, payload: { thread: T, ...payload }, ...extra });

test("text, tool, text in one message (old shapes): two text items, then the transcript's in the same places", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "Fix the invoice total for Northwind Bakery", surface: "deck" });
  ev(s, "thread.text", { message: "msg_1", delta: "Looking at " });
  ev(s, "thread.text", { message: "msg_1", delta: "the invoice." });
  assert.equal(s.byKey.get("m:msg_1:0").streaming, true);
  assert.equal(s.byKey.get("m:msg_1:0").text, "Looking at the invoice.");
  ev(s, "thread.text", { message: "msg_1", text: "Looking at the invoice.", done: true });
  ev(s, "thread.tool", { id: "tu_1", tool: "Read", phase: "started", summary: "Read invoices/northwind.js" });
  ev(s, "thread.tool", { id: "tu_1", phase: "done", error: false });
  // The second text: no block index, and it must not overwrite the first.
  ev(s, "thread.text", { message: "msg_1", delta: "Fixed." });
  ev(s, "thread.text", { message: "msg_1", text: "Fixed the rounding.", done: true });
  assert.deepEqual(keys(s), ["u:live:1", "m:msg_1:0", "t:tu_1", "m:msg_1:1"]);
  assert.equal(s.byKey.get("m:msg_1:0").text, "Looking at the invoice.");
  assert.equal(s.byKey.get("m:msg_1:1").text, "Fixed the rounding.");
  assert.equal(s.byKey.get("t:tu_1").status, "completed");

  const changed = applyBlocks(s, [
    { seq: 4, kind: "user", ts: 0, text: "Fix the invoice total for Northwind Bakery" },
    { seq: 5, kind: "text", ts: 0, message: "msg_1", text: "Looking at the invoice (transcript)." },
    { seq: 6, kind: "tool", ts: 0, id: "tu_1", tool: "Read", input: { file_path: "invoices/northwind.js" }, output: "1\tconst total = 0;", error: false, done_ts: 1, duration_ms: 5 },
    { seq: 8, kind: "text", ts: 0, message: "msg_1", text: "Fixed the rounding (transcript)." },
  ]);
  assert.deepEqual(keys(s), ["u:live:1", "m:msg_1:0", "t:tu_1", "m:msg_1:1"], "same keys, same order");
  assert.deepEqual(changed.sort(), ["m:msg_1:0", "m:msg_1:1", "t:tu_1", "u:live:1"]);
  assert.equal(s.byKey.get("m:msg_1:0").text, "Looking at the invoice (transcript).");
  assert.equal(s.byKey.get("m:msg_1:1").text, "Fixed the rounding (transcript).");
  const tool = s.byKey.get("t:tu_1");
  assert.equal(tool.seq, 6);
  assert.deepEqual(tool.detail, { type: "read", filePath: "invoices/northwind.js", offset: 1 });
});

test("text, tool, text with ADR 0030 block indexes keeps block keys", () => {
  const s = createSession(T);
  ev(s, "thread.text", { message: "msg_2", block: 0, delta: "One" });
  ev(s, "thread.text", { message: "msg_2", block: 0, text: "One.", done: true });
  ev(s, "thread.tool", { call: "tu_2", name: "Bash", status: "running", summary: "npm test" });
  ev(s, "thread.text", { message: "msg_2", block: 2, text: "Two.", done: true });
  assert.deepEqual(keys(s), ["m:msg_2:0", "t:tu_2", "m:msg_2:2"]);
  ev(s, "thread.tool", { call: "tu_2", status: "completed" });
  assert.equal(s.byKey.get("t:tu_2").status, "completed");
  // A late "running" never takes a finished tool back.
  ev(s, "thread.tool", { call: "tu_2", status: "running" });
  assert.equal(s.byKey.get("t:tu_2").status, "completed");
  applyBlocks(s, [
    { seq: 1, kind: "text", ts: 0, message: "msg_2", text: "One." },
    { seq: 2, kind: "tool", ts: 0, id: "tu_2", tool: "Bash", input: { command: "npm test" }, output: "ok", error: false },
    { seq: 3, kind: "text", ts: 0, message: "msg_2", text: "Two." },
  ]);
  assert.deepEqual(keys(s), ["m:msg_2:0", "t:tu_2", "m:msg_2:2"]);
  assert.equal(s.byKey.get("t:tu_2").detail.type, "shell");
});

test("a live user matched by uuid: thread.sent then thread.turn is one item", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "Draft the Harlow Legal reply", surface: "deck" });
  const changed = ev(s, "thread.turn", { turn: `${T}:3`, uuid: "uu-1", text: "Draft the Harlow Legal reply" });
  assert.equal(s.turn, 3);
  assert.deepEqual(keys(s), ["u:live:1"]);
  assert.equal(s.byKey.get("u:live:1").uuid, "uu-1");
  assert.ok(changed.includes("u:live:1"));
  // A sent event carrying the uuid (new switchboard) is the same message again.
  ev(s, "thread.sent", { text: "Draft the Harlow Legal reply", uuid: "uu-1" });
  assert.deepEqual(keys(s), ["u:live:1"]);
  // thread.turn first mints u:<uuid>.
  const s2 = createSession(T);
  ev(s2, "thread.turn", { turn: `${T}:1`, uuid: "uu-2", text: "hello kit" });
  ev(s2, "thread.sent", { text: "hello kit", uuid: "uu-2" });
  assert.deepEqual(keys(s2), ["u:uu-2"]);
});

test("a live user is matched to the transcript by normalised text, else the oldest pending one", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "ask   juno\nabout the lease" }, { at: 1000 });
  applyBlocks(s, [{ seq: 10, kind: "user", ts: 1500, text: "ask juno about the lease" }]);
  assert.deepEqual(keys(s), ["u:live:1"]);
  assert.equal(s.byKey.get("u:live:1").seq, 10);
  // Redaction changed the text: the oldest pending live user takes it.
  const s2 = createSession(T);
  ev(s2, "thread.sent", { text: "token is sk-abc123" }, { at: 1000 });
  applyBlocks(s2, [{ seq: 3, kind: "user", ts: 1200, text: "token is [redacted]" }]);
  assert.deepEqual(keys(s2), ["u:live:1"]);
  assert.equal(s2.byKey.get("u:live:1").text, "token is [redacted]");
});

test("old history read after live events goes before them; a new user block does not steal a later one's match", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "second question" }, { at: 5_000_000 });
  ev(s, "thread.text", { message: "msg_b", text: "Second answer.", done: true }, { at: 5_000_100 });
  applyBlocks(s, [
    { seq: 0, kind: "user", ts: 1000, text: "first question" },
    { seq: 1, kind: "text", ts: 1100, message: "msg_a", text: "First answer." },
    { seq: 2, kind: "turn", ts: 1000, duration_ms: 100, tokens: { input: 1, output: 2 }, model: "m" },
    { seq: 2, kind: "user", ts: 5_000_000, text: "second question" },
    { seq: 3, kind: "text", ts: 5_000_100, message: "msg_b", text: "Second answer." },
  ]);
  assert.deepEqual(keys(s), ["u:@0", "m:msg_a:0", "turn:@2", "u:live:1", "m:msg_b:0"]);
});

test("the old event shapes: no provider, no block, no uuid, no thread.state", () => {
  const s = createSession(T);
  ev(s, "thread.started", { name: "kit", cwd: "/home/alex", project: "northwind", agent: "kit", headless: true, resumed: false });
  assert.equal(s.state, "starting");
  assert.equal(s.provider, null);
  ev(s, "thread.sent", { text: "hi", surface: "deck" });
  assert.equal(s.state, "running");
  ev(s, "ask.raised", { ask: "ask-1", tool: "Bash", summary: "rm -rf build" });
  assert.equal(s.state, "waiting");
  assert.equal(s.asks.get("ask-1").kind, "permission");
  assert.equal(s.byKey.get("a:ask-1").state, "open");
  ev(s, "ask.answered", { ask: "ask-1", decision: "allow", by: "deck" });
  assert.equal(s.asks.get("ask-1").state, "answered");
  assert.equal(s.state, "running");
  ev(s, "ask.raised", { ask: "ask-2", tool: "Edit" });
  ev(s, "ask.answered", { ask: "ask-2", decision: "cancelled", by: "thread stopped" });
  assert.equal(s.asks.get("ask-2").state, "cancelled");
  ev(s, "thread.text", { message: "vyre", text: "The subscription's limit is at 80%.", done: true, notice: true }, { id: 41 });
  assert.ok(s.byKey.has("n:41"));
  ev(s, "thread.limit", { status: "allowed_warning", kind: "five_hour", resets_at: 99 });
  assert.equal(s.limit.status, "allowed_warning");
  ev(s, "thread.finished", { ok: true, stop_reason: "end_turn", cost_usd: 0.02, duration_ms: 900, turns: 1, tokens: { input: 1, output: 2 } });
  const turn = s.byKey.get("turn:1");
  assert.equal(turn.cost_usd, 0.02);
  assert.equal(turn.reason, "end_turn");
  assert.equal(s.state, "idle");
  ev(s, "thread.stopped", { code: 0, reason: "done" });
  assert.equal(s.stopped, "done");
  assert.equal(s.state, "stopped");
});

test("the ADR 0030 shapes: started fields, thread.state wins over guesses, usage, reasoning", () => {
  const s = createSession(T);
  ev(s, "thread.started", { provider: "claude", model: "opus", auth: "ambient" });
  assert.deepEqual([s.provider, s.model, s.auth], ["claude", "opus", "ambient"]);
  ev(s, "thread.state", { state: "idle" });
  ev(s, "thread.sent", { text: "go" });
  assert.equal(s.state, "idle", "a switchboard that sends thread.state is never second-guessed");
  ev(s, "thread.state", { state: "running" });
  ev(s, "thread.text", { message: "msg_r", block: 0, kind: "reasoning", delta: "Thinking about " });
  ev(s, "thread.text", { message: "msg_r", block: 0, kind: "reasoning", text: "Thinking about it.", done: true });
  assert.equal(s.byKey.get("r:msg_r:0").kind, "reasoning");
  assert.equal(s.byKey.get("r:msg_r:0").streaming, false);
  ev(s, "thread.usage", { tokens: { input: 10, output: 5 }, cost_usd: 0.1, context: { used: 1000, max: 200000 } });
  assert.deepEqual(s.usage.context, { used: 1000, max: 200000 });
  ev(s, "ask.raised", { ask: "q1", kind: "question", tool: "AskUserQuestion" });
  ev(s, "ask.cancelled", { ask: "q1" });
  assert.equal(s.asks.get("q1").state, "cancelled");
  ev(s, "thread.finished", { result: "done", cost: 0.3, tokens: { input: 1, output: 1 } });
  assert.equal(s.byKey.get("turn:1").cost_usd, 0.3);
  assert.equal(s.byKey.get("turn:1").result, "done");
  // The thinking block swaps the live reasoning in place.
  applyBlocks(s, [{ seq: 7, kind: "thinking", ts: 0, text: "Thinking about it (transcript)." }]);
  assert.equal(s.byKey.get("r:msg_r:0").text, "Thinking about it (transcript).");
  assert.equal(s.byKey.get("r:msg_r:0").message, "msg_r");
});

test("re-reading the same blocks changes nothing; a tool's result arriving updates it in place", () => {
  const s = createSession(T);
  const first = [
    { seq: 0, kind: "user", ts: 1, text: "list the files" },
    { seq: 1, kind: "tool", ts: 2, id: "tu_9", tool: "Glob", input: { pattern: "*.md" }, output: null, error: false, done_ts: null, duration_ms: null },
    { seq: 1, kind: "turn", ts: 1, duration_ms: 1, tokens: { input: 1, output: 1 }, model: "m", open: true },
  ];
  assert.equal(applyBlocks(s, first).length, 3);
  assert.equal(s.byKey.get("t:tu_9").status, "running");
  assert.deepEqual(applyBlocks(s, first), [], "idempotent");
  assert.equal(s.items.length, 3);
  const second = [
    { seq: 1, kind: "tool", ts: 2, id: "tu_9", tool: "Glob", input: { pattern: "*.md" }, output: "README.md", error: false, done_ts: 3, duration_ms: 1 },
    { seq: 2, kind: "text", ts: 3, message: "msg_9", text: "One file." },
    { seq: 3, kind: "turn", ts: 1, duration_ms: 2, tokens: { input: 1, output: 2 }, model: "m" },
    { seq: 3, kind: "user", ts: 4, text: "thanks" },
  ];
  const changed = applyBlocks(s, second);
  assert.deepEqual(changed.sort(), ["m:msg_9:0", "t:tu_9", "turn:@1", "u:@3"]);
  assert.equal(s.byKey.get("t:tu_9").status, "completed");
  assert.equal(s.byKey.get("t:tu_9").detail.numFiles, 1);
  assert.equal(s.byKey.get("turn:@1").open, false, "the open turn closed in place");
  assert.deepEqual(keys(s), ["u:@0", "t:tu_9", "m:msg_9:0", "turn:@1", "u:@3"]);
  assert.deepEqual(applyBlocks(s, second), []);
});

test("paging back: an older window goes before what is on screen, live items stay last", () => {
  const s = createSession(T);
  applyBlocks(s, [{ seq: 40, kind: "user", ts: 40, text: "latest question" }, { seq: 41, kind: "text", ts: 41, message: "msg_l", text: "Latest." }]);
  ev(s, "thread.sent", { text: "a new one" }, { at: 100 });
  applyBlocks(s, [{ seq: 2, kind: "user", ts: 2, text: "oldest question" }, { seq: 3, kind: "text", ts: 3, message: "msg_o", text: "Oldest." }]);
  assert.deepEqual(keys(s), ["u:@2", "m:msg_o:0", "u:@40", "m:msg_l:0", "u:live:1"]);
  // A tail read with a block newer than the file's items but older than a live item goes between.
  applyBlocks(s, [{ seq: 42, kind: "text", ts: 50, message: "msg_n", text: "In between." }]);
  assert.deepEqual(keys(s).slice(-2), ["m:msg_n:0", "u:live:1"]);
});

test("a live done text the transcript already holds is not added twice", () => {
  const s = createSession(T);
  applyBlocks(s, [{ seq: 2, kind: "text", ts: 0, message: "msg_x", text: "Done." }]);
  ev(s, "thread.text", { message: "msg_x", text: "Done.", done: true });
  assert.deepEqual(keys(s), ["m:msg_x:0"]);
});

test("queued, then unqueued (proposed) or sent from the queue (today)", () => {
  const s = createSession(T);
  assert.deepEqual(ev(s, "thread.queued", { uuid: "q-1", text: "and the Northwind order", queued: 7 }, { at: 5 }), ["@queued"]);
  ev(s, "thread.queued", { text: "then stop", queued: 8 });
  assert.equal(s.queued.length, 2);
  assert.deepEqual(s.queued[0], { uuid: "q-1", text: "and the Northwind order", queued: 7, at: 5 });
  assert.deepEqual(ev(s, "thread.unqueued", { uuid: "q-1", reason: "taken" }), ["@queued"]);
  assert.equal(s.items.length, 0, "taken back: never a user item");
  const out = ev(s, "thread.sent", { text: "then stop", queued: 8, via: "idle" });
  assert.ok(out.includes("@queued"));
  assert.equal(s.queued.length, 0);
  assert.equal(s.byKey.get("u:live:1").text, "then stop");
  assert.deepEqual(ev(s, "thread.unqueued", { uuid: "nope" }), []);
});

test("an interrupt: finished canceled ends streaming text and running tools", () => {
  const s = createSession(T);
  ev(s, "thread.text", { message: "msg_i", block: 0, delta: "Working" });
  ev(s, "thread.tool", { call: "tu_i", name: "Bash", status: "running" });
  ev(s, "thread.turn", { turn: `${T}:4`, uuid: "uu-i", text: "go" });
  const changed = ev(s, "thread.finished", { canceled: true, reason: "interrupted", tokens: { input: 1, output: 1 } });
  assert.equal(s.byKey.get("m:msg_i:0").streaming, false);
  assert.equal(s.byKey.get("t:tu_i").status, "canceled");
  const turn = s.byKey.get("turn:4");
  assert.equal(turn.canceled, true);
  assert.equal(turn.reason, "interrupted");
  assert.ok(["m:msg_i:0", "t:tu_i", "turn:4", "@session"].every(k => changed.includes(k)));
  // The transcript with no result for that tool does not bring it back to running.
  applyBlocks(s, [{ seq: 1, kind: "tool", ts: 0, id: "tu_i", tool: "Bash", input: { command: "sleep 9" }, output: null, error: false }]);
  assert.equal(s.byKey.get("t:tu_i").status, "canceled");
});

test("events for another thread, and events already applied, are skipped", () => {
  const s = createSession(T);
  assert.deepEqual(applyEvent(s, { type: "thread.sent", payload: { thread: "other", text: "x" } }), []);
  assert.equal(ev(s, "thread.text", { message: "m", delta: "a" }, { id: 10 }).length > 0, true);
  assert.deepEqual(ev(s, "thread.text", { message: "m", delta: "a" }, { id: 10 }), []);
  assert.equal(s.byKey.get("m:m:0").text, "a");
  assert.deepEqual(applyEvent(s, /** @type {any} */ (null)), []);
});

test("a stop: crash reads failed, streaming ends", () => {
  const s = createSession(T);
  ev(s, "thread.text", { message: "m", delta: "partial" });
  ev(s, "thread.stopped", { reason: "crash" });
  assert.equal(s.state, "failed");
  assert.equal(s.byKey.get("m:m:0").streaming, false);
  ev(s, "thread.started", {});
  assert.equal(s.stopped, null);
});
