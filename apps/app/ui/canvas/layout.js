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
export const edgeWords = (kind) => (kind === "then" ? "If yes" : kind === "else" ? "Otherwise" : kind === "each" ? "For each one" : kind === "lane" ? "At the same time" : "");

/** The order a phone lists the steps: top to bottom, which is the row. @template {{ y: number }} T @param {T[]} nodes */
export const listOrder = (nodes) => nodes.slice().sort((a, b) => a.y - b.y);
