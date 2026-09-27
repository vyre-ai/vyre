// @ts-check
// The app's side of a session (model.ts) over chat's own core (deck/chat/core), as the app runs
// it: threads.get's events into session-state, the header's words, and the transcript's rows with
// runs of tools folded. Loaded through Node's type stripping, so skipped on a Node without it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, applyEvent } from "../../../../deck/chat/core/session-state.js";
import { groupItems } from "../../../../deck/chat/core/grouping.js";

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
  assert.equal(s.state, "idle");
  assert.deepEqual(stateWords(s), { word: "idle", note: "Resumes on your next message", ended: false });
  assert.equal(busy(s.state), false);
  // Another thread's event is not this one's.
  const other = toSessionEvent({ id: 11, type: "thread.text", thread: "t2", payload: { message: "x", delta: "no" } }, "t1");
  assert.ok(other);
  assert.deepEqual(applyEvent(s, other), []);
});

test("session: a stop that is not for idleness reads as ended", { skip: !strip }, async () => {
  const { stateWords, stateOf } = await load();
  assert.deepEqual(stateWords({ state: "stopped", stopped: "stopped" }), { word: "ended", note: "Stopped", ended: true });
  assert.equal(stateOf("stopped", "idle"), "idle");
  assert.equal(stateOf("working"), "running");
  assert.equal(stateOf("waiting"), "waiting");
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
  assert.deepEqual(sendOutcome({ data: { sent: true, thread: "t1" } }), { ok: true, queued: false });
  assert.deepEqual(sendOutcome({ data: { sent: false, queued: true, open_elsewhere: true } }), { ok: true, queued: true });
  assert.deepEqual(sendOutcome({ data: { sent: false, holder: "deck", note: "deck holds this session" } }), { ok: false, reason: "deck holds this session" });
  assert.deepEqual(sendOutcome({ error: { code: "not_found", message: "no such thread" } }), { ok: false, reason: "no such thread" });
});
