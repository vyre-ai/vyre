// @ts-check
// adapter: real event shapes from the repo (the switchboard's thread.* vocabulary as
// deck/chat/core/session-state.test.js feeds it, the transcripts fixture, core/term's ring) become frames.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter, pipe, stateWord, stoppedState } from "./adapter.js";
import { SessionLog } from "./log.js";
import { validate } from "./protocol.js";
import { blocks } from "../transcripts/index.js";
import { Ring } from "../term/ring.js";

const RICH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "transcripts", "fixtures", "rich.jsonl");
const ev = (/** @type {string} */ type, /** @type {any} */ payload) => ({ type, payload });
const kinds = (/** @type {any[]} */ specs) => specs.map(s => s.kind);

test("adapter: streamed text becomes deltas then text-done; a done text with no deltas still yields its words once", () => {
  const a = createAdapter();
  const out = [
    ...a.event(ev("thread.text", { message: "msg_1", delta: "Looking at " })),
    ...a.event(ev("thread.text", { message: "msg_1", delta: "the invoice." })),
    ...a.event(ev("thread.text", { message: "msg_1", text: "Looking at the invoice.", done: true })),
    ...a.event(ev("thread.text", { message: "msg_2", block: 0, text: "Second answer.", done: true })),
  ];
  assert.deepEqual(kinds(out), ["text-delta", "text-delta", "text-done", "text-delta", "text-done"]);
  assert.equal(out.filter(s => s.kind === "text-delta").map(s => s.data.text).join(""), "Looking at the invoice.Second answer.", "the done text is not repeated after its deltas");
  assert.deepEqual(out[2].data, { message: "msg_1", index: 0 });
});

test("adapter: reasoning and notices", () => {
  const a = createAdapter();
  const r = a.event(ev("thread.text", { message: "msg_r", block: 0, kind: "reasoning", delta: "Thinking " }));
  assert.equal(r[0].data.reasoning, true);
  const t = a.event(ev("thread.thinking", { message: "msg_r", block: 1, text: "Whole thought.", done: true }));
  assert.deepEqual(kinds(t), ["text-delta", "text-done"]);
  assert.equal(t[0].data.reasoning, true);
  const n = a.event(ev("thread.text", { message: "vyre", text: "The subscription's limit is at 80%.", done: true, notice: true }));
  assert.deepEqual(kinds(n), ["text-delta", "text-done"]);
  assert.equal(n[0].data.message, "vyre");
});

test("adapter: a tool call is tool-started, then tool-finished with a typed block (old phase shape and new status shape)", () => {
  const a = createAdapter();
  const s1 = a.event(ev("thread.tool", { id: "tu_1", call: "tu_1", tool: "Read", phase: "started", summary: "Read invoices/northwind.js" }));
  assert.deepEqual(s1.map(s => s.data.kind), ["read"]);
  const f1 = a.event(ev("thread.tool", { id: "tu_1", call: "tu_1", phase: "done", error: false }));
  assert.deepEqual(kinds(f1), ["tool-finished"]);
  assert.equal(f1[0].data.ok, true);
  assert.equal(f1[0].data.result.block, "text", "no input or output known: a short summary, not an empty block");
  assert.equal(f1[0].data.result.text, "Read invoices/northwind.js");

  const s2 = a.event(ev("thread.tool", { call: "tu_2", name: "Bash", status: "running", summary: "npm test", input: { command: "npm test" } }));
  assert.equal(s2[0].data.kind, "shell");
  const f2 = a.event(ev("thread.tool", { call: "tu_2", status: "failed", error: "exit 1", output: "1 failing\nexit code: 1" }));
  assert.equal(f2[0].data.ok, false);
  assert.equal(f2[0].data.result.block, "terminal");
  assert.equal(f2[0].data.result.exit, 1);
  assert.equal(f2.length, 1);
});

test("adapter: a finished Edit or Write also yields file-changed", () => {
  const a = createAdapter();
  a.event(ev("thread.tool", { call: "e1", tool: "Edit", status: "running", input: { file_path: "src/order.js", old_string: "a", new_string: "b" } }));
  const f = a.event(ev("thread.tool", { call: "e1", status: "completed" }));
  assert.deepEqual(kinds(f), ["tool-finished", "file-changed"]);
  assert.equal(f[0].data.result.block, "diff");
  assert.deepEqual(f[1].data, { path: "src/order.js", op: "edit" });
  a.event(ev("thread.tool", { call: "w1", tool: "Write", status: "running", input: { file_path: "new.js", content: "x" } }));
  assert.equal(a.event(ev("thread.tool", { call: "w1", status: "completed" }))[1].data.op, "create");
  a.event(ev("thread.tool", { call: "e2", tool: "Edit", status: "running", input: { file_path: "p" } }));
  assert.deepEqual(kinds(a.event(ev("thread.tool", { call: "e2", status: "failed", error: true }))), ["tool-finished"], "a failed edit changed nothing");
});

test("adapter: tool-progress, plan and tasks", () => {
  const a = createAdapter();
  a.event(ev("thread.tool", { call: "t", tool: "Bash", status: "running", input: { command: "make" } }));
  assert.deepEqual(a.event(ev("thread.tool", { call: "t", status: "running", text: "compiling", pct: 40 }))[0].data, { tool_id: "t", text: "compiling", pct: 40 });
  const p = a.event(ev("thread.plan", { items: [{ text: "one", status: "done" }, { text: "two" }] }));
  assert.deepEqual(p[0].data.result, { block: "task", items: [{ text: "one", status: "done" }, { text: "two", status: "pending" }] });
  assert.deepEqual(a.event(ev("thread.plan", { items: [] })), []);
  assert.deepEqual(kinds(a.event(ev("thread.task", { id: 7, kind: "shell", title: "dev server", status: "running" }))), ["tool-started"]);
  assert.equal(a.event(ev("thread.task", { id: 7, status: "completed", title: "dev server" }))[0].data.ok, true);
});

test("adapter: asks, answers and cancellations", () => {
  const a = createAdapter();
  assert.deepEqual(a.event(ev("ask.raised", { ask: "ask-1", tool: "Bash", summary: "rm -rf build" }))[0].data, { ask_id: "ask-1", kind: "permission", tool: "Bash", summary: "rm -rf build" });
  assert.equal(a.event(ev("ask.raised", { ask: "ask-2", kind: "question" }))[0].data.kind, "question");
  assert.deepEqual(a.event(ev("ask.answered", { ask: "ask-1", decision: "allow" }))[0].data, { ask_id: "ask-1", decision: "allow" });
  assert.equal(a.event(ev("ask.cancelled", { ask: "ask-2" }))[0].data.decision, "cancelled");
  assert.deepEqual(a.event(ev("ask.raised", {})), []);
});

test("adapter: messages sent, queued, steered and picked up keep their words by uuid", () => {
  const a = createAdapter();
  const q = a.event(ev("thread.queued", { queued: 12, uuid: "u-9", text: "also fix the footer", queued_at: 5 }));
  assert.deepEqual(q[0].data, { message: "u-9", text: "also fix the footer", state: "queued", queued_at: 5 });
  const st = a.event(ev("thread.steered", { uuid: "u-9" }));
  assert.deepEqual(st[0].data, { message: "u-9", text: "also fix the footer", state: "picked-up" });
  assert.equal(a.event(ev("thread.sent", { text: "hello", uuid: "u-1" }))[0].data.state, "sent");
  assert.equal(a.event(ev("thread.sent", { text: "go", uuid: "u-2", via: "steer", queued_at: 7 }))[0].data.state, "queued", "a steer waits for its next safe point");
  assert.equal(a.event(ev("thread.sent", { text: "now", uuid: "u-3", via: "turn" }))[0].data.state, "picked-up");
  assert.deepEqual(a.event(ev("thread.sent", { kind: "teammate-result", text: "x" })), []);
  assert.deepEqual(a.event(ev("thread.unqueued", { queued: 12, uuid: "u-9" }))[0].data, { message: "u-9", text: "also fix the footer", state: "cancelled" });
  assert.deepEqual(a.event(ev("thread.unqueued", {})), []);
  assert.deepEqual(a.event(ev("thread.status", { status: "working", stopping: true }))[0].data, { state: "working", stopping: true });
  assert.deepEqual(a.event(ev("term.command", { term: "t1", session: "s", command: "ls -la" }))[0], { kind: "term-command", data: { term: "t1", command: "ls -la" }, turn: null });
  assert.deepEqual(a.event(ev("term.command", { term: "t1" })), []);
  // the typist rides on the frame
  assert.deepEqual(a.event(ev("term.command", { term: "t1", session: "s", command: "ls", author: "person:carol", via: "tailnet:carol", surface: "deck:c" }))[0], { kind: "term-command", data: { term: "t1", command: "ls", via: "tailnet:carol", surface: "deck:c" }, turn: null, author: "person:carol" });
});

test("adapter: status comes from thread.status; the legacy thread.state is ignored once thread.status was seen", () => {
  const a = createAdapter();
  assert.deepEqual(a.event(ev("thread.started", {}))[0].data, { state: "starting" });
  assert.equal(a.event(ev("thread.state", { state: "running" }))[0].data.state, "working");
  assert.equal(a.event(ev("thread.state", { state: "waiting" }))[0].data.state, "asking", "raw waiting is an open ask");
  assert.equal(a.event(ev("thread.state", { state: "idle" }))[0].data.state, "waiting");
  const s = a.event(ev("thread.status", { status: "working", turn: "thr:3" }));
  assert.deepEqual(s[0].data, { state: "working", turn: "3" });
  assert.deepEqual(a.event(ev("thread.state", { state: "idle" })), [], "ignored");
  assert.deepEqual(a.event(ev("thread.finished", { ok: true })), [], "thread.status says it");
  const t = a.event(ev("thread.turn", { turn: "thr:4", text: "next", uuid: "u-4" }));
  assert.deepEqual(t.map(x => x.kind), ["user-message"]);
  assert.equal(t[0].turn, "4");
  assert.equal(a.turn, "4");
  assert.equal(stateWord("running"), "working");
  assert.equal(stoppedState("idle"), "paused");
  assert.equal(stoppedState("done"), "finished");
  assert.equal(stoppedState("exited 2"), "failed");
  assert.equal(stoppedState("stop"), "stopped");
});

test("adapter: an older switchboard without thread.status still gets turn and stop statuses", () => {
  const a = createAdapter();
  assert.deepEqual(a.event(ev("thread.turn", { turn: "t:1" })).map(s => s.data), [{ state: "working", turn: "1" }]);
  assert.equal(a.event(ev("thread.finished", { ok: true }))[0].data.state, "waiting");
  assert.equal(a.event(ev("thread.finished", { ok: false, error: "boom" }))[0].data.state, "failed");
  assert.equal(a.event(ev("thread.stopped", { reason: "restart" }))[0].data.state, "paused");
});

test("adapter: header-only and unknown events map to nothing", () => {
  const a = createAdapter();
  for (const t of ["thread.usage", "thread.limit", "mode.changed", "model.switched", "thinking.switched", "thread.remembered", "settings.changed"]) assert.deepEqual(a.event(ev(t, { x: 1 })), [], t);
  assert.deepEqual(a.event(/** @type {any} */ (null)), []);
});

test("adapter: a shell line the person ran is term-command then its output at running offsets", () => {
  const a = createAdapter();
  const s = a.event(ev("thread.shell", { command: "git status", code: 0, output: "clean\n" }));
  assert.deepEqual(kinds(s), ["term-command", "term-chunk"]);
  assert.equal(s[1].data.offset, 0);
  assert.equal(Buffer.from(s[1].data.b64, "base64").toString(), "clean\n");
  assert.equal(a.event(ev("thread.shell", { command: "ls", output: "ab" }))[1].data.offset, 6);
});

test("adapter: core/term ring bytes become term-chunks whose offsets match the ring", () => {
  const ring = new Ring(1 << 20);
  const a = createAdapter();
  /** @type {any[]} */ const all = [];
  for (const chunk of ["$ ls\r\n", "a.txt  b.txt\r\n", "x".repeat(40_000)]) {
    const at = ring.end;
    ring.push(Buffer.from(chunk));
    all.push(...a.term("t_1", at, Buffer.from(chunk)));
  }
  assert.ok(all.length >= 5, "the long chunk is split");
  let expect = 0;
  for (const s of all) { assert.equal(s.data.offset, expect); expect += Buffer.from(s.data.b64, "base64").length; }
  assert.equal(expect, ring.end);
  assert.equal(Buffer.concat(all.map(s => Buffer.from(s.data.b64, "base64"))).toString(), ring.since(0).toString());
});

test("adapter: transcript blocks (the rich fixture) become valid frames: users, text, tools with typed blocks", () => {
  const { blocks: bs } = blocks(RICH, { from: 0 });
  const a = createAdapter();
  const log = new SessionLog("rich", { coalesce: false });
  for (const b of bs) for (const s of a.block(b)) log.append(s.kind, s.data, { turn: s.turn ?? null });
  const all = log.read(0);
  assert.ok(all.length > 10);
  for (const f of all) assert.deepEqual(validate(f), { ok: true }, f.type);
  const types = new Set(all.map(f => f.type));
  for (const k of ["session.user-message", "session.text-delta", "session.text-done", "session.tool-started", "session.tool-finished", "session.term-command"]) assert.ok(types.has(k), k);
  const fin = all.filter(f => f.type === "session.tool-finished");
  assert.ok(fin.length >= 4);
  assert.ok(fin.every(f => f.data.result.block && !/^\s*[\[{]/.test(f.data.result.text || "")), "never a JSON dump");
  assert.ok(!JSON.stringify(all).includes("NorthwindBakery0000fake"), "the pasted key stayed redacted");
  assert.ok(fin.some(f => ["diff", "terminal", "files"].includes(f.data.result.block)), "typed blocks for known tools");
});

test("adapter: pipe() appends frames through the log with the adapter's turn", () => {
  const log = new SessionLog("s1");
  const a = createAdapter();
  pipe(log, a, ev("thread.turn", { turn: "x:2" }));
  const fs = pipe(log, a, ev("thread.text", { message: "m", delta: "hi" }));
  assert.equal(fs[0].turn, "2");
  assert.equal(fs[0].cur, 2);
  assert.equal(fs[0].corr, "2");
});
