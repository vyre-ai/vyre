// @ts-check
// The floor plan: memory.graph drawn as rooms (one per project, one for what several share, one
// for what belongs to none), with people, things and threads inside, and each fact as a dot
// on the link it names. Board: DeckMemory.
//
// Laid out once per graph: seeded positions, then a few hundred steps of springs and box
// collision inside each room. Nothing animates, so an idle map costs nothing.

import { initials, plural } from "../js/fmt.js";
import { byRoom } from "./memory-data.js";

const NS = "http://www.w3.org/2000/svg";

/**
 * An SVG element. Strings become text nodes, as with h().
 * @param {string} tag @param {Record<string, any>} [attrs] @param {...any} kids
 * @returns {SVGElement}
 */
export function s(tag, attrs = {}, ...kids) {
  const el = /** @type {SVGElement} */ (document.createElementNS(NS, tag));
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, String(v));
  }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

/** A stable number from a string, for seeded positions. */
function hash(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
  return (x >>> 0) / 4294967296;
}

const measure = (() => {
  const c = document.createElement("canvas").getContext("2d");
  return (text, px = 12, weight = 400) => {
    if (!c) return text.length * px * 0.55;
    c.font = `${weight} ${px}px 'Instrument Sans', 'Helvetica Neue', Arial, sans-serif`;
    return c.measureText(text).width * 1.04;
  };
})();

/** Break text into at most `max` lines no wider than w; the last one ends in an ellipsis if cut. */
function wrap(text, w, max = 2, px = 12, weight = 400) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const next = cur ? cur + " " + words[i] : words[i];
    if (measure(next, px, weight) <= w || !cur) { cur = next; continue; }
    lines.push(cur);
    cur = words[i];
    if (lines.length === max) { cur = ""; lines[max - 1] = clip(lines[max - 1] + " " + words.slice(i).join(" "), w, px, weight); break; }
  }
  if (cur) lines.push(cur);
  return lines.map(l => clip(l, w, px, weight));
}
function clip(text, w, px = 12, weight = 400) {
  if (measure(text, px, weight) <= w) return text;
  let t = text;
  while (t.length > 1 && measure(t + "…", px, weight) > w) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}

/**
 * @typedef {{ id: string, kind: string, label: string, room: string, pinned?: boolean, muted?: boolean, weight?: number }} GNode
 * @typedef {{ id: string, src: string, rel: string, dst: string, confidence: number, learned: number|null, until: number|null }} GEdge
 * @typedef {{
 *   width: number,
 *   selected: string,
 *   today: (edge: GEdge) => boolean,
 *   factText: (edge: GEdge, a: GNode, b: GNode) => string,
 *   onNode: (n: GNode) => void,
 *   onFact: (edge: GEdge) => void,
 *   onThread: (n: GNode) => void,
 * }} Opts
 */

/**
 * The map as one SVG, and the size it was laid out at.
 * @param {{ rooms: any[], nodes: GNode[], edges: GEdge[] }} graph
 * @param {Opts} o
 */
export function floor(graph, o) {
  const W = Math.max(480, o.width || 960);
  const pad = 32, gap = 32;
  const groups = byRoom(graph);
  const rooms = (graph.rooms || []).filter(r => (groups.get(r.id) || []).length || r.kind === "project");
  const cols = W >= 976 && rooms.length > 1 ? 2 : 1;
  const pw = Math.floor((W - pad * 2 - gap * (cols - 1)) / cols);
  const colY = new Array(cols).fill(pad);
  /** @type {Map<string, { x: number, y: number, room: string }>} where each node landed, page coordinates */
  const at = new Map();
  const nodeById = new Map((graph.nodes || []).map(n => [n.id, n]));
  const panels = rooms.map(r => {
    const nodes = groups.get(r.id) || [];
    const ids = new Set(nodes.map(n => n.id));
    const edges = (graph.edges || []).filter(e => ids.has(e.src) && ids.has(e.dst));
    const lay = layout(nodes, edges, pw, o);
    const c = colY.indexOf(Math.min(...colY));
    const panel = { r, lay, x: pad + c * (pw + gap), y: colY[c], w: pw, h: lay.h };
    colY[c] += lay.h + gap;
    for (const n of lay.nodes) at.set(n.id, { x: panel.x + n.x, y: panel.y + n.y, room: r.id });
    return panel;
  });
  const H = Math.max(...colY, pad * 2) - gap + pad;
  // Facts between rooms (a shared person at a project's org): a dashed curve across the gap.
  const across = (graph.edges || []).filter(e => e.rel !== "mentioned_in" && at.has(e.src) && at.has(e.dst) && at.get(e.src)?.room !== at.get(e.dst)?.room);
  const svg = s("svg", { class: "mem-svg", viewBox: `0 0 ${W} ${H}`, role: "group",
    "aria-label": `Memory map: ${rooms.length === 1 ? "one room" : `${rooms.length} rooms`}, with people, things and threads. Each dot is a fact; heavier links were learned today.` },
    panels.map(p => drawPanel(p, o)),
    across.map(e => {
      const a = /** @type {any} */ (at.get(e.src)), b = /** @type {any} */ (at.get(e.dst));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 30;
      const na = nodeById.get(e.src), nb = nodeById.get(e.dst);
      return s("g", { class: "mm-across" },
        s("path", { d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`, class: "mm-edge across" + (o.today(e) ? " today" : "") }),
        factDot(e, (a.x + 2 * mx + b.x) / 4, (a.y + 2 * my + b.y) / 4, na && nb ? o.factText(e, na, nb) : e.id, o));
    }));
  return { svg, W, H };
}

/** A fact on the map: a dot on its link. The ring is Signal when it is the selected fact. */
function factDot(e, x, y, name, o) {
  const on = o.selected === e.id;
  return s("g", { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`, class: "mm-node mm-factdot" + (e.until ? " closed" : ""), tabindex: 0, role: "button",
    "aria-label": `Fact: ${name}`, "data-id": e.id,
    onclick: () => o.onFact(e), onkeydown: (/** @type {KeyboardEvent} */ ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); o.onFact(e); } } },
    s("title", null, name),
    s("circle", { cx: 0, cy: 0, r: 10, class: "mm-hit" }),
    on ? s("circle", { cx: 0, cy: 0, r: 10, class: "mm-ring" }) : null,
    s("circle", { cx: 0, cy: 0, r: 4.5, class: "mm-fact" }));
}

/** One room's nodes and links, placed inside a panel pw wide. */
function layout(nodes, edges, pw, o) {
  const maxLabel = Math.min(200, pw * 0.4);
  const list = nodes.map(n => {
    const m = { ...n, x: 0, y: 0, lines: /** @type {string[]} */ ([]), box: [0, 0, 0, 0] };
    if (n.kind === "person") {
      m.lines = [clip(n.label, maxLabel, 13)];
      const tw = measure(m.lines[0], 13);
      m.box = [-Math.max(22, tw / 2 + 4), -44, Math.max(22, tw / 2 + 4), 22];
    } else if (n.kind === "fact") {
      m.lines = wrap(n.label, maxLabel, 2, 12);
      const tw = Math.max(...m.lines.map(l => measure(l, 12)));
      m.box = [-10, -12, 18 + tw, 10 + (m.lines.length - 1) * 16];
    } else {
      m.lines = [clip(n.label, maxLabel, 12)];
      m.box = [-9, -11, 16 + measure(m.lines[0], 12), 11];
    }
    return m;
  });
  const byId = new Map(list.map(n => [n.id, n]));
  const links = edges.map(e => ({ e, a: byId.get(e.src), b: byId.get(e.dst) })).filter(l => l.a && l.b);
  const top = 48, pad = 16;
  const ph = !list.length ? 96 : Math.round(Math.min(720, Math.max(220, 110 + list.length * 26)));
  for (const n of list) {
    n.x = pad + 40 + hash(n.id) * Math.max(40, pw - 2 * pad - 240);
    n.y = top + 40 + hash(n.id + "y") * Math.max(10, ph - top - 90);
  }
  const clamp = n => {
    n.x = Math.min(pw - pad - n.box[2], Math.max(pad - n.box[0], n.x));
    n.y = Math.min(ph - pad - n.box[3], Math.max(top - n.box[1], n.y));
  };
  const cx = pw / 2 - 60, cy = (top + ph) / 2;
  const L = Math.max(100, Math.min(170, Math.sqrt((pw * (ph - top)) / Math.max(1, list.length)) * 0.8));
  const steps = list.length > 90 ? 160 : 320;
  for (let it = 0; it < steps; it++) {
    const cool = 1 - it / (steps * 1.1);
    for (const { a, b } of links) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const k = (d - L) * 0.03 * cool;
      a.x += dx / d * k; a.y += dy / d * k; b.x -= dx / d * k; b.y -= dy / d * k;
    }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      // Boxes overlap: push apart along the shorter overlap.
      const ox = Math.min(a.x + a.box[2], b.x + b.box[2]) - Math.max(a.x + a.box[0], b.x + b.box[0]);
      const oy = Math.min(a.y + a.box[3], b.y + b.box[3]) - Math.max(a.y + a.box[1], b.y + b.box[1]);
      if (ox > -8 && oy > -8) {
        if (ox + 8 < oy + 8) { const m = (ox + 8) / 2 * (a.x <= b.x ? -1 : 1); a.x += m; b.x -= m; }
        else { const m = (oy + 8) / 2 * (a.y <= b.y ? -1 : 1); a.y += m; b.y -= m; }
      } else {
        const dx = b.x - a.x, dy = b.y - a.y, d2 = Math.max(400, dx * dx + dy * dy), d = Math.sqrt(d2);
        const f = 9000 / d2 * cool;
        a.x -= dx / d * f; a.y -= dy / d * f; b.x += dx / d * f; b.y += dy / d * f;
      }
    }
    for (const n of list) { n.x += (cx - n.x) * 0.0015; n.y += (cy - n.y) * 0.0015; clamp(n); }
  }
  return { nodes: list, links, h: ph };
}

function drawPanel(p, o) {
  const { r, lay } = p;
  const lines = lay.links.map(({ e, a, b }) => s("line", { x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1),
    class: "mm-edge" + (e.rel === "mentioned_in" ? " thread" : "") + (o.today(e) ? " today" : "") + (e.until ? " closed" : "") }));
  const facts = lay.links.filter(({ e }) => e.rel !== "mentioned_in").map(({ e, a, b }) => {
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
    return factDot(e, x, y, o.factText(e, a, b), o);
  });
  const nodes = lay.nodes.map(n => drawNode(n, o));
  const count = r.facts !== undefined ? plural(r.facts, "fact") : plural(lay.nodes.length, "thing");
  return s("g", { transform: `translate(${p.x} ${p.y})`, class: "mm-room-g", "data-room": r.id },
    s("rect", { x: 0.5, y: 0.5, width: p.w - 1, height: p.h - 1, class: "mm-room" + (r.kind === "project" ? "" : " quiet") }),
    s("text", { x: 16, y: 26, class: "mm-room-name" }, String(r.label || "").toUpperCase()),
    s("text", { x: p.w - 16, y: 26, "text-anchor": "end", class: "mm-room-count" }, count),
    !lay.nodes.length ? s("text", { x: 16, y: 66, class: "mm-thing-text" }, "Nothing learned here yet.") : null,
    lines, facts, nodes);
}

function drawNode(n, o) {
  const text = (x, y, cls, anchor = "start") => n.lines.map((l, i) => s("text", { x, y: y + i * 16, class: cls, "text-anchor": anchor }, l));
  const on = o.selected === n.id;
  let shape, label, act, name;
  if (n.kind === "fact") {
    shape = [on ? s("circle", { cx: 0, cy: 0, r: 12, class: "mm-ring" }) : null, s("circle", { cx: 0, cy: 0, r: 6, class: "mm-fact" })];
    label = text(18, 4, "mm-fact-text" + (on ? " on" : ""));
    act = () => o.onNode(n);
    name = `Fact: ${n.label}`;
  } else if (n.kind === "person") {
    shape = [on ? s("circle", { cx: 0, cy: 0, r: 23, class: "mm-ring" }) : null, s("circle", { cx: 0, cy: 0, r: 18, class: "mm-person" + (n.pinned ? " pinned" : "") }),
      s("text", { x: 0, y: 4, class: "mm-initials", "text-anchor": "middle" }, initials(n.label) || "?")];
    label = text(0, -28, "mm-person-text", "middle");
    act = () => o.onNode(n);
    name = `Person: ${n.label}${n.pinned ? ", pinned" : ""}${n.muted ? ", muted" : ""}`;
  } else {
    shape = [on ? s("rect", { x: -9, y: -9, width: 18, height: 18, class: "mm-ring" }) : null,
      s("rect", { x: -5, y: -5, width: 10, height: 10, class: "mm-thing" + (n.kind === "thread" ? " thread" : "") })];
    label = text(14, 4, "mm-thing-text");
    if (n.kind === "thread") { act = () => o.onThread(n); name = `Thread: ${n.label}`; }
    else { act = () => o.onNode(n); name = `${n.label}${n.pinned ? ", pinned" : ""}${n.muted ? ", muted" : ""}`; }
  }
  return s("g", { transform: `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`, class: "mm-node" + (n.muted ? " muted" : ""), tabindex: 0,
    role: n.kind === "thread" ? "link" : "button", "aria-label": name, "data-id": n.id,
    onclick: act, onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } } },
    s("rect", { x: n.box[0], y: n.box[1], width: n.box[2] - n.box[0], height: n.box[3] - n.box[1], class: "mm-hit" }),
    shape, label);
}

/** The small drawings in the legend. */
export function legendMark(kind) {
  const g = kind === "today" ? s("line", { x1: 0, y1: 7, x2: 22, y2: 7, class: "mm-edge today" })
    : kind === "earlier" ? s("line", { x1: 0, y1: 7, x2: 22, y2: 7, class: "mm-edge" })
    : kind === "fact" ? s("circle", { cx: 11, cy: 7, r: 4.5, class: "mm-fact" })
    : kind === "person" ? s("circle", { cx: 11, cy: 7, r: 6, class: "mm-person" })
    : s("rect", { x: 6, y: 2, width: 10, height: 10, class: "mm-thing" });
  return s("svg", { width: 22, height: 14, viewBox: "0 0 22 14" }, g);
}
