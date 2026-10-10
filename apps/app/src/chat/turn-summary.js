// @ts-check
// What a turn did, as one line under it: "3 files, 4 commands, 1 min". Pure: it reads the items a turn folded into (tools, terminal and diff blocks) and says how many files changed,
// how many commands ran, how many of Vyre tools it used (two or more is what "Turn this into a Flow" offers) and how long it took. A turn that did none of those has no line. The files keep their diff blocks so the changes panel can show each one.

const SHELL = new Set(["terminal", "shell", "Bash"]);
/** A tool of Vyre itself (its MCP tools, or a work, records, tasks, flows, comms, mail, calendar or projects tool by name): what a Flow could repeat. */
const VYRE_TOOL = /^(mcp__vyre__|(work|records|tasks|flows|comms|mail|calendar|projects)[._])/;
const count = (/** @type {number} */ n, /** @type {string} */ one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 min", "40 sec", or "" when it was quick. @param {number} ms */
export function took(ms) {
  if (!(ms >= 5000)) return "";
  return ms < 60_000 ? `${Math.round(ms / 1000)} sec` : `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** The files a diff block names, each with its add and delete lines. @param {any} b @returns {{ path: string, op: string, add: number, del: number }[]} */
function filesOf(b) {
  if (!b || typeof b !== "object") return [];
  const lines = (/** @type {unknown} */ s) => (typeof s === "string" && s ? s.split("\n").length : 0);
  if (b.block === "diff" && typeof b.path === "string") {
    /** @type {any[]} */ const hunks = Array.isArray(b.hunks) ? b.hunks : [];
    return [{ path: b.path, op: "edit", add: hunks.reduce((/** @type {number} */ n, /** @type {any} */ h) => n + lines(h && h.add), 0), del: hunks.reduce((/** @type {number} */ n, /** @type {any} */ h) => n + lines(h && h.del), 0) }];
  }
  if (b.block === "files" && Array.isArray(b.files)) return b.files.filter((/** @type {any} */ f) => f && typeof f.path === "string").map((/** @type {any} */ f) => ({ path: f.path, op: String(f.op || "edit"), add: Number(f.add) || 0, del: Number(f.del) || 0 }));
  return [];
}

/** The unified text of one edit's hunks, so the panel's diff view can draw it. @param {any} b */
function unified(b) {
  if (b && b.block === "diff" && Array.isArray(b.hunks)) {
    return b.hunks.map((/** @type {any} */ h) => "@@\n" + String((h && h.del) || "").split("\n").filter((/** @type {string} */ l, /** @type {number} */ i, /** @type {string[]} */ a) => l || a.length > 1).map((/** @type {string} */ l) => `-${l}`).join("\n") + "\n" + String((h && h.add) || "").split("\n").map((/** @type {string} */ l) => `+${l}`).join("\n")).join("\n");
  }
  return "";
}

/**
 * @param {readonly any[]} items the items of one turn, in order
 * @param {number} ms how long the turn took (0 when not known)
 * @returns {{ files: { path: string, op: string, add: number, del: number }[], diffs: { path: string, op: string, diff: string }[], commands: number, vyreCalls: number, ms: number, line: string } | null}
 */
export function turnSummary(items, ms = 0) {
  /** @type {Map<string, { path: string, op: string, add: number, del: number }>} */ const files = new Map();
  /** @type {Map<string, { path: string, op: string, diff: string }>} */ const diffs = new Map();
  let commands = 0, vyreCalls = 0;
  for (const it of items) {
    if (!it || (it.kind !== "tool" && it.kind !== "block")) continue;
    if (VYRE_TOOL.test(String(it.tool))) vyreCalls++;
    if (it.block && (it.block.block === "diff" || it.block.block === "files")) {
      const hunksText = unified(it.block);
      if (it.block.block === "files") for (const f of it.block.files || []) { if (f && typeof f.path === "string") { const had = diffs.get(f.path); diffs.set(f.path, { path: f.path, op: String(f.op || "edit"), diff: (had ? had.diff + "\n" : "") + String(f.diff || "") }); } }
      else if (it.block.path) { const had = diffs.get(it.block.path); diffs.set(it.block.path, { path: it.block.path, op: "edit", diff: (had ? had.diff + "\n" : "") + hunksText }); }
      for (const f of filesOf(it.block)) { const had = files.get(f.path); files.set(f.path, had ? { ...had, add: had.add + f.add, del: had.del + f.del } : f); }
    } else if (it.tool === "file" && it.summary) { const had = files.get(it.summary); if (!had) files.set(it.summary, { path: it.summary, op: "edit", add: 0, del: 0 }); }
    else if (SHELL.has(String(it.toolKind)) || SHELL.has(String(it.tool)) || (it.block && it.block.block === "terminal")) commands++;
  }
  if (!files.size && !commands && vyreCalls < 2) return null;
  const parts = [];
  if (files.size) parts.push(count(files.size, "file"));
  if (commands) parts.push(count(commands, "command"));
  if (vyreCalls >= 2) parts.push(count(vyreCalls, "action"));
  const t = took(ms);
  if (t) parts.push(t);
  return { files: [...files.values()], diffs: [...diffs.values()], commands, vyreCalls, ms, line: parts.join(", ") };
}
