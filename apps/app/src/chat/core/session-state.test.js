// @ts-check
// The shared session core: live thread.* events (old and ADR 0030 shapes) and recall.transcript
// blocks folded into one keyed list, with the keys each call touched. Sample world only.

import "../../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, applyEvent, pendingEvents, applyBlocks, localSend, dropLocal, checkpoints, localShell, confirmSend, noteRewind, filesNote, contextLabel,
  splitShells, seedTasks } from "./session-state.js";

const T = "th-juniper";
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

test("a picture on a user or a tool block (cohesion item 18) rides through applyBlocks and marks the item changed", () => {
  const s = createSession(T);
  const PIC = { media_type: "image/png", data: "iVBOR" };
  const changed = applyBlocks(s, [
    { seq: 1, kind: "user", ts: 0, text: "What's wrong with this invoice?", images: [PIC] },
    { seq: 2, kind: "tool", ts: 0, id: "tu_9", tool: "Read", input: { file_path: "invoice.png" }, output: "[image]", error: false, images: [PIC] },
  ]);
  assert.deepEqual(changed.sort(), ["t:tu_9", "u:@1"]);
  assert.deepEqual(s.byKey.get("u:@1").images, [PIC]);
  assert.deepEqual(s.byKey.get("t:tu_9").images, [PIC]);
  // A second read with the same picture changes nothing (holds() sees the same value both times).
  assert.deepEqual(applyBlocks(s, [
    { seq: 1, kind: "user", ts: 0, text: "What's wrong with this invoice?", images: [PIC] },
    { seq: 2, kind: "tool", ts: 0, id: "tu_9", tool: "Read", input: { file_path: "invoice.png" }, output: "[image]", error: false, images: [PIC] },
  ]), []);
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
  ev(s, "thread.sent", { text: "Draft the Juniper Studio reply", surface: "deck" });
  const changed = ev(s, "thread.turn", { turn: `${T}:3`, uuid: "uu-1", text: "Draft the Juniper Studio reply" });
  assert.equal(s.turn, 3);
  assert.deepEqual(keys(s), ["u:live:1"]);
  assert.equal(s.byKey.get("u:live:1").uuid, "uu-1");
  assert.ok(changed.includes("u:live:1"));
  // A sent event carrying the uuid (new switchboard) is the same message again.
  ev(s, "thread.sent", { text: "Draft the Juniper Studio reply", uuid: "uu-1" });
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
  assert.equal(s.state, "working");
  ev(s, "ask.raised", { ask: "ask-1", tool: "Bash", summary: "rm -rf build" });
  assert.equal(s.state, "asking");
  assert.equal(s.asks.get("ask-1").kind, "permission");
  assert.equal(s.byKey.get("a:ask-1").state, "open");
  ev(s, "ask.answered", { ask: "ask-1", decision: "allow", by: "deck" });
  assert.equal(s.asks.get("ask-1").state, "answered");
  assert.equal(s.state, "working");
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
  assert.equal(s.state, "waiting", "the turn ended: ready for you, canonical 'waiting'");
  ev(s, "thread.stopped", { code: 0, reason: "done" });
  assert.equal(s.stopped, "done");
  assert.equal(s.state, "finished", "a one-shot's own done, mirrored from lib/thread-status.js");
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
  ev(s, "ask.answered", { ask: "q1", decision: "cancelled" });
  assert.equal(s.asks.get("q1").state, "cancelled");
  ev(s, "thread.finished", { result: "done", cost: 0.3, tokens: { input: 1, output: 1 } });
  assert.equal(s.byKey.get("turn:1").cost_usd, 0.3);
  assert.equal(s.byKey.get("turn:1").result, "done");
  // The thinking block swaps the live reasoning in place.
  applyBlocks(s, [{ seq: 7, kind: "thinking", ts: 0, text: "Thinking about it (transcript)." }]);
  assert.equal(s.byKey.get("r:msg_r:0").text, "Thinking about it (transcript).");
  assert.equal(s.byKey.get("r:msg_r:0").message, "msg_r");
});

test("thread.status is canonical (sessions' lib/thread-status.js): read as-is, and once seen, a legacy thread.state's word is ignored for good", () => {
  const s = createSession(T);
  ev(s, "thread.started", { provider: "claude", model: "opus", auth: "ambient" });
  // A box that sends both (sessions' 6e2f8a71: "at the same point"): thread.status wins.
  ev(s, "thread.state", { state: "waiting" }); // legacy word: an ask is open
  ev(s, "thread.status", { status: "asking" }); // canonical word for the same thing
  assert.equal(s.state, "asking");
  // A later legacy thread.state (its own next transition) no longer overrides: canonical governs
  // from here on, since a box that ever sent thread.status sends it for every future change too.
  ev(s, "thread.state", { state: "idle" });
  assert.equal(s.state, "asking", "the legacy word is ignored once thread.status has been seen");
  ev(s, "thread.status", { status: "waiting" });
  assert.equal(s.state, "waiting");
  // The 8th state (28a8b4f8): paused, distinct from stopped and failed.
  ev(s, "thread.status", { status: "paused" });
  assert.equal(s.state, "paused");
});

test("a teammate's result (core/team's threads.post, kind teammate-result) attaches to the handoff that asked, never a message of its own (teammates.md section 3)", () => {
  const s = createSession(T);
  ev(s, "thread.tool", { call: "tu_1", id: "tu_1", name: "team_ask", tool: "team_ask", input: { to: "design", text: "make the intake form calmer" } });
  const handoff = s.byKey.get("t:tu_1");
  assert.equal(handoff.name, "team_ask");
  assert.equal(handoff.reply, undefined, "nothing yet");
  // Idle: threads.post delivers it as an ordinary thread.sent.
  const changed = ev(s, "thread.sent", { text: "Done - the copy is warmer now.", surface: "design", kind: "teammate-result", uuid: "post-1" });
  assert.deepEqual(changed, ["t:tu_1"], "the handoff's own key, not a new user row");
  assert.equal(handoff.reply, "Done - the copy is warmer now.");
  assert.equal(s.byKey.has("u:post-1"), false, "never an ordinary user message");
  assert.equal(s.items.filter(it => it.kind === "user").length, 0);
  // Busy: threads.post's queue() path - never a "queued for after" row for it either.
  ev(s, "thread.tool", { call: "tu_2", id: "tu_2", name: "team_ask", tool: "team_ask", input: { to: "backend", text: "add the webhook" } });
  const changed2 = ev(s, "thread.queued", { queued: 9, uuid: "q-1", text: "on it", surface: "backend", kind: "teammate-result" });
  assert.deepEqual(changed2, []);
  assert.equal(s.queued.length, 0);
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

test("queue rows by their row id: queued, edited (same id), taken back, handed over at the turn's end", () => {
  const s = createSession(T);
  assert.deepEqual(ev(s, "thread.queued", { queued: 7, uuid: "q-1", text: "and the Northwind order", surface: "deck" }, { at: 5 }), ["@queued"]);
  ev(s, "thread.queued", { queued: 8, uuid: "q-2", text: "then stop", surface: "deck" });
  assert.equal(s.queued.length, 2);
  assert.deepEqual(s.queued[0], { uuid: "q-1", text: "and the Northwind order", queued: 7, at: 5 });
  // threads.edit: thread.queued again, same id and uuid, new words, same place.
  assert.deepEqual(ev(s, "thread.queued", { queued: 8, uuid: "q-2", text: "then stop and summarise", surface: "deck" }, { at: 6 }), ["@queued"]);
  assert.equal(s.queued.length, 2);
  assert.deepEqual(s.queued[1], { uuid: "q-2", text: "then stop and summarise", queued: 8, at: 6 });
  assert.deepEqual(ev(s, "thread.unqueued", { queued: 7, uuid: "q-1", reason: "taken" }), ["@queued"]);
  assert.equal(s.items.length, 0, "taken back: never a user item");
  // The hand-over names the row and its uuid, not the words: they are the row's.
  const out = ev(s, "thread.sent", { queued: 8, uuid: "q-2", via: "turn" });
  assert.ok(out.includes("@queued"));
  assert.equal(s.queued.length, 0);
  assert.equal(s.byKey.get("u:q-2").text, "then stop and summarise");
  assert.equal(s.byKey.get("u:q-2").steered, undefined, "a message of its own, not a steer");
  assert.deepEqual(ev(s, "thread.unqueued", { queued: 99, uuid: "nope", reason: "taken" }), []);
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

test("a stop: a real crash reads failed (28a8b4f8's reason shape, 'exited <code>'), an unrecognized reason reads plain stopped, streaming ends", () => {
  const s = createSession(T);
  ev(s, "thread.text", { message: "m", delta: "partial" });
  ev(s, "thread.stopped", { reason: "exited 1" });
  assert.equal(s.state, "failed", "a nonzero exit code, mirrored from lib/thread-status.js");
  assert.equal(s.stopped, "exited 1");
  assert.equal(s.byKey.get("m:m:0").streaming, false);
  ev(s, "thread.started", {});
  assert.equal(s.stopped, null);
  ev(s, "thread.stopped", { reason: "crash" });
  assert.equal(s.state, "stopped", "an unrecognized reason (not the exit-code shape): the plain word, not a guess at failed");
});

test("a closed turn and a new open turn in one read each find their own item; a live call learns its length", () => {
  const s = createSession(T);
  applyBlocks(s, [
    { seq: 0, kind: "user", ts: 1000, text: "Draft the Juniper Studio intake" },
    { seq: 1, kind: "text", ts: 2000, message: "m0", text: "Drafted." },
    { seq: 1, kind: "turn", ts: 1000, duration_ms: 1000, tokens: { input: 10, output: 2 }, open: true },
  ]);
  ev(s, "thread.sent", { text: "Now the Estate branch", surface: "deck" }, { at: 5000 });
  ev(s, "thread.tool", { call: "c1", name: "Bash", status: "running", summary: "npm test" }, { at: 6000 });
  ev(s, "thread.tool", { call: "c1", status: "completed" }, { at: 7500 });
  assert.equal(s.byKey.get("t:c1").duration_ms, 1500);
  ev(s, "thread.finished", { ok: true, cost_usd: 0.02 }, { at: 8000 });
  applyBlocks(s, [
    { seq: 2, kind: "turn", ts: 1000, duration_ms: 1000, tokens: { input: 10, output: 2 } },
    { seq: 2, kind: "user", ts: 5000, text: "Now the Estate branch" },
    { seq: 3, kind: "tool", ts: 6000, id: "c1", tool: "Bash", input: { command: "npm test" }, output: "ok", error: false, duration_ms: 1500 },
    { seq: 4, kind: "turn", ts: 5000, duration_ms: 3000, tokens: { input: 20, output: 4 }, open: true },
  ]);
  const turns = s.items.filter(i => i.kind === "turn");
  assert.equal(turns.length, 2);
  assert.equal(turns[0].open, false, "the first turn closed in place");
  assert.equal(turns[1].key, "turn:1", "the live turn took the open one");
  assert.equal(turns[1].cost_usd, 0.02);
});

test("a session closed for idleness is paused, not stopped or failed", () => {
  const s = createSession(T);
  ev(s, "thread.started", { provider: "claude", model: "opus", auth: "subscription" });
  ev(s, "thread.stopped", { reason: "idle" });
  assert.equal(s.state, "paused", "mirrors lib/thread-status.js: resumable, not wrong");
  assert.equal(s.stopped, "idle");
});

// ---- steering, the queue, rewinds, modes, todos and tasks (the composer like Claude Code) ----

test("a plain send: the words drawn at once with no marker, then your server's echo (its own uuid) is the same row", () => {
  const s = createSession(T);
  const drawn = localSend(s, { uuid: "deck-1", text: "Add the autumn specials", mode: "send", at: 1000 });
  assert.deepEqual(keys(s), ["u:deck-1"]);
  assert.ok(drawn.includes("u:deck-1"));
  assert.equal(s.items.some(i => i.kind === "steer"), false, "no steer marker");
  ev(s, "thread.sent", { text: "Add the autumn specials", surface: "deck", uuid: "box-1" }, { at: 1050 });
  assert.equal(s.items.filter(i => i.kind === "user").length, 1, "the echo is the same message");
  assert.equal(s.meta.uuids.get("box-1"), s.items[0].key, "known by your server's uuid now");
  // A send that failed takes its row away.
  const t = createSession(T);
  localSend(t, { uuid: "deck-2", text: "Try again later", mode: "send" });
  dropLocal(t, "deck-2");
  assert.deepEqual(keys(t), []);
  assert.deepEqual(localSend(t, { uuid: "deck-3", text: "x", mode: null }), [], "null draws nothing");
});

test("a steer: drawn on send, echoed via steer, moved to where it joined at the step counted here, and a re-read keeps one marker", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "Rebuild the Estate intake", uuid: "u-1" }, { at: 1000 });
  ev(s, "thread.tool", { call: "c1", id: "c1", name: "Read", status: "running" }, { at: 2000 });
  const drawn = localSend(s, { uuid: "u-2", text: "Use Estate intake v2 instead", mode: "steer", at: 3000 });
  assert.deepEqual(keys(s), ["u:u-1", "t:c1", "steer:u-2", "u:u-2"]);
  assert.ok(drawn.includes("steer:u-2") && drawn.includes("u:u-2"));
  assert.equal(s.byKey.get("steer:u-2").pending, true, "steering until kit reads it");
  ev(s, "thread.sent", { text: "Use Estate intake v2 instead", surface: "deck", uuid: "u-2", turn: `${T}:1`, via: "steer" });
  assert.equal(s.items.filter(i => i.kind === "user").length, 2, "the echo is the same message");
  assert.equal(s.byKey.get("steer:u-2").pending, true, "still steering");
  ev(s, "thread.tool", { call: "c1", id: "c1", status: "completed" }, { at: 3500 });
  ev(s, "thread.tool", { call: "c2", id: "c2", name: "Bash", status: "running" }, { at: 3600 });
  ev(s, "thread.tool", { call: "c2", id: "c2", status: "completed" }, { at: 3900 });
  // No step on the event: two tool calls of this turn had finished when it came.
  const out = ev(s, "thread.steered", { uuid: "u-2", turn: `${T}:1` }, { at: 4000 });
  assert.deepEqual(keys(s), ["u:u-1", "t:c1", "t:c2", "steer:u-2", "u:u-2"], "the words moved to the tail they joined");
  const m = s.byKey.get("steer:u-2");
  assert.deepEqual([m.pending, m.step, m.user, m.at], [false, 2, "u:u-2", 4000]);
  assert.equal(s.byKey.get("u:u-2").step, 2);
  assert.ok(out.includes("steer:u-2") && out.includes("u:u-2"));
  applyBlocks(s, [
    { seq: 0, kind: "user", ts: 1000, text: "Rebuild the Estate intake", uuid: "u-1" },
    { seq: 1, kind: "tool", ts: 2000, id: "c1", tool: "Read", input: { file_path: "src/intake/general.ts" }, output: "x", error: false },
    { seq: 3, kind: "tool", ts: 3600, id: "c2", tool: "Bash", input: { command: "npm test" }, output: "ok", error: false },
    { seq: 5, kind: "user", ts: 4000, text: "Use Estate intake v2 instead", uuid: "u-2", steered: true, step: 2 },
  ]);
  assert.deepEqual(keys(s), ["u:u-1", "t:c1", "t:c2", "steer:u-2", "u:u-2"]);
  assert.equal(s.items.filter(i => i.kind === "steer").length, 1);
  assert.equal(s.byKey.get("u:u-2").steered, true);
});

test("the step counts only this turn's finished calls; a steer from another screen arrives via steer", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "Draft the Northwind Bakery menu", uuid: "u-1" });
  ev(s, "thread.tool", { call: "c1", name: "Read", status: "completed" });
  ev(s, "thread.finished", { ok: true });
  ev(s, "thread.sent", { text: "Now the prices", uuid: "u-2", via: "turn" });
  ev(s, "thread.tool", { call: "c2", name: "Read", status: "completed" });
  ev(s, "thread.tool", { call: "c3", name: "Bash", status: "running" });
  ev(s, "thread.sent", { text: "Keep the prices under 10", surface: "phone", uuid: "u-3", turn: `${T}:2`, via: "steer" });
  assert.equal(s.byKey.get("steer:u-3").pending, true, "another screen's steer reads as steering too");
  ev(s, "thread.steered", { uuid: "u-3", turn: `${T}:2` });
  assert.equal(s.byKey.get("steer:u-3").step, 1, "c1 was the last turn's; c3 still runs");
});

test("a steer your server took as a message of its own (the turn had ended) loses its marker", () => {
  const s = createSession(T);
  localSend(s, { uuid: "u-5", text: "And the Juniper Studio intake", mode: "steer" });
  const out = ev(s, "thread.sent", { text: "And the Juniper Studio intake", surface: "deck", uuid: "u-5", via: "turn" });
  assert.ok(out.includes("steer:u-5"));
  assert.equal(s.byKey.get("steer:u-5"), undefined);
  assert.deepEqual(keys(s), ["u:u-5"]);
  assert.equal(s.byKey.get("u:u-5").steered, false);
});
test("a steer read from the transcript alone gets the same marker, once", () => {
  const s = createSession(T);
  applyBlocks(s, [
    { seq: 0, kind: "user", ts: 1, text: "Draft the Northwind Bakery menu" },
    { seq: 1, kind: "tool", ts: 2, id: "c1", tool: "Read", input: { file_path: "menu.md" }, output: "x", error: false },
    { seq: 3, kind: "user", ts: 3, text: "Keep the prices", steered: true, step: 1 },
    { seq: 4, kind: "text", ts: 4, message: "msg_1", text: "Keeping them." },
  ]);
  assert.deepEqual(keys(s), ["u:@0", "t:c1", "steer:@3", "u:@3", "m:msg_1:0"]);
  assert.equal(s.byKey.get("steer:@3").step, 1);
  applyBlocks(s, [{ seq: 3, kind: "user", ts: 3, text: "Keep the prices", steered: true, step: 1 }]);
  assert.equal(s.items.filter(i => i.kind === "steer").length, 1, "read twice, one marker");
});

test("queued on send, named by the answer, then Steer now: via now, the queued words are the steer", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "Rebuild the intake", uuid: "u-1" });
  assert.deepEqual(localSend(s, { uuid: "q-1", text: "Then open a PR against main", mode: "queue", at: 5 }), ["@queued"]);
  assert.deepEqual(s.queued, [{ uuid: "q-1", text: "Then open a PR against main", queued: null, at: 5, local: true }]);
  // threads.send answered {queued: 12, uuid}: the row has its id.
  localSend(s, { uuid: "q-1", text: "Then open a PR against main", mode: "queue", queued: 12 });
  assert.equal(s.queued[0].queued, 12);
  ev(s, "thread.queued", { queued: 12, uuid: "q-1", text: "Then open a PR against main", surface: "deck" }, { at: 6 });
  assert.deepEqual(s.queued, [{ uuid: "q-1", text: "Then open a PR against main", queued: 12, at: 6 }], "one row, your server's");
  ev(s, "thread.tool", { call: "c1", name: "Read", status: "completed" });
  // threads.send-now: the row goes into the running turn.
  ev(s, "thread.sent", { queued: 12, uuid: "q-1", via: "now" }, { at: 8 });
  assert.equal(s.queued.length, 0);
  assert.equal(s.byKey.get("u:q-1").text, "Then open a PR against main");
  assert.equal(s.byKey.get("steer:q-1").pending, true);
  ev(s, "thread.steered", { uuid: "q-1", turn: `${T}:1` }, { at: 9 });
  assert.deepEqual(keys(s), ["u:u-1", "t:c1", "steer:q-1", "u:q-1"]);
  assert.deepEqual([s.byKey.get("steer:q-1").pending, s.byKey.get("steer:q-1").step], [false, 1]);
});
test("a failed send takes back what was drawn; an echo without a uuid is the words drawn on send", () => {
  const s = createSession(T);
  localSend(s, { uuid: "u-9", text: "Keep the witness page", mode: "steer" });
  assert.deepEqual(dropLocal(s, "u-9").sort(), ["steer:u-9", "u:u-9"]);
  assert.equal(s.items.length, 0);
  localSend(s, { uuid: "q-9", text: "later", mode: "queue" });
  assert.deepEqual(dropLocal(s, "q-9"), ["@queued"]);
  assert.equal(s.queued.length, 0);
  localSend(s, { uuid: "u-10", text: "Keep the witness page", mode: "steer" });
  ev(s, "thread.sent", { text: "Keep the witness page", surface: "deck" });
  assert.equal(s.items.filter(i => i.kind === "user").length, 1);
  assert.equal(s.byKey.get("u:u-10").confirmed, true);
  assert.deepEqual(localSend(s, { uuid: "u-11", text: "x", mode: null }), [], "an idle send draws nothing: thread.sent does");
  // A box that never says thread.steered: the turn's end says it was taken.
  assert.equal(s.byKey.get("steer:u-10").pending, true);
  assert.ok(ev(s, "thread.finished", { ok: true }).includes("steer:u-10"));
  assert.deepEqual([s.byKey.get("steer:u-10").pending, s.byKey.get("steer:u-10").step], [false, null]);
});

test("a rewind is the same thread: the message and everything after it go, the words come back, and re-reads skip the old branch", () => {
  const s = createSession(T);
  const blocks = [
    { seq: 0, kind: "user", ts: 1000, text: "Read the intake folder", uuid: "a" },
    { seq: 1, kind: "text", ts: 2000, message: "msg_a", text: "It has three forms." },
    { seq: 2, kind: "turn", ts: 1000, duration_ms: 1000, tokens: { input: 1, output: 1 }, model: "m" },
    { seq: 2, kind: "user", ts: 3000, text: "Rebuild the Estate intake", uuid: "b" },
    { seq: 3, kind: "tool", ts: 4000, id: "c1", tool: "Edit", input: { file_path: "src/intake/estate.ts", old_string: "a", new_string: "b" }, output: "ok", error: false },
    { seq: 4, kind: "text", ts: 5000, message: "msg_b", text: "Done." },
  ];
  applyBlocks(s, blocks);
  assert.deepEqual(checkpoints(s).map(c => c.uuid), ["b", "a"], "newest first");
  const out = ev(s, "thread.rewound", { uuid: "b", at: "a" }, { at: 10_000 });
  assert.ok(out.includes("@rewound"));
  assert.ok(["u:@2", "t:c1", "m:msg_b:0"].every(k => out.includes(k)), "the rows that went are named");
  assert.deepEqual(s.rewound, { uuid: "b", text: "Rebuild the Estate intake", at: 10_000 });
  assert.deepEqual(keys(s).slice(0, 3), ["u:@0", "m:msg_a:0", "turn:@2"], "what came before stays, its turn too");
  assert.equal(s.items.length, 4);
  assert.equal(s.items[3].text, 'Rewound to before "Rebuild the Estate intake"');
  assert.deepEqual(checkpoints(s).map(c => c.uuid), ["a"]);
  // The answer's own copy, then the event (or the other way round): one notice.
  assert.deepEqual(ev(s, "thread.rewound", { uuid: "b", local: true }, { at: 10_050 }), []);
  assert.equal(s.items.length, 4);
  // The transcript keeps the abandoned branch; the new one is written after the rewind.
  applyBlocks(s, [...blocks, { seq: 5, kind: "turn", ts: 3000, duration_ms: 2000, tokens: { input: 1, output: 1 }, model: "m" },
    { seq: 5, kind: "user", ts: 11_000, text: "Rebuild it as Estate intake v2", uuid: "c" },
    { seq: 6, kind: "text", ts: 12_000, message: "msg_c", text: "On it." }]);
  assert.deepEqual(keys(s), ["u:@0", "m:msg_a:0", "turn:@2", "rw:b:1", "u:@5", "m:msg_c:0"], "the old branch is never drawn again");
});

test("a rewind read back on open (noteRewind before the blocks): the old branch is skipped from the start", () => {
  const s = createSession(T);
  noteRewind(s, { uuid: "b", at: 10_000 });
  applyBlocks(s, [
    { seq: 0, kind: "user", ts: 1000, text: "Read the intake folder", uuid: "a" },
    { seq: 1, kind: "text", ts: 2000, message: "msg_a", text: "It has three forms." },
    { seq: 2, kind: "turn", ts: 1000, duration_ms: 1000, tokens: { input: 1, output: 1 }, model: "m" },
    { seq: 2, kind: "user", ts: 3000, text: "Rebuild the Estate intake", uuid: "b" },
    { seq: 3, kind: "tool", ts: 4000, id: "c1", tool: "Edit", input: {}, output: "ok", error: false },
    { seq: 4, kind: "turn", ts: 3000, duration_ms: 1000, tokens: { input: 1, output: 1 }, model: "m", open: true },
  ]);
  assert.deepEqual(keys(s), ["u:@0", "m:msg_a:0", "turn:@2"]);
});

test("your server mints the steer's uuid: the echo (same words) and the answer (confirmSend) tie it to the drawn item, and thread.steered uses it", () => {
  const s = createSession(T);
  ev(s, "thread.turn", { turn: `${T}:1`, uuid: "box-1", text: "Rebuild the Estate intake" });
  ev(s, "thread.sent", { text: "Rebuild the Estate intake", uuid: "box-1" });
  ev(s, "thread.tool", { call: "c1", name: "Read", status: "running" });
  localSend(s, { uuid: "deck-2", text: "Use Estate intake v2 instead", mode: "steer", at: 3000 });
  ev(s, "thread.sent", { text: "Use Estate intake v2 instead", surface: "deck", uuid: "box-2", via: "steer" });
  assert.equal(s.items.filter(i => i.kind === "user").length, 2, "one row for the steer");
  assert.equal(s.items.filter(i => i.kind === "steer").length, 1);
  assert.deepEqual(confirmSend(s, "deck-2", "box-2"), [], "the echo got there first");
  ev(s, "thread.tool", { call: "c1", status: "completed" });
  ev(s, "thread.steered", { uuid: "box-2" });
  const m = /** @type {any} */ (s.items.find(i => i.kind === "steer"));
  assert.deepEqual([m.pending, m.step, m.taken], [false, 1, true]);
  assert.equal(s.items.filter(i => i.kind === "steer").length, 1, "no second marker under your server's uuid");

  // The answer first, then thread.steered, then the echo.
  localSend(s, { uuid: "deck-3", text: "And keep the witness page", mode: "steer" });
  confirmSend(s, "deck-3", "box-3");
  ev(s, "thread.steered", { uuid: "box-3" });
  ev(s, "thread.sent", { text: "And keep the witness page", uuid: "box-3", via: "steer" });
  assert.equal(s.items.filter(i => i.kind === "user").length, 3);
  assert.equal(s.items.filter(i => i.kind === "steer").length, 2);
});

test("steered words the turn never reached run as the next turn: markers go, one plain message with the joined words", () => {
  const s = createSession(T);
  ev(s, "thread.turn", { turn: `${T}:1`, uuid: "u-1", text: "Draft the Northwind Bakery menu" });
  ev(s, "thread.sent", { text: "Draft the Northwind Bakery menu", uuid: "u-1" });
  ev(s, "thread.tool", { call: "c1", name: "Read", status: "running" });
  localSend(s, { uuid: "d-2", text: "Keep the prices under 10", mode: "steer" });
  ev(s, "thread.sent", { text: "Keep the prices under 10", uuid: "b-2", via: "steer" });
  ev(s, "thread.sent", { text: "And add a gluten-free line", surface: "phone", uuid: "b-3", via: "steer" });
  ev(s, "thread.tool", { call: "c1", status: "completed" });
  ev(s, "thread.finished", { ok: true, cost_usd: 0.02 });
  ev(s, "thread.turn", { turn: `${T}:2`, uuid: "b-2", text: "Keep the prices under 10\n\nAnd add a gluten-free line", steered: true });
  assert.equal(s.items.filter(i => i.kind === "steer").length, 0, "no steer markers");
  const users = /** @type {any[]} */ (s.items.filter(i => i.kind === "user"));
  assert.equal(users.length, 2, "no duplicate rows");
  assert.equal(users[1].text, "Keep the prices under 10\n\nAnd add a gluten-free line");
  assert.equal(users[1].steered, false);
  assert.equal(s.items.at(-1), users[1], "at the tail, after the turn that ended");
  assert.equal(s.turn, 2);
  // Its echo, if any, is the same message.
  ev(s, "thread.sent", { text: "Keep the prices under 10", uuid: "b-3", via: "turn" });
  assert.equal(s.items.filter(i => i.kind === "user").length, 2);
});

test("a queued send: the answer's queued_id and your server's uuid name the row drawn under the Deck's", () => {
  const s = createSession(T);
  ev(s, "thread.turn", { turn: `${T}:1`, uuid: "u-1", text: "Rebuild the intake" });
  localSend(s, { uuid: "deck-q", text: "Then open a PR against main", mode: "queue", at: 5 });
  // The event first, under the box's ids.
  ev(s, "thread.queued", { queued: 41, uuid: "box-q", text: "Then open a PR against main", surface: "deck" }, { at: 6 });
  assert.equal(s.queued.length, 1, "the drawn row is the event's");
  confirmSend(s, "deck-q", "box-q");
  localSend(s, { uuid: "box-q", text: "Then open a PR against main", mode: "queue", queued: 41 });
  assert.deepEqual(s.queued.map(q => [q.queued, q.uuid]), [[41, "box-q"]]);
  ev(s, "thread.queued", { queued: 41, uuid: "box-q", text: "Then open a PR against main, as a draft", surface: "deck", edited: true });
  assert.deepEqual(s.queued.map(q => q.text), ["Then open a PR against main, as a draft"], "an edit re-emits the same row");
  // Handed over at the turn's end: thread.sent via turn, then its thread.turn.
  ev(s, "thread.finished", { ok: true });
  ev(s, "thread.sent", { text: "Then open a PR against main, as a draft", queued: 41, uuid: "box-q", via: "turn" });
  ev(s, "thread.turn", { turn: `${T}:2`, uuid: "box-q", text: "Then open a PR against main, as a draft" });
  assert.equal(s.queued.length, 0);
  assert.equal(s.items.filter(i => i.kind === "user").length, 2);
});

test("send-now with no turn running starts one: a message of its own, not a steer", () => {
  const s = createSession(T);
  ev(s, "thread.queued", { queued: 7, uuid: "q-7", text: "Summarise the Juniper Studio notes" });
  ev(s, "thread.turn", { turn: `${T}:1`, uuid: "q-7", text: "Summarise the Juniper Studio notes" });
  ev(s, "thread.sent", { text: "Summarise the Juniper Studio notes", queued: 7, uuid: "q-7", via: "now" });
  assert.equal(s.items.filter(i => i.kind === "steer").length, 0);
  assert.equal(s.queued.length, 0);
});

test("thread.usage: the turn's own cost and the session's total are kept apart", () => {
  const s = createSession(T);
  ev(s, "thread.usage", { cost_usd: 0.02, total_cost_usd: 1.4, tokens: { input: 10, output: 5 } });
  assert.deepEqual([s.usage.cost_usd, s.usage.total_cost_usd], [0.02, 1.4]);
  ev(s, "thread.finished", { ok: true, cost_usd: 0.02, total_cost_usd: 1.4 });
  assert.equal(/** @type {any} */ (s.items.find(i => i.kind === "turn")).cost_usd, 0.02, "the turn shows its own cost");
});

test("mode, model and thinking: from thread.started and their own events", () => {
  const s = createSession(T);
  ev(s, "thread.started", { provider: "claude", model: "opus", auth: "subscription", purpose: "chat", mode: "default", modes: ["default", "acceptEdits", "plan", "bypassPermissions"], thinking: false });
  assert.deepEqual([s.provider, s.model, s.auth, s.purpose], ["claude", "opus", "subscription", "chat"]);
  assert.equal(s.mode, "default");
  assert.deepEqual(s.modes, ["default", "acceptEdits", "plan", "bypassPermissions"]);
  assert.equal(s.thinking, false);
  assert.deepEqual(ev(s, "mode.changed", { mode: "plan" }), ["@session"]);
  assert.equal(s.mode, "plan");
  assert.deepEqual(ev(s, "thread.mode", { mode: "acceptEdits" }), [], "your server says mode.changed");
  assert.equal(s.mode, "plan");
  assert.deepEqual(ev(s, "model.switched", { model: "sonnet" }), ["@session"]);
  assert.equal(s.model, "sonnet");
  // threads.thinking's event (sessions 034c71e5).
  assert.deepEqual(ev(s, "thinking.switched", { on: true }), ["@session"]);
  assert.equal(s.thinking, true);
  ev(s, "thinking.switched", { on: false });
  assert.equal(s.thinking, false);
});

test("todos: the newest TodoWrite of the thread, announced as @todos", () => {
  const s = createSession(T);
  const blocks = [
    { seq: 0, kind: "user", ts: 1, text: "Plan the Juniper Studio launch" },
    { seq: 1, kind: "tool", ts: 2, id: "td1", tool: "TodoWrite", input: { todos: [{ content: "Read the intake", status: "in_progress", activeForm: "Reading the intake" }] }, output: "ok", error: false },
    { seq: 2, kind: "tool", ts: 3, id: "td2", tool: "TodoWrite", input: { todos: [{ content: "Read the intake", status: "completed" }, { content: "Run the tests", status: "pending" }] }, output: "ok", error: false },
  ];
  assert.ok(applyBlocks(s, blocks).includes("@todos"));
  assert.deepEqual(s.todos, { key: "t:td2", todos: [{ content: "Read the intake", status: "completed" }, { content: "Run the tests", status: "pending" }] });
  assert.deepEqual(applyBlocks(s, blocks), [], "read again: nothing moved");
});

test("background tasks: guessed from tool calls until thread.task comes, then your server's", () => {
  const s = createSession(T);
  const out = applyBlocks(s, [
    { seq: 0, kind: "user", ts: 1, text: "Start the Northwind dev server" },
    { seq: 1, kind: "tool", ts: 2, id: "b1", tool: "Bash", input: { command: "npm run dev", run_in_background: true }, output: "Command running in background with ID: bash_1", error: false },
    { seq: 2, kind: "tool", ts: 3, id: "b2", tool: "Bash", input: { command: "npm run build", run_in_background: true }, output: "Command running in background with ID: bash_2", error: false },
    { seq: 3, kind: "tool", ts: 4, id: "k1", tool: "KillShell", input: { shell_id: "bash_2" }, output: "killed", error: false },
    { seq: 4, kind: "tool", ts: 5, id: "a1", tool: "Task", input: { description: "Check the menu prices", prompt: "x" }, output: null, error: false },
  ]);
  assert.ok(out.includes("@tasks"));
  assert.deepEqual([...s.tasks.values()].map(t => [t.id, t.kind, t.title, t.status]), [
    ["bash_1", "shell", "npm run dev", "running"], ["bash_2", "shell", "npm run build", "killed"], ["a1", "agent", "Check the menu prices", "running"]]);
  assert.deepEqual(ev(s, "thread.task", { id: "sh_7", kind: "shell", title: "npm run dev", status: "running" }, { at: 9 }), ["@tasks"]);
  assert.deepEqual([...s.tasks.keys()], ["sh_7"], "the guesses give way");
  ev(s, "thread.task", { id: "sh_7", status: "completed" });
  assert.deepEqual([s.tasks.get("sh_7").status, s.tasks.get("sh_7").title], ["completed", "npm run dev"]);
  applyBlocks(s, [{ seq: 5, kind: "tool", ts: 6, id: "b3", tool: "Bash", input: { command: "npm test", run_in_background: true }, output: "ID: bash_3", error: false }]);
  assert.deepEqual([...s.tasks.keys()], ["sh_7"], "tool calls no longer move them");
});

test("a ! command's answer is a row of its own, updated in place", () => {
  const s = createSession(T);
  assert.deepEqual(localShell(s, { id: "1", command: "git status --short", at: 5 }), ["sh:1"]);
  localShell(s, { id: "1", command: "git status --short", output: " M src/intake/estate.ts", exit: 0, duration_ms: 200, at: 5 });
  assert.deepEqual(keys(s), ["sh:1"]);
  assert.deepEqual(s.byKey.get("sh:1"), { key: "sh:1", kind: "shell", command: "git status --short", output: " M src/intake/estate.ts", exit: 0, duration_ms: 200,
    local: true, answered: true, at: 5 });
});

// ---- sessions 034c71e5: reasoning, images, ! shell, # memory, background tasks -------------------

test("reasoning is keyed r:<message>:<block>, text m:<message>:<block>: the same message and block never collide", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "Why is the Estate intake slow?" });
  // A flush sends the step's reasoning first, then its text; a test box may even give both one block.
  ev(s, "thread.text", { message: "msg_t", block: 0, kind: "reasoning", delta: "The form re-renders " });
  ev(s, "thread.text", { message: "msg_t", block: 0, delta: "Looking." });
  ev(s, "thread.text", { message: "msg_t", block: 0, kind: "reasoning", delta: "on every key." });
  ev(s, "thread.text", { message: "msg_t", block: 1, delta: " Found it." });
  assert.deepEqual(keys(s).slice(1), ["r:msg_t:0", "m:msg_t:0", "m:msg_t:1"]);
  assert.equal(s.byKey.get("r:msg_t:0").text, "The form re-renders on every key.");
  assert.equal(s.byKey.get("m:msg_t:0").text, "Looking.");
  // Whole blocks, as the assistant line gives them: thinking at 0, text at 1.
  ev(s, "thread.text", { message: "msg_t", block: 0, kind: "reasoning", text: "The form re-renders on every key.", done: true });
  ev(s, "thread.text", { message: "msg_t", block: 1, text: " Found it.", done: true });
  assert.equal(s.byKey.get("r:msg_t:0").streaming, false);
  assert.equal(s.byKey.get("m:msg_t:0").text, "Looking.", "the reasoning's done never lands on the text");
  assert.ok(keys(s).every(k => !k.startsWith("r:") || s.byKey.get(k).kind === "reasoning"));
  assert.ok(keys(s).every(k => !k.startsWith("m:") || s.byKey.get(k).kind === "text"));
});

test("thread.thinking (sessions db44749b) is the same reasoning row as thread.text kind reasoning, keyed r:, never m:", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "Check the Northwind invoice" });
  assert.deepEqual(ev(s, "thread.thinking", { message: "msg_k", block: 0, delta: "Totals first, " }), ["r:msg_k:0"]);
  ev(s, "thread.text", { message: "msg_k", block: 0, delta: "On it." });
  ev(s, "thread.thinking", { message: "msg_k", block: 0, delta: "then tax." });
  assert.deepEqual([s.byKey.get("r:msg_k:0").kind, s.byKey.get("r:msg_k:0").text, s.byKey.get("r:msg_k:0").streaming], ["reasoning", "Totals first, then tax.", true]);
  ev(s, "thread.thinking", { message: "msg_k", block: 0, text: "Totals first, then tax.", done: true });
  assert.equal(s.byKey.get("r:msg_k:0").streaming, false);
  assert.equal(s.byKey.get("m:msg_k:0").text, "On it.", "the text is its own row");
  // The older shape lands on the same row.
  ev(s, "thread.text", { message: "msg_k", block: 0, kind: "reasoning", text: "Totals first, then tax.", done: true });
  assert.deepEqual(keys(s).slice(1), ["r:msg_k:0", "m:msg_k:0"]);
});

test("images: the send draws its count, and thread.sent {images} gives it to the message", () => {
  const s = createSession(T);
  ev(s, "thread.sent", { text: "What is wrong in this screenshot?", uuid: "img-1", surface: "deck", images: 2 });
  assert.equal(s.byKey.get("u:img-1").images, 2);
  ev(s, "thread.state", { state: "running" });
  localSend(s, { uuid: "img-2", text: "And this one", mode: "steer", images: 1 });
  assert.equal(s.byKey.get("u:img-2").images, 1, "a steer's images (its echo does not count them)");
});

test("! shell: the row drawn on run takes thread.shell once; another screen's is a row of its own; the answer's whole output wins", () => {
  const s = createSession(T);
  localShell(s, { id: "a", command: "npm test", at: 1 });
  // The event comes before the answer (the box emits, then answers).
  assert.deepEqual(ev(s, "thread.shell", { command: "npm test", code: 1, output: "1 failing" }, { id: 40 }), ["sh:a"]);
  assert.deepEqual([s.byKey.get("sh:a").exit, s.byKey.get("sh:a").output, s.byKey.get("sh:a").echoed], [1, "1 failing", true]);
  localShell(s, { id: "a", command: "npm test", at: 1, output: "1 failing\n  estate intake: total", exit: 1, duration_ms: 900 });
  assert.equal(s.byKey.get("sh:a").output, "1 failing\n  estate intake: total");
  // The same command run again elsewhere: a row of its own, not the echoed one.
  assert.deepEqual(ev(s, "thread.shell", { command: "npm test", code: 0, output: "ok" }, { id: 41 }), ["sh:e41"]);
  assert.deepEqual(ev(s, "thread.shell", { command: "npm test", code: 0, output: "ok" }, { id: 41 }), [], "applied once");
  // An answer first, then its event: the event does not overwrite the whole output.
  localShell(s, { id: "b", command: "git log -1", at: 2 });
  localShell(s, { id: "b", command: "git log -1", at: 2, output: "x".repeat(5000), exit: 0, duration_ms: 20 });
  ev(s, "thread.shell", { command: "git log -1", code: 0, output: "x".repeat(4000) }, { id: 42 });
  assert.equal(s.byKey.get("sh:b").output.length, 5000);
  assert.deepEqual(keys(s), ["sh:a", "sh:e41", "sh:b"]);
});

test("! shell in the transcript: the next message's <bash-input> blocks split back into shell rows and the words", () => {
  const sent = "<bash-input>git status --short</bash-input>\n<bash-stdout> M src/intake/estate.ts</bash-stdout><bash-stderr></bash-stderr>\n\nWhat changed?";
  assert.deepEqual(splitShells(sent), { shells: [{ command: "git status --short", output: " M src/intake/estate.ts" }], text: "What changed?" });
  assert.deepEqual(splitShells("plain words"), { shells: [], text: "plain words" });
  const two = "<bash-input>a</bash-input>\n<bash-stdout>1</bash-stdout><bash-stderr>warn</bash-stderr>\n<bash-input>b</bash-input>\n<bash-stdout></bash-stdout><bash-stderr></bash-stderr>\n\nGo";
  assert.deepEqual(splitShells(two).shells, [{ command: "a", output: "1\nwarn" }, { command: "b", output: "" }]);
  // Live: the row run here and the message sent after it; the read swaps both in place.
  const s = createSession(T);
  localShell(s, { id: "g", command: "git status --short", at: 900, output: " M src/intake/estate.ts", exit: 0, duration_ms: 40 });
  ev(s, "thread.sent", { text: "What changed?", uuid: "w1" }, { at: 1000 });
  const out = applyBlocks(s, [{ seq: 4, kind: "user", ts: 1000, uuid: "w1", text: sent }]);
  assert.deepEqual(keys(s), ["sh:g", "u:w1"], "nothing twice");
  assert.ok(out.includes("sh:g"));
  assert.equal(s.byKey.get("u:w1").text, "What changed?");
  assert.equal(s.byKey.get("sh:g").exit, 0, "the live exit code stays");
  // Opened fresh from the file: a shell row, then the words.
  const f = createSession(T);
  applyBlocks(f, [{ seq: 4, kind: "user", ts: 1000, uuid: "w1", text: sent }]);
  assert.deepEqual(f.items.map(i => [i.key, i.kind]), [["sh:@4:0", "shell"], ["u:@4", "user"]]);
  assert.deepEqual([f.byKey.get("sh:@4:0").command, f.byKey.get("sh:@4:0").exit], ["git status --short", null]);
  assert.deepEqual(applyBlocks(f, [{ seq: 4, kind: "user", ts: 1000, uuid: "w1", text: sent }]), [], "read again: nothing moved");
});

test("# memory: thread.remembered is a notice naming the file", () => {
  const s = createSession(T);
  const out = ev(s, "thread.remembered", { scope: "project", file: "/home/alex/work/juniper-studio/CLAUDE.md" }, { id: 7 });
  assert.deepEqual(out, ["n:7"]);
  assert.equal(s.byKey.get("n:7").text, "Remembered in CLAUDE.md (this project)");
  ev(s, "thread.remembered", { scope: "local", file: "/home/alex/work/juniper-studio/CLAUDE.local.md" }, { id: 8 });
  assert.equal(s.byKey.get("n:8").text, "Remembered in CLAUDE.local.md (this folder, not shared)");
});

test("background tasks, your server's shapes: started, updated with only what changed, ended with a summary; threads.tasks seeds them", () => {
  const s = createSession(T);
  // task_started: kind, title, call, background.
  ev(s, "thread.task", { id: "task_3", status: "running", kind: "shell", title: "npm run dev", call: "toolu_9", background: true }, { at: 10 });
  // task_updated: the fields that changed, no kind.
  ev(s, "thread.task", { id: "task_3", status: "running", title: "npm run dev -- --port 3001" });
  assert.deepEqual(s.tasks.get("task_3"), { id: "task_3", kind: "shell", title: "npm run dev -- --port 3001", status: "running", at: 10, call: "toolu_9", background: true });
  ev(s, "thread.task", { id: "task_4", status: "running", kind: "agent", title: "Check the menu prices", call: null, background: false }, { at: 11 });
  ev(s, "thread.task", { id: "task_4", status: "completed", summary: "Two prices were out of date." });
  assert.deepEqual([s.tasks.get("task_4").kind, s.tasks.get("task_4").status, s.tasks.get("task_4").summary], ["agent", "completed", "Two prices were out of date."]);
  // task_notification with status "stopped" is killed on the box; an older one may still say stopped.
  ev(s, "thread.task", { id: "task_3", status: "stopped", summary: "stopped by the user" });
  assert.equal(s.tasks.get("task_3").status, "killed");
  assert.equal(s.tasks.get("task_3").kind, "shell", "an update without kind keeps it");
  ev(s, "thread.task", { id: "task_5", status: "failed", kind: "shell", title: "npm run e2e", error: "exit 1" });
  assert.equal(s.tasks.get("task_5").error, "exit 1");

  // threads.tasks on open: the box's list, and tool calls no longer guess.
  const o = createSession(T);
  applyBlocks(o, [{ seq: 1, kind: "tool", ts: 2, id: "b1", tool: "Bash", input: { command: "npm run dev", run_in_background: true }, output: "ID: bash_1", error: false }]);
  assert.deepEqual([...o.tasks.keys()], ["bash_1"], "an older box: guessed");
  assert.deepEqual(seedTasks(o, [{ id: "task_1", kind: "shell", title: "npm run dev", status: "running", call: "b1", background: true }]), ["@tasks"]);
  assert.deepEqual([...o.tasks.keys()], ["task_1"]);
  assert.deepEqual(seedTasks(createSession(T), []), ["@tasks"], "an empty list is your server's too");
  assert.deepEqual(seedTasks(o, /** @type {any} */ (null)), []);
});

test("a code-only rewind puts the files back and drops nothing; answer and event are one notice; re-reads keep the branch", () => {
  const s = createSession(T);
  const blocks = [
    { seq: 0, kind: "user", ts: 1000, text: "Read the intake folder", uuid: "a" },
    { seq: 1, kind: "text", ts: 2000, message: "msg_a", text: "It has three forms." },
    { seq: 2, kind: "user", ts: 3000, text: "Rebuild the Estate intake", uuid: "b" },
    { seq: 3, kind: "tool", ts: 4000, id: "c1", tool: "Edit", input: { file_path: "src/intake/estate.ts", old_string: "a", new_string: "b" }, output: "ok", error: false },
    { seq: 4, kind: "text", ts: 5000, message: "msg_b", text: "Done." },
  ];
  applyBlocks(s, blocks);
  const before = keys(s);
  const files = { restored: true, files_changed: ["src/intake/estate.ts", "src/intake/forms.ts", "README.md"] };
  const out = ev(s, "thread.rewound", { uuid: "b", restore: "code", files, local: true }, { at: 10_000 });
  assert.ok(!out.includes("@rewound"), "the composer keeps what it has");
  assert.equal(s.rewound, null);
  assert.deepEqual(keys(s).slice(0, before.length), before, "nothing leaves the view");
  assert.equal(s.items.at(-1).text, "Restored 3 files");
  assert.deepEqual(checkpoints(s).map(c => c.uuid), ["b", "a"], "both messages can still be gone back to");
  assert.equal(s.meta.rewinds.length, 0, "no branch is abandoned");
  // Its event: the same restore.
  assert.deepEqual(ev(s, "thread.rewound", { uuid: "b", restore: "code", files }, { at: 10_050 }), []);
  assert.equal(s.items.filter(i => i.kind === "notice").length, 1);
  applyBlocks(s, blocks);
  assert.deepEqual(keys(s).slice(0, before.length), before, "a re-read draws the same conversation");
  // A second restore to the same message is its own.
  ev(s, "thread.rewound", { uuid: "b", restore: "code", files: { restored: false, why: "no checkpoint" } }, { at: 20_000 });
  assert.equal(s.items.at(-1).text, "Could not restore the files: no checkpoint");
});

test("a rewind of both: the conversation goes back as before, and the notice says what the files did", () => {
  const s = createSession(T);
  applyBlocks(s, [
    { seq: 0, kind: "user", ts: 1000, text: "Read the intake folder", uuid: "a" },
    { seq: 1, kind: "user", ts: 3000, text: "Rebuild the Estate intake", uuid: "b" },
    { seq: 2, kind: "text", ts: 5000, message: "msg_b", text: "Done." },
  ]);
  const out = ev(s, "thread.rewound", { uuid: "b", at: "a", restore: "both", files: { restored: true, files_changed: ["src/intake/estate.ts"] } }, { at: 10_000 });
  assert.ok(out.includes("@rewound"));
  assert.equal(s.rewound?.text, "Rebuild the Estate intake");
  assert.equal(s.items.at(-1).text, 'Rewound to before "Rebuild the Estate intake" · Restored 1 file');
  assert.equal(s.items.filter(i => i.kind === "user").length, 1);
});

test("filesNote and contextLabel", () => {
  assert.equal(filesNote(null), null);
  assert.equal(filesNote({ restored: true }), "Restored the files");
  assert.equal(filesNote({ restored: true, files_changed: [] }), "No files to restore");
  assert.equal(filesNote({ restored: true, files_changed: ["a.ts", "b.ts"] }), "Restored 2 files");
  assert.equal(filesNote({ restored: false }), "Could not restore the files");
  assert.equal(contextLabel(null), null);
  assert.equal(contextLabel({ context: { used: 1000, max: null } }), null, "no share, no meter");
  assert.deepEqual(contextLabel({ context: { used: 124000, max: 200000, share: 0.62 } }), { text: "62% of context", title: "124,000 of 200,000 tokens", share: 0.62 });
  assert.equal(contextLabel({ context: { used: 250000, max: 200000, share: 1.25 } })?.text, "100% of context");
});

test("thread.usage keeps the context; model.switched moves the model, and a scoped model.changed is not this thread's", () => {
  const s = createSession(T);
  ev(s, "thread.started", { provider: "claude", model: "opus" });
  assert.deepEqual(ev(s, "thread.usage", { cost_usd: 0.01, total_cost_usd: 0.3, context: { used: 124000, max: 200000, share: 0.62 } }), ["@session"]);
  assert.equal(contextLabel(s.usage)?.text, "62% of context");
  ev(s, "thread.usage", { cost_usd: 0.01, total_cost_usd: 0.31 });
  assert.equal(contextLabel(s.usage)?.text, "62% of context", "a usage without context keeps the last");
  assert.deepEqual(ev(s, "model.switched", { model: "haiku", live: true }), ["@session"]);
  assert.equal(s.model, "haiku");
  assert.deepEqual(ev(s, "model.changed", { scope: "purpose:job", model: "sonnet" }), [], "sessions.models.set, a purpose's default");
  assert.equal(s.model, "haiku");
  assert.deepEqual(ev(s, "model.changed", { model: "sonnet" }), ["@session"], "an older box's thread model");
  assert.equal(s.model, "sonnet");
});

test("pendingEvents: the rows still queued and the steers not taken in, from threads.get's events, without their ids", () => {
  const ev = [
    { id: 1, type: "thread.sent", payload: { text: "demo", uuid: "u0" } },
    { id: 2, type: "thread.sent", payload: { text: "read it first", uuid: "s0", via: "steer" } },
    { id: 3, type: "thread.steered", payload: { uuid: "s0" } },
    { id: 4, type: "thread.queued", payload: { queued: 3, uuid: "q3", text: "never mind" } },
    { id: 5, type: "thread.unqueued", payload: { queued: 3, uuid: "q3", reason: "taken" } },
    { id: 6, type: "thread.queued", payload: { queued: 4, uuid: "q4", text: "old words" } },
    { id: 7, type: "thread.sent", payload: { queued: 4, uuid: "q4", via: "turn" } },
    { id: 8, type: "thread.sent", payload: { text: "lost at a turn end", uuid: "s1", via: "steer" } },
    { id: 9, type: "thread.finished", payload: { ok: true } },
    { id: 10, type: "thread.sent", payload: { text: "use the rye price too", uuid: "s2", via: "steer" } },
    { id: 11, type: "thread.queued", payload: { queued: 5, uuid: "q5", text: "then check the hours" } },
    { id: 12, type: "thread.queued", payload: { queued: 5, uuid: "q5", text: "then check the opening hours", edited: true } },
  ];
  const got = pendingEvents(ev);
  assert.deepEqual(got.map(e => [e.type, e.payload.uuid]), [["thread.sent", "s2"], ["thread.queued", "q5"], ["thread.queued", "q5"]]);
  assert.ok(got.every(e => e.id === undefined), "no ids: the view's cursor is already past them");
  const s = createSession("t1");
  for (const e of got) applyEvent(s, e);
  assert.deepEqual(s.queued.map(q => [q.queued, q.text]), [[5, "then check the opening hours"]]);
  const marker = s.items.find(it => it.kind === "steer");
  assert.equal(marker && marker.pending, true);
  assert.deepEqual(pendingEvents([...ev, { id: 13, type: "thread.steered", payload: { uuid: "s2" } }, { id: 14, type: "thread.sent", payload: { queued: 5, via: "turn" } }]), []);
});

test("thread.artifact draws one card row per version, and never folds into a run of tools", () => {
  const s = createSession(T);
  ev(s, "thread.artifact", { thread: T, artifact: "a1", version: 1, kind: "report", title: "Q3 report" }, { at: 5 });
  ev(s, "thread.artifact", { thread: T, artifact: "a1", version: 1, kind: "report", title: "Q3 report" }, { at: 6 });
  ev(s, "thread.artifact", { thread: T, artifact: "a1", version: 2, kind: "report", title: "Q3 report" }, { at: 7 });
  const rows = s.items.filter(it => it.kind === "tool" && it.name === "artifact");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].render, { kind: "artifact", id: "a1", thread: T, version: 1, type: "report", title: "Q3 report", agent: null, at: 5 });
});

test("thread.plan is one row kept where it first appeared and updated in place; an empty or malformed list takes nothing away", () => {
  const s = createSession(T);
  applyEvent(s, { type: "thread.plan", at: 1, payload: { items: [{ text: "read menu", status: "running" }, { text: "write it", status: "pending" }] } });
  applyEvent(s, { type: "thread.tool", at: 2, payload: { call: "c1", name: "Read", phase: "started" } });
  const out = applyEvent(s, { type: "thread.plan", at: 3, payload: { items: [{ text: "read menu", status: "done" }, { text: "write it", status: "running" }, { text: "", status: "done" }, { text: "send", status: "weird" }] } });
  assert.deepEqual(keys(s), ["plan", "t:c1"]);
  assert.ok([...out].includes("plan"));
  assert.deepEqual(/** @type {any} */ (s.items[0]).items, [{ text: "read menu", status: "done" }, { text: "write it", status: "running" }, { text: "send", status: "pending" }]);
  applyEvent(s, { type: "thread.plan", at: 4, payload: { items: [] } });
  assert.equal(/** @type {any} */ (s.items[0]).items.length, 3);
});

test("a reply takes provider and model from its event once, and a reply whose event says nothing carries none", () => {
  const s = createSession(T);
  applyEvent(s, { type: "thread.text", at: 1, payload: { message: "m1", block: 0, delta: "hi", provider: "codex", model: "gpt-5" } });
  applyEvent(s, { type: "thread.text", at: 2, payload: { message: "m1", block: 0, delta: " there", provider: "claude", model: "opus" } });
  applyEvent(s, { type: "thread.text", at: 3, payload: { message: "m2", block: 0, delta: "old box" } });
  const [a, b] = /** @type {any[]} */ (s.items);
  assert.deepEqual([a.provider, a.model], ["codex", "gpt-5"]);
  assert.deepEqual([b.provider, b.model], [undefined, undefined]);
});
