// @ts-check
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/app/src/tool-calls/detail-level/grouping.ts
// and packages/app/src/tool-calls/detail-level/overview/model.ts,
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: plain JS over session-state
// items, one pass with no head/tail split, the summary as a sentence, a failed count.
//
// Runs of tool calls as one overview row. A session is mostly tool calls between the model's
// words; each as its own card is a long stack. Consecutive tool items fold into a run with a
// summary ("Edited 3 files, ran 2 commands"); a view shows the run closed and opens it on a tap.
// A run of one stays a plain item. A plan (ExitPlanMode) and a todo list are never folded: they are the things to read.
// Anything else (text, reasoning, a turn marker, a notice, an ask) ends a run, so an open ask is
// always its own row, and a run holding a running tool says so (running: true). Shared core: no
// DOM and no Node APIs.

/**
 * @typedef {{ type: "item", key: string }
 *   | { type: "run", key: string, keys: string[], summary: string, running: boolean, failed: number }} Row
 */

/** What kind a live tool is when no detail is known yet (live events carry no input). */
const BY_NAME = /** @type {Record<string, string>} */ ({
  Bash: "shell", Read: "read", Edit: "edit", MultiEdit: "edit", Write: "write", NotebookEdit: "edit",
  Grep: "search", Glob: "search", WebSearch: "search", WebFetch: "fetch", Task: "sub_agent", Agent: "sub_agent",
  TodoWrite: "todo", ExitPlanMode: "plan",
});

/** @param {any} item */
const typeOf = item => (item.detail && item.detail.type) || BY_NAME[item.name] || "unknown";

/** @param {any} item */
const foldable = item => item && item.kind === "tool" && typeOf(item) !== "plan" && typeOf(item) !== "todo";

/** @param {number} n @param {string} one @param {string} [many] */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A run's summary as one sentence: files edited and read are counted once each (by path, else
 * by the call's summary), commands, searches and fetches by call.
 * @param {any[]} tools
 */
export function summarize(tools) {
  const edited = new Set(), read = new Set();
  let commands = 0, searches = 0, fetches = 0, agents = 0, other = 0;
  for (const t of tools) {
    const type = typeOf(t);
    const file = (t.detail && t.detail.filePath) || t.summary || t.key;
    if (type === "edit" || type === "write") edited.add(file);
    else if (type === "read") read.add(file);
    else if (type === "shell") commands++;
    else if (type === "search") searches++;
    else if (type === "fetch") fetches++;
    else if (type === "sub_agent") agents++;
    else other++;
  }
  const parts = [];
  if (edited.size) parts.push(`edited ${count(edited.size, "file")}`);
  if (read.size) parts.push(`read ${count(read.size, "file")}`);
  if (commands) parts.push(`ran ${count(commands, "command")}`);
  if (searches) parts.push(`searched ${count(searches, "time")}`);
  if (fetches) parts.push(`fetched ${count(fetches, "page")}`);
  if (agents) parts.push(`started ${count(agents, "task")}`);
  if (other) parts.push(`used ${count(other, "tool")}`);
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Items as rows: each run of two or more consecutive foldable tool items is one row, keyed by
 * its first item so the key holds while the run grows.
 * @param {readonly any[]} items session-state items, in order
 * @returns {Row[]}
 */
export function groupItems(items) {
  /** @type {Row[]} */
  const rows = [];
  /** @type {any[]} */
  let run = [];
  const flush = () => {
    if (run.length === 1) rows.push({ type: "item", key: run[0].key });
    else if (run.length > 1) {
      rows.push({ type: "run", key: `run:${run[0].key}`, keys: run.map(t => t.key), summary: summarize(run),
        running: run.some(t => t.status === "running"), failed: run.filter(t => t.status === "failed").length });
    }
    run = [];
  };
  for (const item of items) {
    if (foldable(item)) { run.push(item); continue; }
    flush();
    rows.push({ type: "item", key: item.key });
  }
  flush();
  return rows;
}
