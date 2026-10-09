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
