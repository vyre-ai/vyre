// @ts-check
// Runs of tool items as one overview row. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { groupItems, summarize } from "./grouping.js";

const tool = (key, name, extra = {}) => ({ key, kind: "tool", name, status: "completed", ...extra });

test("consecutive tools between texts fold into one run with a summary", () => {
  const rows = groupItems([
    { key: "u:1", kind: "user" },
    { key: "m:a:0", kind: "text" },
    tool("t:1", "Edit", { detail: { type: "edit", filePath: "a.js" } }),
    tool("t:2", "Edit", { detail: { type: "edit", filePath: "b.js" } }),
    tool("t:3", "Write", { detail: { type: "write", filePath: "c.js" } }),
    tool("t:4", "Edit", { detail: { type: "edit", filePath: "a.js" } }),
    tool("t:5", "Bash"),
    tool("t:6", "Bash", { status: "failed" }),
    { key: "m:a:1", kind: "text" },
  ]);
  assert.deepEqual(rows, [
    { type: "item", key: "u:1" },
    { type: "item", key: "m:a:0" },
    { type: "run", key: "run:t:1", keys: ["t:1", "t:2", "t:3", "t:4", "t:5", "t:6"], summary: "Edited 3 files, ran 2 commands", running: false, failed: 1 },
    { type: "item", key: "m:a:1" },
  ]);
});

test("a run of one stays an item; a plan is never folded; an ask ends a run", () => {
  const rows = groupItems([
    tool("t:1", "Read"),
    { key: "m:x:0", kind: "text" },
    tool("t:2", "Grep"),
    tool("t:3", "ExitPlanMode", { detail: { type: "plan", text: "Plan" } }),
    tool("t:4", "Bash", { status: "running" }),
    { key: "a:1", kind: "ask", state: "open" },
    tool("t:5", "Read", { summary: "Read x" }),
    tool("t:6", "WebFetch", { status: "running" }),
  ]);
  assert.deepEqual(rows.map(r => r.type === "run" ? `${r.key}[${r.keys.length}]${r.running ? "*" : ""}` : r.key),
    ["t:1", "m:x:0", "t:2", "t:3", "t:4", "a:1", "run:t:5[2]*"]);
});

test("summaries count files once and say every kind", () => {
  assert.equal(summarize([tool("a", "Read", { summary: "Read x" }), tool("b", "Read", { summary: "Read x" })]), "Read 1 file");
  assert.equal(summarize([tool("a", "Grep"), tool("b", "WebSearch"), tool("c", "WebFetch"), tool("d", "Task"), tool("e", "mcp__kit__notes")]),
    "Searched 2 times, fetched 1 page, started 1 task, used 1 tool");
  assert.deepEqual(groupItems([]), []);
});

test("a todo list is never folded: it is the thing to read", () => {
  const rows = groupItems([tool("t:1", "Grep"), tool("t:2", "TodoWrite"), tool("t:3", "Read"), tool("t:4", "Read", { summary: "Read y" })]);
  assert.deepEqual(rows.map(r => r.type === "run" ? `${r.key}[${r.keys.length}]` : r.key), ["t:1", "t:2", "run:t:3[2]"]);
});
