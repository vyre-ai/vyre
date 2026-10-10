// @ts-check
// The Flow canvas geometry, pure. The kernel gives each node a lane (x) and a row (y); the sizes are multiples of one unit (the space token the
// screen passes in), so a denser or looser space redraws the graph with no number of its own here.

/** @param {number} unit one space step (the s-12 token, in px) */
export function metrics(unit) {
  return { w: unit * 5.5, h: unit * 1.75, gx: unit * 0.5, gy: unit * 0.5 };
}

/** @typedef {{ id: string, lane: number, y: number }} Pos */

/** Each node with its top-left corner. @template {Pos} T @param {T[]} nodes @param {ReturnType<typeof metrics>} m */
export const place = (nodes, m) => nodes.map((n) => ({ ...n, left: n.lane * (m.w + m.gx), top: n.y * (m.h + m.gy) }));

/** The size of the whole drawing. @param {Pos[]} nodes @param {ReturnType<typeof metrics>} m */
export function extent(nodes, m) {
  const lanes = nodes.reduce((a, n) => Math.max(a, n.lane + 1), 1);
  const rows = nodes.reduce((a, n) => Math.max(a, n.y + 1), 1);
  return { width: lanes * m.w + (lanes - 1) * m.gx, height: rows * m.h + (rows - 1) * m.gy };
}

/** A curve from the bottom middle of one node to the top middle of the next. @param {{ left: number, top: number }} a @param {{ left: number, top: number }} b @param {ReturnType<typeof metrics>} m */
export function edgePath(a, b, m) {
  const x1 = a.left + m.w / 2, y1 = a.top + m.h, x2 = b.left + m.w / 2, y2 = b.top;
  const k = Math.max(m.gy, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`;
}

/** What to call the way into a node, when it is not simply the next step. @param {string} kind */
export const edgeWords = (kind) => (kind === "then" ? "If yes" : kind === "else" ? "Otherwise" : kind === "each" ? "For each one" : kind === "lane" ? "At the same time" : "");

/** The order a phone lists the steps: the kernel's row (`order` when the layout moved the step). @template {{ y: number, order?: number }} T @param {T[]} nodes */
export const listOrder = (nodes) => nodes.slice().sort((a, b) => (a.order ?? a.y) - (b.order ?? b.y));

/**
 * Lay a parallel out the way it is read: its lanes side by side, each starting on the row after the parallel, and a join under the longest lane that waits for all of them ("Both are done, then
 * carry on"), which the step after the parallel hangs from. The kernel numbers every step on its own row, so two lanes are stacked one under the other; this puts them level. Each lane keeps its
 * own columns, so a lane with a decide inside it does not run into the next lane. Pure: it returns new nodes (lane, y, order) and edges; the join is a node of kind "join" with edges from the end of
 * every lane (kind "join") and one on to the step after (kind "next"); the parallel's own edge to that step is dropped, so it does not look as if the lanes do not matter. `order` is the row the kernel
 * gave (the join sits just after its last lane), for the phone's list.
 * @template {{ id: string, kind?: string, lane: number, y: number, label?: string }} N @template {{ from: string, to: string, kind: string }} E @param {N[]} nodes @param {E[]} edges
 * @returns {{ nodes: (N & { order: number })[], edges: { from: string, to: string, kind: string }[], joins: string[] }}
 */
export function arrange(nodes, edges) {
  /** @type {any[]} */ let ns = nodes.map((n) => ({ ...n, order: n.y }));
  /** @type {{ from: string, to: string, kind: string }[]} */ let es = edges.map((e) => ({ ...e }));
  /** @type {string[]} */ const joins = [];
  for (const p of ns.filter((n) => n.kind === "parallel").sort((a, b) => a.y - b.y)) {
    const me = ns.find((n) => n.id === p.id);
    const heads = es.filter((e) => e.from === p.id && e.kind === "lane").map((e) => ns.find((n) => n.id === e.to)).filter((n) => !!n).sort((a, b) => a.order - b.order);
    if (!me || heads.length < 2) continue;
    const sorted = ns.slice().sort((a, b) => a.order - b.order);
    const after = sorted.find((n) => n.order > heads[0].order && n.lane <= me.lane);
    const end = after ? after.order : Infinity;
    const group = sorted.filter((n) => n.order > me.order && n.lane > me.lane && n.order < end);
    const segs = heads.map((h, j) => group.filter((n) => n.order >= h.order && (!heads[j + 1] || n.order < heads[j + 1].order)));
    const longest = Math.max(...segs.map((x) => x.length));
    const top = heads[0].y;
    let base = heads[0].lane;
    /** @type {Map<string, { lane: number, y: number }>} */ const moved = new Map();
    segs.forEach((seg, j) => {
      const h = heads[j];
      const width = seg.reduce((a, n) => Math.max(a, n.lane - h.lane + 1), 1);
      for (const n of seg) moved.set(n.id, { lane: n.lane - h.lane + base, y: top + (n.y - h.y) });
      base += width;
    });
    const onward = es.find((e) => e.from === p.id && e.kind === "next");
    // rows: the lanes end at top + longest - 1; a join, when something follows, takes the next row and the rest moves up by what the stacking wasted, down by the join's own row
    const shift = (after ? -(group.length - longest) + 1 : 0);
    ns = ns.map((n) => { const m = moved.get(n.id); if (m) return { ...n, ...m }; return after && n.order >= end ? { ...n, y: n.y + shift } : n; });
    if (!after || !onward) continue;
    const id = `${p.id}:join`;
    ns.push({ id, kind: "join", label: `All ${heads.length} are done, then carry on`, lane: me.lane, y: top + longest, order: segs[segs.length - 1][segs[segs.length - 1].length - 1].order + 0.5 });
    es = es.filter((e) => e !== onward);
    for (const seg of segs) { const tail = seg[seg.length - 1]; if (tail) es.push({ from: tail.id, to: id, kind: "join" }); }
    es.push({ from: id, to: onward.to, kind: "next" });
    joins.push(id);
  }
  return { nodes: ns, edges: es, joins };
}

/** The height a step needs for its words: padding, the way in, up to two lines of label, who does it and its flags. Pure and cheap, so rows can be as tall as their tallest step and no taller. @param {{ kind?: string, label?: string, who?: string, state?: string, outward?: boolean, sealed?: boolean, code?: boolean }} n @param {boolean} words @param {number} w */
export function nodeHeight(n, words, w) {
  if (n.kind === "join") return 40;
  const per = Math.max(10, Math.floor((w - 72) / 6.8));
  const lines = Math.min(2, Math.max(1, Math.ceil(String(n.label || "").length / per)));
  const flags = (n.state && n.state !== "pending") || n.outward || n.sealed || n.code;
  return 20 + (words ? 16 : 0) + lines * 17 + (n.who ? 16 : 0) + (flags ? 30 : 0);
}

/**
 * The drawing, every number in one place: each step with its box, and each edge as a path that runs down, across the gap between two rows and down again, so it never crosses a card (corners are
 * rounded). Rows are as tall as their tallest step. A step's way in is its first edge kind, for the words above its label.
 * @template {{ id: string, kind?: string, lane: number, y: number, label?: string, who?: string, state?: string }} N @param {N[]} nodes @param {{ from: string, to: string, kind: string }[]} edges @param {ReturnType<typeof metrics>} m @param {(kind: string) => string} wordsOf
 */
export function build(nodes, edges, m, wordsOf = edgeWords) {
  const into = new Map(edges.map((e) => [e.to, e.kind]));
  const rows = [...new Set(nodes.map((n) => n.y))].sort((a, b) => a - b);
  /** @type {Map<number, { top: number, bottom: number }>} */ const band = new Map();
  let top = 0;
  for (const y of rows) {
    const h = Math.max(...nodes.filter((n) => n.y === y).map((n) => nodeHeight(n, !!wordsOf(into.get(n.id) || "next"), m.w)));
    band.set(y, { top, bottom: top + h });
    top += h + m.gy;
  }
  const placed = nodes.map((n) => { const b = /** @type {{ top: number, bottom: number }} */ (band.get(n.y)); const h = nodeHeight(n, !!wordsOf(into.get(n.id) || "next"), m.w); return { ...n, left: n.lane * (m.w + m.gx), top: n.kind === "join" ? b.top + (b.bottom - b.top - h) / 2 : b.top, w: m.w, h, row: b }; });
  const at = new Map(placed.map((p) => [p.id, p]));
  const lanes = nodes.reduce((a, n) => Math.max(a, n.lane + 1), 1);
  const paths = edges.flatMap((e) => { const a = at.get(e.from), b = at.get(e.to); return a && b ? [{ ...e, d: route(a, b, m) }] : []; });
  return { nodes: placed, edges: paths, width: lanes * m.w + (lanes - 1) * m.gx, height: Math.max(0, top - m.gy) };
}

/** An edge from the bottom middle of one step to the top middle of the next: straight down in a column, else down to the gap above the target's row, across, and down, with rounded corners. @param {{ left: number, top: number, w: number, h: number, row: { top: number, bottom: number } }} a @param {{ left: number, top: number, w: number, h: number, row: { top: number, bottom: number } }} b @param {{ gy: number }} m */
export function route(a, b, m) {
  const x1 = a.left + a.w / 2, y1 = a.top + a.h, x2 = b.left + b.w / 2, y2 = b.top;
  if (Math.abs(x1 - x2) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const yg = Math.max(y1 + 1, Math.min(y2 - 1, b.row.top - m.gy / 2));
  const r = Math.min(10, Math.abs(x2 - x1) / 2, Math.max(0, (yg - y1) ), Math.max(0, y2 - yg));
  const dir = x2 > x1 ? 1 : -1;
  return `M ${x1} ${y1} L ${x1} ${yg - r} Q ${x1} ${yg} ${x1 + dir * r} ${yg} L ${x2 - dir * r} ${yg} Q ${x2} ${yg} ${x2} ${yg + r} L ${x2} ${y2}`;
}
