// @ts-check
// Runs of tool items as one overview row. Sample world only.

import "../../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupItems, summarize, createGrouper } from "./grouping.js";

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

test("a teammate handoff (team_ask) is never folded either: it stays its own visible line (teammates.md section 3)", () => {
  const rows = groupItems([tool("t:1", "Grep"), tool("t:2", "team_ask", { input: { to: "design", text: "make it calmer" } }), tool("t:3", "Read"), tool("t:4", "Read", { summary: "Read y" })]);
  assert.deepEqual(rows.map(r => r.type === "run" ? `${r.key}[${r.keys.length}]` : r.key), ["t:1", "t:2", "run:t:3[2]"]);
});

// ---- incremental: createGrouper equals the full pass -------------------------------------------

/** A small seeded random, so a failure repeats. */
function rng(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }
const NAMES = ["Read", "Edit", "Bash", "Grep", "WebFetch", "TodoWrite", "ExitPlanMode", "Task", "mcp__kit__notes"];
const KINDS = ["text", "reasoning", "user", "turn", "ask", "notice"];

test("createGrouper: on random sequences of appends, in-place changes, inserts and removals, it equals groupItems", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const pick = a => a[Math.floor(r() * a.length)];
    let n = 0;
    const fresh = () => r() < 0.65
      ? tool(`t:${seed}:${n++}`, pick(NAMES), { status: pick(["running", "completed", "failed"]), summary: `file ${Math.floor(r() * 5)}` })
      : { key: `k:${seed}:${n++}`, kind: pick(KINDS) };
    /** @type {any[]} */ let items = [];
    const g = createGrouper();
    assert.deepEqual(g.rows(items, null), []);
    for (let step = 0; step < 300; step++) {
      const changed = new Set();
      const op = r();
      if (op < 0.4 || !items.length) {
        const k = 1 + Math.floor(r() * 3);
        for (let j = 0; j < k; j++) { const it = fresh(); items.push(it); changed.add(it.key); }
      } else if (op < 0.75) {
        // A tool's state changes in place: a running call finishes or fails, a detail arrives.
        const it = pick(items);
        if (it.kind === "tool") { it.status = pick(["completed", "failed", "running"]); if (r() < 0.2) it.detail = { type: pick(["edit", "read", "todo", "plan", "shell"]), filePath: "a.js" }; }
        else it.kind = pick(KINDS);
        changed.add(it.key);
        if (r() < 0.1) changed.add("@session");
      } else if (op < 0.85) {
        const at = Math.floor(r() * (items.length + 1));
        const it = fresh();
        items = [...items.slice(0, at), it, ...items.slice(at)];
        changed.add(it.key);
      } else if (op < 0.95) {
        const at = Math.floor(r() * items.length);
        changed.add(items[at].key);
        items = items.filter((_, i) => i !== at);
      } else {
        // An item becomes a tool (a live item replaced by its block) or stops being one.
        const at = Math.floor(r() * items.length);
        const it = items[at];
        items[at] = it.kind === "tool" ? { key: it.key, kind: pick(KINDS) } : tool(it.key, pick(NAMES));
        changed.add(it.key);
      }
      const want = groupItems(items);
      assert.deepEqual(g.rows(items, changed), want, `seed ${seed}, step ${step}`);
    }
    // A pass with nothing changed and a full pass agree too.
    assert.deepEqual(g.rows(items, []), groupItems(items));
    assert.deepEqual(g.rows(items), groupItems(items));
  }
});

test("createGrouper: a tool event at the tail keeps the rows above as the same objects", () => {
  const items = [];
  for (let i = 0; i < 200; i++) items.push({ key: `u:${i}`, kind: "user" }, tool(`t:${i}:a`, "Read", { summary: `f${i}` }), tool(`t:${i}:b`, "Bash"));
  const g = createGrouper();
  const first = g.rows(items).slice();
  items.push(tool("t:new", "Edit", { status: "running" }));
  const after = g.rows(items, ["t:new"]);
  assert.deepEqual(after, groupItems(items));
  for (let i = 0; i < first.length - 1; i++) assert.equal(after[i], first[i], `row ${i} kept`);
  assert.equal(after.at(-1).key, "run:t:199:a", "the new call joined the last run");
  assert.equal(after.at(-1).running, true);
  // It finishes: only that run is rebuilt.
  items.at(-1).status = "completed";
  const done = g.rows(items, ["t:new"]);
  assert.deepEqual(done, groupItems(items));
  for (let i = 0; i < first.length - 1; i++) assert.equal(done[i], first[i]);
  // A change far up stops at the next row that starts where it did.
  const before = done.slice();
  items[4].status = "failed";
  const up = g.rows(items, [items[4].key]);
  assert.deepEqual(up, groupItems(items));
  assert.notEqual(up[3], before[3], "the changed run is new");
  for (let i = 4; i < before.length; i++) assert.equal(up[i], before[i], `row ${i} after it kept`);
});
