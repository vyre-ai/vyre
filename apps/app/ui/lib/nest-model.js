// @ts-check
// The nesting of the @ and # pickers: a tree of categories, objects and items that the keyboard walks. Pure: no DOM, no React.
// A node is { key, label, sub?, pick?, kids? }. `kids` (even an empty list) makes it a branch you can open; `pick` is what choosing it writes
// into the words ({ pick: "Clients (all)", urn?, kind? }). A branch with a `pick` can be chosen whole or opened; a branch without one only opens.
// The path is the list of keys from the top to the open branch. Typing at the top searches every level at once.

/** @typedef {{ pick: string, urn?: string, kind?: string }} Pick */
/** @typedef {{ key: string, label: string, sub?: string, sealed?: number, family?: string, pick?: Pick, kids?: NestNode[] }} NestNode */
/** @typedef {{ key: string, label: string, sub?: string, sealed?: number, family?: string, pick?: Pick, drill: boolean, trail: string[], group?: string, path?: string }} NestRow */

const tierOf = (/** @type {string} */ label, /** @type {string} */ q) => { const l = label.toLowerCase(); return !q || l.startsWith(q) ? 0 : l.includes(q) ? 1 : 2; };

/** @param {NestNode} n @param {string[]} trail @returns {NestRow} */
function rowOf(n, trail) {
  const { kids, ...rest } = n;
  return { ...rest, key: trail.join("/"), drill: Array.isArray(kids), trail };
}

/** The branch the path ends in, or null for the top; `ok` is false when a key on the path is gone (the caller falls back to the top). @param {readonly NestNode[]} root @param {readonly string[]} path */
function walk(root, path) {
  /** @type {readonly NestNode[]} */ let level = root;
  /** @type {NestNode[]} */ const chain = [];
  for (const k of path) {
    const n = level.find((x) => x.key === k);
    if (!n || !Array.isArray(n.kids)) return { level: root, chain: [], ok: false };
    chain.push(n);
    level = n.kids;
  }
  return { level, chain, ok: true };
}

/**
 * The rows the picker shows: the open level (filtered by the query, best matches first), or, at the top with a query, every matching item and object across all categories, grouped by category and each with its path.
 * @param {readonly NestNode[]} root @param {readonly string[]} path @param {string} query @param {number} [cap]
 * @returns {NestRow[]}
 */
export function nestRows(root, path, query, cap = 50) {
  const q = String(query ?? "").trim().toLowerCase();
  const { level, chain, ok } = walk(root, path);
  const here = ok ? path : [];
  if (chain.length || !q) {
    const rows = level.map((n, i) => ({ r: rowOf(n, [...here, n.key]), i, t: tierOf(n.label, q) })).filter((x) => x.t < 2);
    rows.sort((a, b) => a.t - b.t || a.i - b.i);
    return rows.slice(0, cap).map((x) => x.r);
  }
  /** @type {{ r: NestRow, g: number, t: number, i: number }[]} */ const hits = [];
  let i = 0;
  root.forEach((top, g) => {
    /** @param {NestNode} n @param {string[]} trail @param {string[]} above */
    const visit = (n, trail, above) => {
      const t = tierOf(n.label, q);
      if (t < 2) hits.push({ r: { ...rowOf(n, trail), group: top.label, path: [...above, n.label].join(" › ") }, g, t, i: i++ });
      for (const k of n.kids ?? []) visit(k, [...trail, k.key], [...above, n.label]);
    };
    for (const k of top.kids ?? []) visit(k, [top.key, k.key], []);
  });
  hits.sort((a, b) => a.g - b.g || a.t - b.t || a.i - b.i);
  return hits.slice(0, cap).map((h) => h.r);
}

/** The labels from the top to the open branch (a gone key ends the trail). @param {readonly NestNode[]} root @param {readonly string[]} path */
export function crumbsOf(root, path) {
  /** @type {string[]} */ const out = [];
  /** @type {readonly NestNode[]} */ let level = root;
  for (const k of path) {
    const n = level.find((x) => x.key === k);
    if (!n) break;
    out.push(n.label);
    level = n.kids ?? [];
  }
  return out;
}

/**
 * What a key does in an open nested picker: "next" | "prev" | "pick" | "drill" | "back" | "close", or null (the key goes on to the box).
 * Right or Tab opens the active row when it has a level inside; Tab picks a row that has none. Enter picks, or opens a row that has nothing to pick.
 * Left, and Backspace on an empty query, go up one level (at the top, Backspace closes). Esc closes.
 * @param {{ key: string, shiftKey?: boolean, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean }} e
 * @param {{ query: string, count: number, depth: number, row?: { drill: boolean, pick?: unknown } }} s
 * @returns {"next" | "prev" | "pick" | "drill" | "back" | "close" | null}
 */
export function nestKey(e, { query, count, depth, row }) {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Escape") return "close";
  if (e.key === "Backspace") return query !== "" ? null : depth > 0 ? "back" : "close";
  if (e.key === "ArrowLeft") return query === "" && depth > 0 ? "back" : null;
  if (!count || !row) return null;
  if (e.key === "ArrowDown") return "next";
  if (e.key === "ArrowUp") return "prev";
  if (e.key === "ArrowRight") return row.drill ? "drill" : null;
  if (e.key === "Tab" && !e.shiftKey) return row.drill ? "drill" : row.pick ? "pick" : null;
  if (e.key === "Enter" && !e.shiftKey) return row.pick ? "pick" : row.drill ? "drill" : null;
  return null;
}

/** The path after a key: "drill" goes to the row's own trail, "back" up one. @param {readonly string[]} path @param {"drill" | "back"} act @param {{ trail: readonly string[] }} [row] @returns {string[]} */
export function nestStep(path, act, row) {
  if (act === "back") return path.slice(0, -1);
  return row ? [...row.trail] : [...path];
}

/** The footer line for the active row: only the keys that do something here. @param {number} depth @param {{ drill: boolean, pick?: unknown } | undefined} row */
export function nestHint(depth, row) {
  const parts = [];
  if (row?.drill) parts.push("→ open");
  if (depth > 0) parts.push("← back");
  if (row?.pick) parts.push("⏎ pick");
  if (depth === 0) parts.push(row ? "type to search" : "type to search · Esc");
  return parts.join(" · ");
}
