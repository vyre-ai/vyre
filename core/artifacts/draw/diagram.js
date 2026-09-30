// @ts-check
// A diagram artifact, drawn by Vyre in the design system (no Mermaid themes, no click handlers, no
// links). Mermaid flowcharts (graph and flowchart) and sequence diagrams are parsed and laid out
// here; any other Mermaid type, or a line the parser can't read, is an error block with the
// parser's line and the source. SVG artifacts are cleaned (svg.js) and shown as an image. Static:
// zoom and the Source toggle are radio and checkbox inputs, no script runs.

import { esc } from "../render.js";
import { cleanSvg, removedSentence } from "./svg.js";

/** @param {string} title @param {string} body */
const state = (title, body) => `<div class="state" role="status"><b>${esc(title)}</b><span>${body}</span></div>`;

class MermaidError extends Error {
  /** @param {number} line @param {string} msg */
  constructor(line, msg) { super(msg); this.line = line; }
}

// ---- flowchart ----------------------------------------------------------------------------------

const SHAPES = /** @type {[string, string, string][]} */ ([
  ["((", "))", "circle"], ["([", "])", "stadium"], ["[[", "]]", "rect"], ["{{", "}}", "rect"], ["[(", ")]", "rect"],
  ["[", "]", "rect"], ["(", ")", "round"], ["{", "}", "diamond"], [">", "]", "rect"],
]);
const ID = /^[A-Za-z0-9_À-￿]+/;
/** @param {string} t */ const cleanLabel = t => t.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/<br\s*\/?>/gi, "\n").replace(/&quot;/g, '"').replace(/<[^>]+>/g, "").trim();

/**
 * One node reference at the start of s: { id, label?, shape?, rest }.
 * @param {string} s @param {number} line
 */
function readNode(s, line) {
  const m = ID.exec(s);
  if (!m) throw new MermaidError(line, `expected a node name, found "${s.slice(0, 12)}"`);
  const id = m[0];
  let rest = s.slice(id.length);
  for (const [open, close, shape] of SHAPES) {
    if (!rest.startsWith(open)) continue;
    const body = rest.slice(open.length);
    let end = -1;
    if (body.startsWith('"')) { const q = body.indexOf('"', 1); end = q < 0 ? -1 : body.indexOf(close, q + 1); }
    else end = body.indexOf(close);
    if (end < 0) throw new MermaidError(line, `expected ${close} to close ${id}${open}`);
    return { id, label: cleanLabel(body.slice(0, end)), shape, rest: body.slice(end + close.length) };
  }
  return { id, label: undefined, shape: undefined, rest };
}

const EDGE_TEXT = /^\s*(<?)(--|==|-\.)\s+([^|>=]*?[^\s|>=-])\s+(-->|---|==>|===|\.->|-\.-|--x|--o)(?![\w-])/;
const EDGE_PLAIN = /^\s*(<?)(-{2,}>?|={2,}>?|-\.+-?>?|--x|--o)(?:\s*\|([^|]*)\|)?/;

/** @param {string} op */
function edgeStyle(op) { return { dashed: op.includes("."), thick: op.includes("="), arrow: op.endsWith(">") || op.endsWith("x") || op.endsWith("o") }; }

/**
 * @param {string} text
 * @returns {{ dir: string, nodes: Map<string, any>, edges: any[], groups: any[] }}
 */
export function parseFlow(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let dir = "TD", seenHead = false;
  /** @type {Map<string, any>} */ const nodes = new Map();
  /** @type {any[]} */ const edges = [], groups = [], stack = [];
  const touch = (/** @type {any} */ n) => {
    let cur = nodes.get(n.id);
    if (!cur) { cur = { id: n.id, label: n.label ?? n.id, shape: n.shape || "rect" }; nodes.set(n.id, cur); }
    else if (n.label !== undefined) { cur.label = n.label; cur.shape = n.shape || cur.shape; }
    for (const g of stack) g.members.add(n.id);
    return cur;
  };
  for (let li = 0; li < lines.length; li++) {
    const no = li + 1;
    for (let stmt of lines[li].replace(/%%.*$/, "").split(";")) {
      stmt = stmt.trim();
      if (!stmt) continue;
      if (!seenHead) {
        const h = /^(?:graph|flowchart)(?:\s+(TD|TB|BT|LR|RL))?\s*$/i.exec(stmt);
        if (!h) throw new MermaidError(no, "the diagram must start with graph or flowchart and a direction, such as flowchart TD");
        dir = (h[1] || "TD").toUpperCase(); if (dir === "TB") dir = "TD"; seenHead = true; continue;
      }
      if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(stmt)) continue;
      const sg = /^subgraph\s+(.*)$/.exec(stmt);
      if (sg) {
        const raw = sg[1].trim(), b = /^([A-Za-z0-9_]+)\s*\[(.*)\]$/.exec(raw);
        const g = { id: b ? b[1] : raw.replace(/\W+/g, "_"), title: cleanLabel(b ? b[2] : raw), members: new Set() };
        groups.push(g); stack.push(g); continue;
      }
      if (/^end$/.test(stmt)) { if (!stack.length) throw new MermaidError(no, "end without a subgraph"); stack.pop(); continue; }
      // node (& node)* (edge node (& node)*)*
      let rest = stmt, prev = /** @type {any[]|null} */ (null), pendingEdge = /** @type {any} */ (null), lastName = "";
      for (;;) {
        /** @type {any[]} */ const group = [];
        for (;;) {
          const n = readNode(rest.trim(), no); rest = n.rest; lastName = n.id; group.push(touch(n));
          const amp = /^\s*&\s*/.exec(rest);
          if (!amp) break;
          rest = rest.slice(amp[0].length);
        }
        if (prev && pendingEdge) for (const a of prev) for (const b of group) edges.push({ from: a.id, to: b.id, ...pendingEdge });
        rest = rest.trim();
        if (!rest) break;
        let em = EDGE_TEXT.exec(rest), label = "", op = "";
        if (em) { op = em[4]; label = em[3]; if (em[1]) op = "<" + op; rest = rest.slice(em[0].length); }
        else if ((em = EDGE_PLAIN.exec(rest))) { op = em[2]; label = em[3] || ""; rest = rest.slice(em[0].length); if (em[1]) op = "<" + op; }
        else throw new MermaidError(no, `expected an arrow after ${lastName}`);
        const st = edgeStyle(op);
        pendingEdge = { label: cleanLabel(label), ...st, both: op.startsWith("<") };
        prev = group;
        rest = rest.trim();
        if (!rest) throw new MermaidError(no, `expected a node after the arrow from ${lastName}`);
      }
    }
  }
  if (!seenHead) throw new MermaidError(1, "the diagram is empty");
  if (stack.length) throw new MermaidError(lines.length, "a subgraph is missing its end");
  return { dir, nodes, edges, groups };
}

const CH = 6.9;
/** @param {any} n */
function sizeOf(n) {
  const ls = String(n.label).split("\n"), w = Math.max(...ls.map(l => l.length)) * CH + 28, h = 34 + (ls.length - 1) * 15;
  if (n.shape === "diamond") return { w: Math.max(84, w * 1.45), h: Math.max(54, h * 1.6), lines: ls };
  if (n.shape === "circle") { const d = Math.max(56, w * 0.9, h + 14); return { w: d, h: d, lines: ls }; }
  return { w: Math.max(64, w), h, lines: ls };
}

/** @param {ReturnType<typeof parseFlow>} g */
function layoutFlow(g) {
  const ids = [...g.nodes.keys()], idx = new Map(ids.map((id, i) => [id, i]));
  const horiz = g.dir === "LR" || g.dir === "RL", rev = g.dir === "BT" || g.dir === "RL";
  const size = new Map(ids.map(id => [id, sizeOf(g.nodes.get(id))]));
  // Break cycles: an edge to a node on the current DFS path is a back edge and is drawn as a loop.
  const out = new Map(ids.map(id => [id, /** @type {string[]} */ ([])]));
  for (const e of g.edges) out.get(e.from)?.push(e.to);
  const state = new Map(), back = new Set();
  const dfs = (/** @type {string} */ u) => { state.set(u, 1); for (const v of out.get(u) || []) { if (state.get(v) === 1) back.add(u + ">" + v); else if (!state.get(v)) dfs(v); } state.set(u, 2); };
  for (const id of ids) if (!state.get(id)) dfs(id);
  const fwd = g.edges.filter(e => !back.has(e.from + ">" + e.to) && e.from !== e.to);
  const rank = new Map(ids.map(id => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) { let ch = false; for (const e of fwd) if ((rank.get(e.to) || 0) < (rank.get(e.from) || 0) + 1) { rank.set(e.to, (rank.get(e.from) || 0) + 1); ch = true; } if (!ch) break; }
  const nl = Math.max(0, ...rank.values()) + 1;
  /** @type {string[][]} */ const layers = Array.from({ length: nl }, () => []);
  for (const id of ids) layers[rank.get(id) || 0].push(id);
  const pos = new Map();
  const place = () => layers.forEach(l => l.forEach((id, i) => pos.set(id, i)));
  place();
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    for (let k = down ? 1 : nl - 2; down ? k < nl : k >= 0; k += down ? 1 : -1) {
      const nb = (/** @type {string} */ id) => fwd.filter(e => (down ? e.to === id : e.from === id)).map(e => pos.get(down ? e.from : e.to));
      layers[k].sort((a, b) => { const na = nb(a), nbb = nb(b); const ba = na.length ? na.reduce((x, y) => x + y, 0) / na.length : pos.get(a), bb = nbb.length ? nbb.reduce((x, y) => x + y, 0) / nbb.length : pos.get(b); return ba - bb || idx.get(a) - idx.get(b); });
      layers[k].forEach((id, i) => pos.set(id, i));
    }
  }
  const GAP = 30, LGAP = 58;
  const cross = (/** @type {string} */ id) => { const s = size.get(id); return horiz ? s.h : s.w; };
  const along = (/** @type {string} */ id) => { const s = size.get(id); return horiz ? s.w : s.h; };
  const widths = layers.map(l => l.reduce((a, id) => a + cross(id), 0) + GAP * Math.max(0, l.length - 1));
  const maxW = Math.max(0, ...widths);
  const thick = layers.map(l => Math.max(0, ...l.map(along)));
  /** @type {Map<string, {x:number,y:number,w:number,h:number}>} */ const box = new Map();
  let offset = 0;
  const order = rev ? [...layers.keys()].reverse() : [...layers.keys()];
  for (const k of order) {
    let c = (maxW - widths[k]) / 2;
    for (const id of layers[k]) {
      const s = size.get(id), a = offset + (thick[k] - along(id)) / 2;
      box.set(id, horiz ? { x: a, y: c, w: s.w, h: s.h } : { x: c, y: a, w: s.w, h: s.h });
      c += cross(id) + GAP;
    }
    offset += thick[k] + LGAP;
  }
  return { box, back, horiz, rev, size };
}

/** Where a line from node a's centre toward (tx, ty) leaves a's outline. @param {{x:number,y:number,w:number,h:number}} b @param {string} shape @param {number} tx @param {number} ty */
function edgePoint(b, shape, tx, ty) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  if (shape === "diamond" || shape === "circle") {
    const k = shape === "circle" ? 1 / Math.hypot(dx / (b.w / 2), dy / (b.h / 2)) : 1 / (Math.abs(dx) / (b.w / 2) + Math.abs(dy) / (b.h / 2));
    return [cx + dx * k, cy + dy * k];
  }
  const k = Math.min(Math.abs(dx) > 0 ? b.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? b.h / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * k, cy + dy * k];
}

/** @param {number[]} p0 @param {number[]} p1 */
function arrowHead(p0, p1) {
  const a = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), l = 8, sp = 0.5;
  const f = (/** @type {number} */ d) => `${(p1[0] - l * Math.cos(a + d)).toFixed(1)} ${(p1[1] - l * Math.sin(a + d)).toFixed(1)}`;
  return `<path class="dah" d="M${f(-sp)}L${p1[0].toFixed(1)} ${p1[1].toFixed(1)}L${f(sp)}"/>`;
}

/** @param {ReturnType<typeof parseFlow>} g */
function svgFlow(g) {
  if (!g.nodes.size) throw new MermaidError(1, "the diagram has no nodes");
  const { box, back, horiz } = layoutFlow(g);
  const M = 18;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (/** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ x1, /** @type {number} */ y1) => { minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1); };
  for (const b of box.values()) grow(b.x, b.y, b.x + b.w, b.y + b.h);
  const body = [];
  // subgraphs behind everything, each around its members (and any nested subgraph's)
  for (const grp of g.groups) {
    const ms = [...grp.members].map(id => box.get(id)).filter(Boolean);
    if (!ms.length) continue;
    const x0 = Math.min(...ms.map(b => b.x)) - 14, y0 = Math.min(...ms.map(b => b.y)) - 30, x1 = Math.max(...ms.map(b => b.x + b.w)) + 14, y1 = Math.max(...ms.map(b => b.y + b.h)) + 14;
    grow(x0, y0, x1, y1);
    body.push(`<rect class="dg" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="10"/><text class="dgt" x="${x0 + 10}" y="${y0 + 16}">${esc(grp.title)}</text>`);
  }
  const labels = [];
  for (const e of g.edges) {
    const a = box.get(e.from), b = box.get(e.to);
    if (!a || !b) continue;
    const an = g.nodes.get(e.from), bn = g.nodes.get(e.to);
    const isBack = back.has(e.from + ">" + e.to), self = e.from === e.to;
    const extra = `${e.dashed ? ' stroke-dasharray="5 4"' : ""}`, ecls = e.thick ? "de thick" : "de";
    let d, tail, tip, mid;
    if (self || isBack) {
      const side = 38;
      const ca = [a.x + a.w / 2, a.y + a.h / 2], cb = [b.x + b.w / 2, b.y + b.h / 2];
      const s = horiz ? [a.x + a.w / 2, a.y + a.h] : [a.x + a.w, a.y + a.h / 2];
      const t = horiz ? [b.x + b.w / 2, b.y + b.h] : [b.x + b.w, b.y + b.h / 2];
      const c1 = horiz ? [s[0], s[1] + side] : [s[0] + side, s[1]], c2 = horiz ? [t[0], t[1] + side] : [t[0] + side, t[1]];
      d = `M${s[0]} ${s[1]}C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${t[0]} ${t[1]}`; tail = c2; tip = t;
      mid = [(s[0] + 3 * c1[0] + 3 * c2[0] + t[0]) / 8, (s[1] + 3 * c1[1] + 3 * c2[1] + t[1]) / 8];
      void ca; void cb;
      grow(Math.min(c1[0], c2[0]) - 2, Math.min(c1[1], c2[1]) - 2, Math.max(c1[0], c2[0]) + 2, Math.max(c1[1], c2[1]) + 2);
    } else {
      const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2];
      const s = edgePoint(a, an.shape, bc[0], bc[1]), t = edgePoint(b, bn.shape, ac[0], ac[1]);
      const k = 0.5, c1 = horiz ? [s[0] + (t[0] - s[0]) * k, s[1]] : [s[0], s[1] + (t[1] - s[1]) * k], c2 = horiz ? [t[0] - (t[0] - s[0]) * k, t[1]] : [t[0], t[1] - (t[1] - s[1]) * k];
      d = `M${s[0].toFixed(1)} ${s[1].toFixed(1)}C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${t[0].toFixed(1)} ${t[1].toFixed(1)}`; tail = c2; tip = t;
      mid = [(s[0] + 3 * c1[0] + 3 * c2[0] + t[0]) / 8, (s[1] + 3 * c1[1] + 3 * c2[1] + t[1]) / 8];
    }
    body.push(`<path class="${ecls}"${extra} d="${d}"/>`);
    if (e.arrow) body.push(arrowHead(tail, tip));
    if (e.label) { labels.push(`<text class="dl" x="${(mid[0] + 10).toFixed(1)}" y="${(mid[1] - 2).toFixed(1)}">${esc(e.label.replace(/\n/g, " "))}</text>`); grow(mid[0], mid[1] - 16, mid[0] + 10 + e.label.length * 6, mid[1] + 4); }
  }
  for (const [id, b] of box) {
    const n = g.nodes.get(id), lines = sizeOf(n).lines, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (n.shape === "diamond") body.push(`<path class="dn dec" d="M${cx} ${b.y}L${b.x + b.w} ${cy}L${cx} ${b.y + b.h}L${b.x} ${cy}Z"/>`);
    else if (n.shape === "circle") body.push(`<ellipse class="dn" cx="${cx}" cy="${cy}" rx="${b.w / 2}" ry="${b.h / 2}"/>`);
    else body.push(`<rect class="dn" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${n.shape === "stadium" ? b.h / 2 : 9}"/>`);
    body.push(`<text class="dt" text-anchor="middle" x="${cx}" y="${cy - (lines.length - 1) * 7.5 + 4}">${lines.map((l, i) => `<tspan x="${cx}" dy="${i ? 15 : 0}">${esc(l)}</tspan>`).join("")}</text>`);
  }
  body.push(...labels);
  const w = Math.ceil(maxX - minX + M * 2), h = Math.ceil(maxY - minY + M * 2);
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - M} ${minY - M} ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Diagram">${body.join("")}</svg>`, width: w };
}

// ---- sequence diagram -------------------------------------------------------------------------

/** @param {string} text */
export function parseSeq(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  /** @type {Map<string,string>} */ const parts = new Map();
  /** @type {any[]} */ const items = [];
  let head = false;
  const part = (/** @type {string} */ id) => { if (!parts.has(id)) parts.set(id, id); return id; };
  for (let i = 0; i < lines.length; i++) {
    const no = i + 1, l = lines[i].replace(/%%.*$/, "").trim();
    if (!l) continue;
    if (!head) { if (!/^sequenceDiagram\s*$/i.test(l)) throw new MermaidError(no, "expected sequenceDiagram"); head = true; continue; }
    let m;
    if ((m = /^(?:participant|actor)\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/.exec(l))) { parts.set(m[1], cleanLabel(m[2] || m[1])); continue; }
    if (/^(autonumber|activate|deactivate|title|loop|alt|else|opt|par|and|end|rect|critical|break)\b/i.test(l)) continue;
    if ((m = /^Note\s+(?:over|left of|right of)\s+([A-Za-z0-9_]+)(?:\s*,\s*([A-Za-z0-9_]+))?\s*:\s*(.*)$/i.exec(l))) { items.push({ note: cleanLabel(m[3]), a: part(m[1]), b: m[2] ? part(m[2]) : null }); continue; }
    if ((m = /^([A-Za-z0-9_]+)\s*(--?>>|--?>|--?x|--?\))\s*[+-]?([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(l))) { items.push({ from: part(m[1]), to: part(m[3]), dashed: m[2].startsWith("--"), open: !m[2].includes(">>"), text: cleanLabel(m[4]) }); continue; }
    throw new MermaidError(no, `expected a message such as A->>B: text, found "${l.slice(0, 24)}"`);
  }
  if (!head) throw new MermaidError(1, "the diagram is empty");
  return { parts, items };
}

/** @param {ReturnType<typeof parseSeq>} s */
function svgSeq(s) {
  const ids = [...s.parts.keys()];
  if (!ids.length) throw new MermaidError(1, "the diagram has no participants");
  const COL = 150, X0 = 70, TOP = 14, HD = 32;
  const xs = new Map(ids.map((id, i) => [id, X0 + i * COL]));
  let y = TOP + HD + 26;
  const body = [];
  const rows = [];
  for (const it of s.items) {
    if (it.note !== undefined) {
      const xa = /** @type {number} */ (xs.get(it.a)), xb = it.b ? /** @type {number} */ (xs.get(it.b)) : xa, w = Math.max(Math.abs(xb - xa) + 80, it.note.length * 6.6 + 20), x = Math.min(xa, xb) - (w - Math.abs(xb - xa)) / 2;
      rows.push(`<rect class="dn" x="${x}" y="${y - 12}" width="${w}" height="26" rx="6"/><text class="dt" style="font-weight:400" text-anchor="middle" x="${x + w / 2}" y="${y + 5}">${esc(it.note)}</text>`);
      y += 40; continue;
    }
    const xa = /** @type {number} */ (xs.get(it.from)), xb = /** @type {number} */ (xs.get(it.to));
    const dash = it.dashed ? ' stroke-dasharray="5 4"' : "";
    if (xa === xb) {
      rows.push(`<path class="de"${dash} d="M${xa} ${y}h28v18h-28"/>${arrowHead([xa + 28, y + 18], [xa, y + 18])}<text class="dl" x="${xa + 34}" y="${y + 10}">${esc(it.text)}</text>`);
      y += 44;
    } else {
      rows.push(`<path class="de"${dash} d="M${xa} ${y}H${xb}"/>${arrowHead([xa, y], [xb, y])}<text class="dl" text-anchor="middle" x="${(xa + xb) / 2}" y="${y - 6}">${esc(it.text)}</text>`);
      y += 34;
    }
  }
  const bottom = y + 6;
  for (const id of ids) {
    const x = /** @type {number} */ (xs.get(id)), label = /** @type {string} */ (s.parts.get(id)), w = Math.max(84, label.length * 7 + 24);
    body.push(`<line class="seqlife" x1="${x}" x2="${x}" y1="${TOP + HD}" y2="${bottom}"/>`);
    body.push(`<rect class="dn" x="${x - w / 2}" y="${TOP}" width="${w}" height="${HD}" rx="9"/><text class="dt" text-anchor="middle" x="${x}" y="${TOP + 20}">${esc(label)}</text>`);
  }
  body.push(...rows);
  const w = X0 * 2 + (ids.length - 1) * COL, h = bottom + 18;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Sequence diagram">${body.join("")}</svg>`, width: w };
}

// ---- the page body ------------------------------------------------------------------------------

/** @param {string} src @param {{ svg: string, width: number }} d */
function figure(src, d) {
  return `<input class="z" type="radio" name="zoom" id="z-fit" checked><input class="z" type="radio" name="zoom" id="z-100"><input class="z" type="radio" name="zoom" id="z-150"><input class="z" type="radio" name="zoom" id="z-200"><input class="z" type="checkbox" id="src">
<div class="ctl"><label for="z-fit">Fit</label><label for="z-100">100%</label><label for="z-150">150%</label><label for="z-200">200%</label><label for="src">Source</label><span style="flex-basis:100%">Drawn by Vyre. Scroll to pan.</span></div>
<div class="fig" style="--w:${d.width}px">${d.svg}</div>
<div class="srcpane"><pre class="src">${esc(src)}</pre></div>`;
}

/**
 * Mermaid source to the page body.
 * @param {string} title @param {string} src
 */
export function drawMermaid(title, src) {
  const head = `<h1>${esc(title)}</h1>`;
  if (!src.trim()) return head + state("Nothing to draw yet", "The diagram source is empty.");
  try {
    const first = (src.replace(/%%.*$/gm, "").split("\n").map(l => l.trim()).find(Boolean) || "").split(/\s+/)[0].toLowerCase();
    if (first === "sequencediagram") return head + figure(src, svgSeq(parseSeq(src)));
    if (first === "graph" || first === "flowchart") return head + figure(src, svgFlow(parseFlow(src)));
    throw new MermaidError(1, `Vyre draws flowcharts and sequence diagrams, and this is ${first ? `a ${esc(first)}` : "something else"}`);
  } catch (e) {
    if (!(e instanceof MermaidError)) throw e;
    return head + state("Cannot draw this diagram", `Line ${e.line}: ${e.message.startsWith("Vyre draws") ? e.message : esc(e.message)}. The source is below so you can see it.`) + `<pre class="src">${esc(src)}</pre>`;
  }
}

/**
 * An SVG artifact cleaned and shown as an image.
 * @param {string} title @param {string} src
 */
export function drawSvg(title, src) {
  const head = `<h1>${esc(title)}</h1>`;
  if (!src.trim()) return head + state("Nothing to draw yet", "The SVG is empty.");
  const { svg, removed } = cleanSvg(src);
  if (!svg) return head + state("Cannot draw this SVG", "It has no drawing Vyre can show after cleaning. The source is below.") + `<pre class="src">${esc(src)}</pre>`;
  const said = removedSentence(removed);
  const width = Number(/^<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/.exec(svg)?.[1]) || 600;
  return head + (said ? `<div class="note"><b>Cleaned.</b> ${esc(said)}</div>` : "") +
    `<div class="fig"><img alt="${esc(title)}" src="data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}" style="max-width:min(100%,${width}px)"></div>`;
}
