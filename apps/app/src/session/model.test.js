// @ts-check
// The app's side of a session (model.ts) over chat's own core (deck/chat/core), as the app runs
// it: threads.get's events into session-state, the header's words, and the transcript's rows with
// runs of tools folded. Loaded through Node's type stripping, so skipped on a Node without it.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, applyEvent } from "../chat/core/session-state.js";
import { groupItems } from "../chat/core/grouping.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./model.ts");

/** threads.get's events: {id, at, type, payload}, no thread on the record. */
const read = [
  { id: 1, at: 1, type: "thread.started", payload: { name: "Q3 report", model: "opus" } },
  { id: 2, at: 2, type: "thread.sent", payload: { text: "Rebuild the intake for the Estate branch", surface: "web" } },
  { id: 3, at: 3, type: "thread.tool", payload: { id: "c1", tool: "Read", phase: "started", summary: "Read src/intake/schema.ts" } },
  { id: 4, at: 4, type: "thread.tool", payload: { id: "c1", phase: "done", error: false } },
  { id: 5, at: 5, type: "thread.tool", payload: { id: "c2", tool: "Bash", phase: "started", summary: "npm test" } },
  { id: 6, at: 6, type: "thread.tool", payload: { id: "c2", phase: "done", error: false } },
  { id: 7, at: 7, type: "thread.text", payload: { message: "m1", delta: "Using Estate " } },
  { id: 8, at: 8, type: "thread.text", payload: { message: "m1", text: "Using Estate intake v2.", done: true } },
  { id: 9, at: 9, type: "thread.finished", payload: { ok: true, duration_ms: 12000 } },
  { id: 10, at: 10, type: "thread.stopped", payload: { reason: "idle" } },
];

test("session: threads.get's events become the transcript; idle is not ended", { skip: !strip }, async () => {
  const { toSessionEvent, stateWords, busy } = await load();
  const s = createSession("t1");
  for (const e of read) {
    const ev = toSessionEvent(e, "t1");
    assert.ok(ev);
    applyEvent(s, ev);
  }
  assert.deepEqual(s.items.map(i => i.kind), ["user", "tool", "tool", "text", "turn"]);
  const text = /** @type {any} */ (s.items[3]);
  assert.equal(text.text, "Using Estate intake v2.");
  assert.equal(text.streaming, false);
  assert.equal(s.state, "paused");
  assert.deepEqual(stateWords(s), { word: "paused", note: "Resumes on your next message", ended: false });
  assert.equal(busy(s.state), false);
  // Another thread's event is not this one's.
  const other = toSessionEvent({ id: 11, type: "thread.text", thread: "t2", payload: { message: "x", delta: "no" } }, "t1");
  assert.ok(other);
  assert.deepEqual(applyEvent(s, other), []);
});

test("session: a stop that is not for idleness reads as ended", { skip: !strip }, async () => {
  const { stateWords, stateOf } = await load();
  assert.deepEqual(stateWords({ state: "stopped", stopped: "stopped" }), { word: "ended", note: "Stopped", ended: true });
  assert.equal(stateOf("stopped", "idle"), "paused");
  assert.equal(stateOf("working"), "working");
  assert.equal(stateOf("waiting"), "asking");
});

test("session: a failed record is stopped for the core, and reads as failed", { skip: !strip }, async () => {
  const { stateOf, stoppedOf, stateWords } = await load();
  assert.equal(stateOf("failed"), "failed");
  assert.equal(stoppedOf("failed"), "failed");
  assert.equal(stoppedOf("stopped", "idle"), "idle");
  assert.equal(stoppedOf("running"), null);
  assert.deepEqual(stateWords({ state: "stopped", stopped: "failed" }), { word: "failed", note: null, ended: true });
});

test("session: stateOf's own finished/failed states (not only the legacy stopped+reason shape) read as ended", { skip: !strip }, async () => {
  const { stateOf, stoppedOf, stateWords } = await load();
  assert.equal(stateOf("stopped", "done"), "finished");
  assert.deepEqual(stateWords({ state: stateOf("stopped", "done"), stopped: stoppedOf("stopped", "done") }), { word: "finished", note: null, ended: true });
  assert.equal(stateOf("stopped", "exited 1"), "failed");
  assert.deepEqual(stateWords({ state: stateOf("stopped", "exited 1"), stopped: stoppedOf("stopped", "exited 1") }), { word: "failed", note: null, ended: true });
});

test("session: Stop flips the chip to stopping at once, until the turn has ended", { skip: !strip }, async () => {
  const { stateWords } = await load();
  assert.equal(stateWords({ state: "working", stopped: null }, true).word, "stopping");
  assert.equal(stateWords({ state: "working", stopped: null }, false).word, "working");
  // The box said it ended: the stop is over, the words are the state's.
  assert.equal(stateWords({ state: "paused", stopped: null }, true).word, "paused");
});

test("session: runs of tools fold into one row, open on a tap", { skip: !strip }, async () => {
  const { toSessionEvent, transcriptRows, onlyPatches } = await load();
  const s = createSession("t1");
  for (const e of read.slice(0, 8)) applyEvent(s, /** @type {any} */ (toSessionEvent(e, "t1")));
  const groups = groupItems(s.items);
  const closed = transcriptRows(s.items, groups, new Set());
  assert.deepEqual(closed.map(r => r.type === "run" ? `run:${r.summary}` : r.kind), ["user", "run:Read 1 file, ran 1 command", "text"]);
  const runKey = /** @type {any} */ (closed[1]).key;
  const open = transcriptRows(s.items, groups, new Set([runKey]));
  assert.deepEqual(open.map(r => r.type === "run" ? "run" : r.kind), ["user", "run", "tool", "tool", "text"]);
  const drawn = new Set(closed.map(r => r.key));
  assert.equal(onlyPatches(["m:m1:0", "@session"], drawn, s.byKey), true, "a streaming reply repaints its row only");
  assert.equal(onlyPatches(["t:c2"], drawn, s.byKey), false, "a tool changes its run");
  assert.equal(onlyPatches(["m:m2:0"], drawn, s.byKey), false, "a new row re-lays the list");
});

test("session: threads.send's answer reads as taken, queued or refused", { skip: !strip }, async () => {
  const { sendOutcome } = await load();
  assert.deepEqual(sendOutcome({ data: { sent: true, thread: "t1" } }), { ok: true, queued: false, uuid: null });
  assert.deepEqual(sendOutcome({ data: { sent: true, steered: true, uuid: "box-1" } }), { ok: true, queued: false, uuid: "box-1" });
  assert.deepEqual(sendOutcome({ data: { sent: false, queued: true, open_elsewhere: true } }), { ok: true, queued: true, id: null, uuid: null });
  assert.deepEqual(sendOutcome({ data: { sent: false, queued: true, queued_id: 42, uuid: "box-2" } }), { ok: true, queued: true, id: 42, uuid: "box-2" });
  assert.deepEqual(sendOutcome({ data: { sent: false, holder: "deck", note: "deck holds this session" } }), { ok: false, reason: "deck holds this session" });
  assert.deepEqual(sendOutcome({ error: { code: "not_found", message: "no such thread" } }), { ok: false, reason: "no such thread" });
});

test("session: the cache log folds a streamed block into one event and keeps the newest", { skip: !strip }, async () => {
  const { appendLog } = await load();
  /** @type {any[]} */
  const log = [];
  appendLog(log, { id: 1, type: "thread.sent", payload: { text: "hi", uuid: "u1" } }, 10);
  appendLog(log, { id: 2, type: "thread.text", payload: { message: "m1", block: 0, delta: "Hel" } }, 10);
  appendLog(log, { id: 3, type: "thread.text", payload: { message: "m1", block: 0, delta: "lo" } }, 10);
  appendLog(log, { id: 4, type: "thread.text", payload: { message: "m1", block: 0, delta: ".", done: true } }, 10);
  appendLog(log, { id: 5, type: "thread.text", payload: { message: "m1", block: 1, delta: "Next" } }, 10);
  assert.deepEqual(log.map(e => e.id), [1, 4, 5]);
  assert.equal(log[1].payload.delta, "Hello.");
  assert.equal(log[1].payload.done, true);
  // Replayed, the folded log builds the same session as the events did.
  const s = createSession("t1");
  for (const e of log) applyEvent(s, { ...e, payload: { ...e.payload, thread: "t1" } });
  assert.equal(/** @type {any} */ (s.byKey.get("m:m1:0")).text, "Hello.");
  assert.equal(s.meta.lastId, 5, "the newest id stays, so a catch-up asks since it");
  for (let i = 6; i < 30; i++) appendLog(log, { id: i, type: "thread.tool", payload: { id: `c${i}`, phase: "started" } }, 10);
  assert.equal(log.length, 10);
  assert.equal(log[9].id, 29);
});

test("session: box to screen from the event's stamp, skipped when absent or out of sync", { skip: !strip }, async () => {
  const { boxToScreen } = await load();
  assert.equal(boxToScreen(1000, 1180), 180);
  assert.equal(boxToScreen(1000, 1180, 20), 200);
  assert.equal(boxToScreen(undefined, 1180), null);
  assert.equal(boxToScreen(5000, 1000), null, "negative: the clocks are not synced");
});

test("session: a row re-renders only when what it draws changed", { skip: !strip }, async () => {
  const { sameRow } = await load();
  const a = { type: "item", key: "m:m1:0", kind: "text" };
  assert.equal(sameRow(a, { ...a }), true);
  assert.equal(sameRow(a, { ...a, kind: "reasoning" }), false);
  const run = { type: "run", key: "run:t:c1", keys: ["t:c1", "t:c2"], summary: "Read 2 files", running: false, failed: 0, open: false };
  assert.equal(sameRow(run, { ...run, keys: [...run.keys] }), true);
  assert.equal(sameRow(run, { ...run, summary: "Read 3 files", keys: [...run.keys, "t:c3"] }), false);
});
