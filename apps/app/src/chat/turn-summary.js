// @ts-check
// What a turn did, as one line under it: "3 files, 4 commands, 1 min". Pure: it reads the items a turn folded into (tools, terminal and diff blocks) and says how many files changed,
// how many commands ran and how long it took. A turn that changed no file and ran no command has none. The files keep their diff blocks so the changes panel can show each one.

const SHELL = new Set(["terminal", "shell", "Bash"]);
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

/**
 * @param {readonly any[]} items the items of one turn, in order
 * @param {number} ms how long the turn took (0 when not known)
 * @returns {{ files: { path: string, op: string, add: number, del: number }[], blocks: any[], commands: number, ms: number, line: string } | null}
 */
export function turnSummary(items, ms = 0) {
  /** @type {Map<string, { path: string, op: string, add: number, del: number }>} */ const files = new Map();
  /** @type {any[]} */ const blocks = [];
  let commands = 0;
  for (const it of items) {
    if (!it || (it.kind !== "tool" && it.kind !== "block")) continue;
    if (it.block && (it.block.block === "diff" || it.block.block === "files")) {
      blocks.push(it.block);
      for (const f of filesOf(it.block)) { const had = files.get(f.path); files.set(f.path, had ? { ...had, add: had.add + f.add, del: had.del + f.del } : f); }
    } else if (it.tool === "file" && it.summary) { const had = files.get(it.summary); if (!had) files.set(it.summary, { path: it.summary, op: "edit", add: 0, del: 0 }); }
    else if (SHELL.has(String(it.toolKind)) || SHELL.has(String(it.tool)) || (it.block && it.block.block === "terminal")) commands++;
  }
  if (!files.size && !commands) return null;
  const parts = [];
  if (files.size) parts.push(count(files.size, "file"));
  if (commands) parts.push(count(commands, "command"));
  const t = took(ms);
  if (t) parts.push(t);
  return { files: [...files.values()], blocks, commands, ms, line: parts.join(", ") };
}
