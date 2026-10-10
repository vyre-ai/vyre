// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { turnSummary, took } from "./turn-summary.js";
import { createFolder } from "./frames.js";

const edit = (path, add = "b", del = "a") => ({ kind: "tool", tool: "Edit", block: { block: "diff", path, hunks: [{ del, add }] } });

test("a turn's line counts its files and commands once each and says how long it took", () => {
  const s = turnSummary([edit("a.js"), edit("a.js", "c\nd"), edit("b.js"), { kind: "block", tool: "terminal", toolKind: "terminal", block: null }, { kind: "tool", tool: "Bash", toolKind: "shell" }, { kind: "text" }], 95_000);
  assert.equal(s?.line, "2 files, 2 commands, 2 min");
  assert.deepEqual(s?.files.map((f) => f.path), ["a.js", "b.js"]);
  assert.equal(s?.files[0].add, 3, "both edits of a file add up");
  assert.deepEqual(s?.diffs.map((d) => d.path), ["a.js", "b.js"]);
  assert.match(s?.diffs[0].diff ?? "", /^@@\n-a\n\+b\n@@\n-a\n\+c\n\+d$/, "both edits of a file are one diff");
});

test("a turn that changed no file and ran no command has no line, and a quick one omits the time", () => {
  assert.equal(turnSummary([{ kind: "text" }, { kind: "tool", tool: "Read" }], 90_000), null);
  assert.equal(turnSummary([edit("a.js")], 1200)?.line, "1 file");
  assert.equal(took(40_000), "40 sec");
  assert.equal(took(2000), "");
});

test("the chat folds a finished turn into one summary row after its last row, once, and not for a turn that did nothing", () => {
  const f = createFolder();
  const fr = (cur, type, data, time) => ({ v: 1, id: `f${cur}`, cur, session: "s", turn: "t1", type: "session." + type, time, corr: null, data });
  let cur = 0;
  const feed = (type, data, time) => f.apply(fr(++cur, type, data, time));
  feed("status", { state: "working", turn: "t1" }, 1000);
  feed("tool-started", { tool_id: "t1", tool: "Edit", kind: "tool", summary: "Edit a.js" }, 1100);
  feed("tool-finished", { tool_id: "t1", ok: true, result: { block: "diff", path: "a.js", hunks: [{ del: "x", add: "y" }] } }, 1200);
  feed("status", { state: "waiting", turn: "t1" }, 61_000);
  const rows = f.rows;
  assert.equal(rows[rows.length - 1].kind, "turnsummary");
  assert.equal(f.item(rows[rows.length - 1].key).line, "1 file, 1 min");
  feed("status", { state: "working", turn: "t2" }, 70_000);
  feed("status", { state: "waiting", turn: "t2" }, 71_000);
  assert.equal(f.rows.filter((r) => r.kind === "turnsummary").length, 1, "a turn that did nothing leaves no line");
});

test("a turn that used two or more of Vyre tools says so and offers a Flow; one does not; the other tools do not count", () => {
  const vyre = (tool) => ({ kind: "tool", tool, summary: "" });
  const s = turnSummary([vyre("mcp__vyre__work_call"), vyre("mcp__vyre__records_create"), { kind: "tool", tool: "Read" }], 0);
  assert.equal(s && s.vyreCalls, 2);
  assert.equal(s && s.line, "2 actions");
  assert.equal(turnSummary([vyre("records.create"), { kind: "tool", tool: "Read" }], 0), null, "one is not a pattern to repeat");
  const both = turnSummary([edit("a.js"), vyre("flows.list"), vyre("tasks.create")], 0);
  assert.equal(both && both.line, "1 file, 2 actions");
});

test("the folder gives a turn of two Vyre tool calls a summary line that offers the Flow", () => {
  const f = createFolder();
  const fr = (cur, type, data, time) => ({ v: 1, id: `f${cur}`, cur, session: "s", turn: "t1", type: "session." + type, time, corr: null, data });
  let cur = 0;
  const feed = (type, data, time) => f.apply(fr(++cur, type, data, time));
  feed("status", { state: "working", turn: "t1" }, 1000);
  feed("tool-started", { tool_id: "a", tool: "mcp__vyre__work_call", kind: "tool", summary: "" }, 1100);
  feed("tool-finished", { tool_id: "a", ok: true }, 1200);
  feed("tool-started", { tool_id: "b", tool: "mcp__vyre__records_create", kind: "tool", summary: "" }, 1300);
  feed("tool-finished", { tool_id: "b", ok: true }, 1400);
  feed("status", { state: "waiting", turn: "t1" }, 2000);
  const last = f.rows[f.rows.length - 1];
  assert.equal(last.kind, "turnsummary", JSON.stringify(f.rows.map((r) => r.kind)));
  assert.equal(f.item(last.key).vyreCalls, 2);
});

test("a group chat has no status frames: a closed step gives the turn its line, kept under the last message, and it offers the Flow once", () => {
  const f = createFolder();
  const fr = (cur, type, data, time) => ({ v: 1, id: `f${cur}`, cur, session: "s", turn: "t1", type: "chat." + type, time, corr: null, data });
  let cur = 0;
  const feed = (type, data, time) => f.apply(fr(++cur, type, data, time));
  feed("user-message", { message: "m1", text: "do both", state: "sent" }, 1000);
  feed("tool-started", { tool_id: "a", tool: "mcp__vyre__work_call", kind: "other", summary: "" }, 1200);
  feed("tool-finished", { tool_id: "a", ok: true }, 1300);
  feed("tool-started", { tool_id: "b", tool: "mcp__vyre__records_create", kind: "other", summary: "" }, 1400);
  feed("tool-finished", { tool_id: "b", ok: true }, 1500);
  feed("step-summary", { step: "s1", count: 2, kinds: { other: 2 }, summary: "2 steps", ok: true }, 1550);
  feed("text-delta", { message: "m1.claude", index: 0, text: "done" }, 1600);
  feed("text-done", { message: "m1.claude", index: 0 }, 1700);
  const kinds = f.rows.map((r) => r.kind);
  assert.deepEqual(kinds.filter((k) => k === "turnsummary").length, 1, JSON.stringify(kinds));
  assert.equal(kinds[kinds.length - 1], "turnsummary", "the line is under the last message");
  const it = f.item(f.rows[f.rows.length - 1].key);
  assert.equal(it.vyreCalls, 2);
  assert.equal(it.line, "2 actions");
  feed("user-message", { message: "m2", text: "again", state: "sent" }, 2000);
  assert.equal(f.rows.filter((r) => r.kind === "turnsummary").length, 1, "the next turn starts with no line of its own yet");
});
