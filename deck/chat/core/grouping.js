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
//
// groupItems is the pure pass over every item. createGrouper keeps the last pass and, given the
// keys that changed, recomputes only the rows those keys (and a tool appended to a run) touch:
// a tool event during a long session regroups its own run, not the whole session. It returns
// what groupItems would, and keeps the unchanged rows as the same objects.

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
    if (run.length) rows.push(runRow(run));
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

/** The row for a run of foldable tools: an item when it is one. @param {any[]} run @returns {Row} */
function runRow(run) {
  if (run.length === 1) return { type: "item", key: run[0].key };
  return { type: "run", key: `run:${run[0].key}`, keys: run.map(t => t.key), summary: summarize(run),
    running: run.some(t => t.status === "running"), failed: run.filter(t => t.status === "failed").length };
}

/**
 * Grouping that remembers its last pass. rows(items, changed) returns what groupItems(items)
 * would, redoing only the rows from the one before the first change: `changed` names the items
 * whose fields changed in place (session-state's keys; other names are ignored), and items added,
 * removed or moved are found by comparing the keys with the last pass's. A change in place stops
 * at the first row past it that starts where it did, and the rows after it are kept. Without
 * `changed` (or the first time) it is a full pass. The returned array is the grouper's own and is
 * changed in place by the next call; unchanged rows stay the same objects.
 * @returns {{ rows: (items: readonly any[], changed?: Iterable<string> | null) => Row[], reset: () => void }}
 */
export function createGrouper() {
  /** The last pass: item keys in order, where each key is, each item's row, each row's first item, the rows. */
  /** @type {string[]} */ let keys = [];
  /** @type {Map<string, number>} */ let index = new Map();
  /** @type {number[]} */ let rowOf = [];
  /** @type {number[]} */ let rowStart = [];
  /** @type {Row[] | null} */ let rows = null;

  function reset() { keys = []; index = new Map(); rowOf = []; rowStart = []; rows = null; }

  /**
   * Rows for items[from..], stopping (when `hi` is given) at the first item past `hi` where an old
   * row starts and the new grouping is at a row boundary too.
   * @param {readonly any[]} items @param {number} from @param {number|null} hi
   */
  function build(items, from, hi) {
    /** @type {Row[]} */ const out = [];
    /** @type {number[]} */ const starts = [];
    const n = items.length;
    const oldStart = (/** @type {number} */ i) => hi !== null && i > hi && i < keys.length && rowStart[rowOf[i]] === i;
    /** @type {any[]} */ let run = [];
    let runAt = from;
    for (let i = from; i < n; i++) {
      const item = items[i];
      if (!run.length && oldStart(i)) return { out, starts, kept: i };
      if (foldable(item)) { if (!run.length) runAt = i; run.push(item); continue; }
      if (run.length) { out.push(runRow(run)); starts.push(runAt); run = []; if (oldStart(i)) return { out, starts, kept: i }; }
      out.push({ type: "item", key: item.key });
      starts.push(i);
    }
    if (run.length) { out.push(runRow(run)); starts.push(runAt); }
    return { out, starts, kept: -1 };
  }

  /** Item row numbers for `starts` (rows numbered from r0), items from..end. @param {number[]} starts @param {number} r0 @param {number} end */
  function number(starts, r0, end) {
    for (let r = 0; r < starts.length; r++) {
      const stop = r + 1 < starts.length ? starts[r + 1] : end;
      for (let i = starts[r]; i < stop; i++) rowOf[i] = r0 + r;
    }
  }

  /** arr[from..upto) becomes `put`, in place. @template T @param {T[]} arr @param {number} from @param {number} upto @param {T[]} put */
  function replace(arr, from, upto, put) {
    if (put.length === upto - from) { for (let i = 0; i < put.length; i++) arr[from + i] = put[i]; return; }
    const tail = arr.slice(upto);
    arr.length = from;
    for (const x of put) arr.push(x);
    for (const x of tail) arr.push(x);
  }

  /** @param {readonly any[]} items @param {Iterable<string> | null | undefined} changed @returns {Row[]} */
  function group(items, changed) {
    const n = items.length;
    if (!rows || !changed) {
      reset();
      const { out, starts } = build(items, 0, null);
      keys = items.map(it => it.key);
      keys.forEach((k, i) => index.set(k, i));
      rowOf = new Array(n);
      number(starts, 0, n);
      rowStart = starts;
      rows = out;
      return rows;
    }
    const m = Math.min(n, keys.length);
    let d = 0;
    while (d < m && items[d].key === keys[d]) d++;
    const structural = d < n || d < keys.length;
    let lo = structural ? d : n, hi = -1;
    for (const k of changed) {
      const i = index.get(k);
      if (i === undefined || i >= d) continue;         // past the divergence: rebuilt anyway
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    }
    if (!structural && hi < 0) return rows;
    // From the row holding the item before the first change: a tool may join the run before it.
    const r0 = lo > 0 ? rowOf[lo - 1] : 0;
    const from = lo > 0 ? rowStart[r0] : 0;
    if (!structural) {
      const { out, starts, kept } = build(items, from, hi);
      const upto = kept === -1 ? rows.length : rowOf[kept];
      const shift = r0 + out.length - upto;
      replace(rows, r0, upto, out);
      replace(rowStart, r0, upto, starts);
      number(starts, r0, kept === -1 ? n : kept);
      if (shift !== 0 && kept !== -1) for (let i = kept; i < n; i++) rowOf[i] += shift;
      return rows;
    }
    const { out, starts } = build(items, from, null);
    rows.length = r0; rows.push(...out);
    rowStart.length = r0; rowStart.push(...starts);
    for (let i = from; i < keys.length; i++) index.delete(keys[i]);
    keys.length = from; rowOf.length = n;
    for (let i = from; i < n; i++) { keys.push(items[i].key); index.set(items[i].key, i); }
    number(starts, r0, n);
    return rows;
  }

  return { rows: group, reset };
}
