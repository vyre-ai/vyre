// @ts-check
// The Flow canvas geometry, pure. The kernel gives each node a lane (x) and a row (y); the sizes are multiples of one unit (the space token the
// screen passes in), so a denser or looser space redraws the graph with no number of its own here.

/** @param {number} unit one space step (the s-12 token, in px) */
export function metrics(unit) {
  return { w: unit * 6, h: unit * 2.25, gx: unit * 0.5, gy: unit * 0.5 };
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
export const edgeWords = (kind) => (kind === "then" ? "If yes" : kind === "else" ? "Otherwise" : kind === "each" ? "For each one" : kind === "lane" ? "At the same time" : kind === "join" ? "When all are done" : "");

/** The order a phone lists the steps: top to bottom, which is the row. @template {{ y: number }} T @param {T[]} nodes */
export const listOrder = (nodes) => nodes.slice().sort((a, b) => a.y - b.y);

/**
 * Lay a parallel out the way it is read: its lanes side by side, each starting on the row after the parallel, and the step that follows below the longest lane, drawn as the join that waits for all of
 * them. The kernel numbers every step on its own row, so two lanes are stacked one under the other; this puts them level. Each lane keeps its own columns, so a lane that has a decide inside it does
 * not run into the next lane. Pure: it returns new nodes (lane, y) and the edges with the join edges added (kind "join"); `order` is the row the kernel gave, for the phone's list.
 * @template {{ id: string, kind?: string, lane: number, y: number }} N @template {{ from: string, to: string, kind: string }} E @param {N[]} nodes @param {E[]} edges
 * @returns {{ nodes: (N & { order: number })[], edges: (E | { from: string, to: string, kind: "join" })[], joins: string[] }}
 */
export function arrange(nodes, edges) {
  let ns = nodes.map((n) => ({ ...n, order: n.y }));
  /** @type {{ from: string, to: string, kind: string }[]} */ const extra = [];
  /** @type {string[]} */ const joins = [];
  for (const p of ns.filter((n) => n.kind === "parallel").sort((a, b) => a.y - b.y)) {
    const me = ns.find((n) => n.id === p.id);
    if (!me) continue;
    const heads = edges.filter((e) => e.from === p.id && e.kind === "lane").map((e) => ns.find((n) => n.id === e.to)).filter((n) => !!n).sort((a, b) => /** @type {any} */ (a).order - /** @type {any} */ (b).order);
    if (heads.length < 2) continue;
    const sorted = ns.slice().sort((a, b) => a.order - b.order);
    const last = sorted.filter((n) => n.order > me.order && n.lane > me.lane);
    const end = (() => { const after = sorted.find((n) => n.order > /** @type {any} */ (heads[0]).order && n.lane <= me.lane); return after ? after.order : Infinity; })();
    const group = last.filter((n) => n.order < end);
    const segs = heads.map((h, j) => { const hi = /** @type {any} */ (h), next = /** @type {any} */ (heads[j + 1]); return group.filter((n) => n.order >= hi.order && (!next || n.order < next.order)); });
    const longest = Math.max(...segs.map((s) => s.length));
    const saved = group.length - longest;
    const top = /** @type {any} */ (heads[0]).y;
    let base = /** @type {any} */ (heads[0]).lane;
    /** @type {Map<string, { lane: number, y: number }>} */ const moved = new Map();
    segs.forEach((seg, j) => {
      const h = /** @type {any} */ (heads[j]);
      const width = seg.reduce((a, n) => Math.max(a, n.lane - h.lane + 1), 1);
      for (const n of seg) moved.set(n.id, { lane: n.lane - h.lane + base, y: top + (n.y - h.y) });
      base += width;
    });
    const join = sorted.find((n) => n.order > (group.length ? group[group.length - 1].order : me.order) && n.lane <= me.lane);
    ns = ns.map((n) => { const m = moved.get(n.id); if (m) return { ...n, ...m }; return n.order >= end && saved > 0 ? { ...n, y: n.y - saved } : n; });
    if (join) {
      joins.push(join.id);
      for (const seg of segs) { const tail = seg[seg.length - 1]; if (tail) extra.push({ from: tail.id, to: join.id, kind: "join" }); }
    }
  }
  return { nodes: ns, edges: [...edges, .../** @type {any} */ (extra)], joins };
}
