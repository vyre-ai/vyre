// @ts-check
// Memory: what the curator has learned, as a map (one room per project) or a list, and one fact
// or thing at a time in the side panel with its sources. Board: DeckMemory.
//
// Everything here came from memory, so Recall gold marks the facts. Signal marks only focus
// (the selected node's ring). Tools: memory.facts, memory.why, memory.stats, memory.pin,
// memory.mute, projects.list, projects.catalog (to link a source turn to its project).
//
// Address: /memory?about=<fact id or node id>&project=<slug>&view=list

import { h, put, link, go, empty } from "../js/dom.js";
import { attempt, call } from "../js/api.js";
import { icon } from "../js/icons.js";
import { when, clock, startOfToday, plural, initials } from "../js/fmt.js";

const NS = "http://www.w3.org/2000/svg";
const EVERYWHERE = "*everywhere";
const phone = () => window.matchMedia("(max-width: 760px)").matches;

/**
 * An SVG element. Strings become text nodes, as with h().
 * @param {string} tag @param {Record<string, any>} [attrs] @param {...any} kids
 * @returns {SVGElement}
 */
function s(tag, attrs = {}, ...kids) {
  const el = /** @type {SVGElement} */ (document.createElementNS(NS, tag));
  for (const [k, v] of Object.entries(attrs)) {
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

const learnedAt = f => f.since || f.seen || 0;
const seenAt = f => f.seen || f.since || 0;
const isToday = f => seenAt(f) >= startOfToday();
const pct = c => `${Math.round(Number(c || 0) * 100)}%`;
function dateTime(t) {
  if (!t) return "";
  const d = new Date(t);
  const day = d.toDateString() === new Date().toDateString() ? "Today" : `${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })}`;
  return `${day}, ${clock(t)}`;
}

/** @param {any} ctx */
export default async function memory(ctx) {
  const q = ctx.query;
  const st = {
    mode: q.get("view") === "list" ? "list" : "map",
    today: false,
    project: q.get("project") || "",
    about: q.get("about") || "",
    from: "", // the panel a fact was opened from
    newest: true,
    scale: 1,
  };
  /** @type {{ projects: any[], groups: any[], byId: Map<string, any>, sessionProject: Map<string, string>, stats: any, error: any }} */
  const data = { projects: [], groups: [], byId: new Map(), sessionProject: new Map(), stats: null, error: null };

  // ---- skeleton ------------------------------------------------------------------------------
  const seg = h("div", { class: "seg", role: "group", "aria-label": "View" },
    ["map", "list"].map(m => h("button", { type: "button", "data-mode": m, "aria-pressed": String(st.mode === m),
      onclick: () => { st.mode = /** @type {any} */ (m); remember(); drawBody(); drawSeg(); } }, m === "map" ? "Map" : "List")));
  const drawSeg = () => seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === st.mode)));
  const todayChip = h("button", { type: "button", class: "mem-today", "aria-pressed": "false",
    onclick: () => { st.today = !st.today; todayChip.setAttribute("aria-pressed", String(st.today)); drawBody(); drawCounts(); } },
    h("span", { class: "dot recall", "aria-hidden": "true" }), "Learned today");
  const select = /** @type {HTMLSelectElement} */ (h("select", { class: "mem-select", "aria-label": "Project",
    onchange: () => { st.project = select.value; remember(); drawBody(); drawCounts(); } }));
  const projectPick = h("label", { class: "mem-pick" }, select, icon("chevron", 14));
  const counts = h("span", { class: "small faint mem-counts" });
  const body = h("div", { class: "mem-body" });
  const foot = h("div", { class: "mem-foot" });
  const side = h("aside", { class: "mem-side", "aria-label": "Selected fact", hidden: true });

  put(ctx.root, h("div", { class: "mem" },
    h("div", { class: "mem-main" },
      h("div", { class: "mem-head" },
        h("h1", { class: "mem-title" }, "Memory"), seg, todayChip, projectPick, h("div", { class: "mem-grow" }), counts),
      body, foot),
    side));

  function remember() {
    const u = new URLSearchParams();
    if (st.about) u.set("about", st.about);
    if (st.project) u.set("project", st.project);
    if (st.mode === "list") u.set("view", "list");
    const qs = u.toString();
    history.replaceState(null, "", "/memory" + (qs ? "?" + qs : ""));
  }

  // ---- data ----------------------------------------------------------------------------------
  async function load(first = false) {
    const [pl, stats, cat, all] = await Promise.all([attempt("projects.list"), attempt("memory.stats"),
      attempt("projects.catalog", { limit: 500 }), attempt("memory.facts", { limit: 200 })]);
    if (!ctx.alive()) return;
    data.error = all.error || null;
    data.stats = stats.data || null;
    data.projects = pl.data?.projects || [];
    data.sessionProject = new Map((cat.data?.sessions || []).filter(x => x.projects?.length).map(x => [x.id, x.projects[0]]));
    const per = await Promise.all(data.projects.map(p => attempt("memory.facts", { project_cwds: cwdsOf(p), limit: 200 })));
    if (!ctx.alive()) return;
    const groups = data.projects.map((p, i) => ({ key: p.slug, name: p.name, scope: p.home || cwdsOf(p)[0] || "*", facts: per[i].data?.facts || [] }));
    const inSome = new Set(groups.flatMap(g => g.facts.map(f => f.id)));
    const loose = (all.data?.facts || []).filter(f => !inSome.has(f.id));
    if (loose.length) groups.push({ key: EVERYWHERE, name: "Everywhere", scope: "*", facts: loose });
    data.groups = groups;
    data.byId = new Map();
    for (const g of groups) for (const f of g.facts) {
      const e = data.byId.get(f.id) || { fact: f, groups: [] };
      e.groups.push(g.key);
      data.byId.set(f.id, e);
    }
    put(select,
      h("option", { value: "" }, "All projects"),
      data.projects.map(p => h("option", { value: p.slug }, p.name)),
      loose.length ? h("option", { value: EVERYWHERE }, "Everywhere") : null);
    if (st.project && ![...select.options].some(o => o.value === st.project)) st.project = "";
    select.value = st.project;
    drawCounts();
    if (first && st.about) openAbout(st.about, false);
    drawBody();
  }
  const cwdsOf = p => (p.workspaces?.length ? p.workspaces : p.home ? [p.home] : []);
  const groupOf = key => data.groups.find(g => g.key === key);
  const projectName = key => (key === EVERYWHERE ? "Everywhere" : groupOf(key)?.name || "");

  /** Groups and facts after the project filter and the Learned today toggle. */
  function visible() {
    return data.groups.filter(g => !st.project || g.key === st.project)
      .map(g => ({ ...g, facts: g.facts.filter(f => !st.today || isToday(f)) }));
  }

  function drawCounts() {
    const facts = data.stats?.facts ?? data.byId.size;
    const n = data.projects.length;
    put(counts, data.error ? "" : `${plural(facts, "fact")} · ${plural(n, "project")}`);
  }

  // ---- body: map or list ---------------------------------------------------------------------
  function drawBody() {
    const list = st.mode === "list" || phone();
    body.classList.toggle("is-list", list);
    if (data.error) { put(body, h("div", { class: "mem-pad" }, empty("Memory is not available.", data.error))); put(foot); return; }
    const groups = visible();
    const n = groups.reduce((a, g) => a + g.facts.length, 0);
    if (!n) { put(body, h("div", { class: "mem-pad" }, emptyNote())); put(foot); return; }
    if (list) { drawList(groups); put(foot); } else drawMap(groups);
  }

  function emptyNote() {
    const total = data.stats?.facts || data.byId.size;
    if (st.today && data.byId.size) {
      const newest = Math.max(...[...data.byId.values()].map(e => seenAt(e.fact)));
      const where = st.project ? ` in ${projectName(st.project)}` : "";
      return h("div", { class: "empty mem-empty" },
        h("p", null, `Nothing learned today${where}. Memory holds ${plural(total, "fact")}, the newest from ${when(newest)}.`),
        h("button", { type: "button", class: "btn btn-ghost mem-show-all", onclick: () => todayChip.click() }, "Show all facts"));
    }
    if (st.project) return h("div", { class: "empty" }, `Memory holds nothing about ${projectName(st.project)} yet.`);
    return h("div", { class: "empty" }, "Memory holds no facts yet. It learns from your threads as they are indexed.");
  }

  // List
  function drawList(groups) {
    const rows = [];
    const seen = new Set();
    for (const g of groups) for (const f of g.facts) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      rows.push({ f, key: g.key });
    }
    rows.sort((a, b) => (st.newest ? 1 : -1) * (seenAt(b.f) - seenAt(a.f)) || a.f.text.localeCompare(b.f.text));
    const sortBtn = h("button", { type: "button", class: "mem-sort lbl", "aria-label": st.newest ? "Sorted newest first. Sort oldest first" : "Sorted oldest first. Sort newest first",
      onclick: () => { st.newest = !st.newest; drawBody(); } }, "Age ", st.newest ? "↓" : "↑");
    put(body, h("div", { class: "mem-pad" },
      h("div", { class: "mem-list", role: "table", "aria-label": "Facts" },
        h("div", { class: "mem-lrow mem-lhead", role: "row" },
          h("span", { role: "columnheader", class: "lbl mem-c-text" }, "Fact"),
          h("span", { role: "columnheader", class: "lbl mem-c-src" }, "Source"),
          h("span", { role: "columnheader", class: "lbl mem-c-proj" }, "Project"),
          h("span", { role: "columnheader", class: "mem-c-age", "aria-sort": st.newest ? "descending" : "ascending" }, sortBtn),
          h("span", { role: "columnheader", class: "lbl mem-c-conf" }, "Conf.")),
        rows.map(({ f, key }) => listRow(f, key)))));
  }
  function listRow(f, key) {
    const open = () => openFact(f.id, key);
    const src = sourceLink(f);
    const e = data.byId.get(f.id);
    const proj = (e?.groups || [key]).filter(k => k !== EVERYWHERE).map(projectName).join(", ") || "Everywhere";
    return h("div", { class: "mem-lrow" + (st.about === f.id ? " on" : ""), role: "row", onclick: (/** @type {MouseEvent} */ ev) => {
      if (!(/** @type {Element} */ (ev.target)).closest("a,button")) open();
    } },
      h("span", { role: "cell", class: "mem-c-text" },
        h("span", { class: "dot recall", "aria-hidden": "true" }),
        h("button", { type: "button", class: "mem-ltext", onclick: open }, f.text)),
      h("span", { role: "cell", class: "mem-c-src small" }, src || h("span", { class: "faint" }, "Unknown")),
      h("span", { role: "cell", class: "mem-c-proj small muted ellipsis" }, proj),
      h("span", { role: "cell", class: "mem-c-age code" }, f.age || when(seenAt(f))),
      h("span", { role: "cell", class: "mem-c-conf code" }, pct(f.confidence)));
  }
  function threadHref(session) {
    const p = data.sessionProject.get(session);
    return p ? `/projects/${encodeURIComponent(p)}/${encodeURIComponent(session)}` : `/threads/${encodeURIComponent(session)}`;
  }
  function sourceLink(f) {
    if (f.ref?.session) return link(threadHref(f.ref.session), { class: "link quiet ellipsis mem-src" }, f.ref.name || f.source || "A thread");
    if (f.taught?.length) return h("span", { class: "muted" }, `Taught by ${f.taught[0].module}`);
    return null;
  }

  // Map
  let mapState = null;
  function drawMap(groups) {
    const W = Math.max(480, body.clientWidth || 960);
    const pad = 32, gap = 32;
    const cols = W >= 976 && groups.length > 1 ? 2 : 1;
    const pw = Math.floor((W - pad * 2 - gap * (cols - 1)) / cols);
    const colY = new Array(cols).fill(pad);
    const panels = groups.filter(g => g.facts.length).map(g => {
      const graph = layout(g, pw);
      const c = colY.indexOf(Math.min(...colY));
      const panel = { g, graph, x: pad + c * (pw + gap), y: colY[c], w: pw, h: graph.h };
      colY[c] += graph.h + gap;
      return panel;
    });
    const H = Math.max(...colY) - gap + pad;
    const svg = s("svg", { class: "mem-svg", viewBox: `0 0 ${W} ${H}`, role: "group",
      "aria-label": `Memory map: ${panels.length === 1 ? "one project" : `${panels.length} projects`} drawn as rooms, with people, things, threads and facts. Gold links were learned today.` },
      panels.map(drawPanel));
    const scroller = h("div", { class: "mem-scroll" }, svg);
    mapState = { W, H, svg, scroller };
    put(body, scroller);
    applyScale();
    const zoom = f => { st.scale = Math.min(2.5, Math.max(0.3, st.scale * f)); applyScale(); };
    put(foot,
      h("div", { class: "mem-legend", "aria-hidden": "true" },
        legend("line recall", "Learned today"), legend("line", "Earlier"), legend("fact", "Fact"), legend("person", "Person"), legend("thing", "Thing or thread")),
      h("div", { class: "mem-zoom", role: "group", "aria-label": "Zoom" },
        h("button", { type: "button", class: "ibtn", "aria-label": "Zoom in", onclick: () => zoom(1.25) }, icon("plus", 14)),
        h("button", { type: "button", class: "ibtn", "aria-label": "Zoom out", onclick: () => zoom(0.8) }, icon("minus", 14)),
        h("button", { type: "button", class: "btn btn-ghost", onclick: fit }, "Fit")));
  }
  function applyScale() {
    if (!mapState) return;
    mapState.svg.setAttribute("width", String(Math.round(mapState.W * st.scale)));
    mapState.svg.setAttribute("height", String(Math.round(mapState.H * st.scale)));
  }
  function fit() {
    if (!mapState) return;
    const r = mapState.scroller.getBoundingClientRect();
    st.scale = Math.max(0.3, Math.min(1, (r.width - 2) / mapState.W, (r.height - 2) / mapState.H));
    applyScale();
  }
  function legend(kind, text) {
    const g = kind === "line recall" ? s("line", { x1: 0, y1: 7, x2: 22, y2: 7, class: "mm-edge today" })
      : kind === "line" ? s("line", { x1: 0, y1: 7, x2: 22, y2: 7, class: "mm-edge" })
      : kind === "fact" ? s("circle", { cx: 11, cy: 7, r: 5, class: "mm-fact" })
      : kind === "person" ? s("circle", { cx: 11, cy: 7, r: 6, class: "mm-person" })
      : s("rect", { x: 6, y: 2, width: 10, height: 10, class: "mm-thing" });
    return h("span", { class: "mem-leg" }, s("svg", { width: 22, height: 14, viewBox: "0 0 22 14" }, g), h("span", null, text));
  }

  /**
   * Nodes and links for one project's room, laid out once: seeded positions, a few hundred steps
   * of springs and box collision, all inside the panel.
   */
  function layout(g, pw) {
    /** @type {Map<string, any>} */
    const nodes = new Map();
    const edges = [];
    const maxLabel = Math.min(210, pw * 0.42);
    const add = (id, kind, label, extra = {}) => {
      if (nodes.has(id)) return nodes.get(id);
      const n = { id, kind, label: String(label || id), ...extra };
      if (kind === "person") {
        n.lines = [clip(n.label, maxLabel, 13)];
        const tw = measure(n.lines[0], 13);
        n.box = [-Math.max(22, tw / 2 + 4), -44, Math.max(22, tw / 2 + 4), 22];
      } else if (kind === "fact") {
        n.lines = wrap(n.label, maxLabel, 2, 12, n.selected ? 500 : 400);
        const tw = Math.max(...n.lines.map(l => measure(l, 12, 500)));
        n.box = [-10, -12, 18 + tw, 10 + (n.lines.length - 1) * 16];
      } else {
        n.lines = [clip(n.label, maxLabel, 12)];
        n.box = [-9, -11, 16 + measure(n.lines[0], 12), 11];
      }
      nodes.set(id, n);
      return n;
    };
    const entity = o => add(o.id, o.kind === "person" ? "person" : o.kind === "session" ? "thread" : "thing", o.label,
      o.kind === "session" ? { session: String(o.id).replace(/^session:/, "") } : {});
    for (const f of g.facts) {
      const fn = add("f:" + f.id, "fact", f.text, { fact: f, today: isToday(f), selected: st.about === f.id });
      const ends = [entity(f.subject), entity(f.object)];
      if (f.ref?.session && ("session:" + f.ref.session) !== f.object.id) ends.push(add("session:" + f.ref.session, "thread", f.ref.name || f.source, { session: f.ref.session }));
      for (const e of ends) edges.push({ a: fn, b: e, today: isToday(f) });
    }
    const list = [...nodes.values()];
    const ph = Math.round(Math.min(640, Math.max(300, 110 + list.length * 30)));
    const top = 48, pad = 16;
    for (const n of list) {
      n.x = pad + 40 + hash(n.id) * Math.max(40, pw - 2 * pad - 260);
      n.y = top + 40 + hash(n.id + "y") * (ph - top - 90);
    }
    const clamp = n => {
      n.x = Math.min(pw - pad - n.box[2], Math.max(pad - n.box[0], n.x));
      n.y = Math.min(ph - pad - n.box[3], Math.max(top - n.box[1], n.y));
    };
    const cx = pw / 2 - 60, cy = (top + ph) / 2;
    const L = Math.max(110, Math.min(170, Math.sqrt((pw * (ph - top)) / Math.max(1, list.length)) * 0.8));
    for (let it = 0; it < 360; it++) {
      const cool = 1 - it / 400;
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1;
        const k = (d - L) * 0.03 * cool;
        e.a.x += dx / d * k; e.a.y += dy / d * k; e.b.x -= dx / d * k; e.b.y -= dy / d * k;
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
    return { nodes: list, edges, h: ph };
  }

  function drawPanel(p) {
    const { g, graph } = p;
    const edges = graph.edges.map(e => s("line", { x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y, class: "mm-edge" + (e.today ? " today" : "") }));
    const nodes = graph.nodes.map(n => drawNode(n, g.key));
    return s("g", { transform: `translate(${p.x} ${p.y})` },
      s("rect", { x: 0.5, y: 0.5, width: p.w - 1, height: p.h - 1, class: "mm-room" }),
      s("text", { x: 16, y: 26, class: "mm-room-name" }, g.name.toUpperCase()),
      s("text", { x: p.w - 16, y: 26, "text-anchor": "end", class: "mm-room-count" }, plural(g.facts.length, "fact")),
      edges, nodes);
  }

  function drawNode(n, key) {
    const text = (x, y, cls, anchor = "start") => n.lines.map((l, i) => s("text", { x, y: y + i * 16, class: cls, "text-anchor": anchor }, l));
    let shape, label, act, name;
    if (n.kind === "fact") {
      const on = st.about === n.fact.id;
      shape = [on ? s("circle", { cx: 0, cy: 0, r: 12, class: "mm-ring" }) : null, s("circle", { cx: 0, cy: 0, r: 6, class: "mm-fact" })];
      label = text(18, 4, "mm-fact-text" + (on ? " on" : ""));
      act = () => openFact(n.fact.id, key);
      name = `Fact: ${n.fact.text}`;
    } else if (n.kind === "person") {
      const on = st.about === n.id;
      shape = [on ? s("circle", { cx: 0, cy: 0, r: 23, class: "mm-ring" }) : null, s("circle", { cx: 0, cy: 0, r: 18, class: "mm-person" }),
        s("text", { x: 0, y: 4, class: "mm-initials", "text-anchor": "middle" }, initials(n.label) || "?")];
      label = text(0, -28, "mm-person-text", "middle");
      act = () => openThing(n.id, key);
      name = `Person: ${n.label}`;
    } else {
      const on = st.about === n.id;
      shape = [on ? s("rect", { x: -9, y: -9, width: 18, height: 18, class: "mm-ring" }) : null, s("rect", { x: -5, y: -5, width: 10, height: 10, class: "mm-thing" })];
      label = text(14, 4, "mm-thing-text");
      if (n.kind === "thread") { act = () => go(threadHref(n.session)); name = `Thread: ${n.label}`; }
      else { act = () => openThing(n.id, key); name = `${n.label}`; }
    }
    return s("g", { transform: `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`, class: "mm-node", tabindex: 0,
      role: n.kind === "thread" ? "link" : "button", "aria-label": name,
      onclick: act, onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } } },
      s("rect", { x: n.box[0], y: n.box[1], width: n.box[2] - n.box[0], height: n.box[3] - n.box[1], class: "mm-hit" }),
      shape, label);
  }

  // ---- detail panel --------------------------------------------------------------------------
  let sideSeq = 0;
  function close() {
    st.about = "";
    side.hidden = true;
    put(side);
    remember();
    drawBody();
  }
  function openAbout(id, redraw = true) {
    if (data.byId.has(id) || id.split("|").length === 3) openFact(id, "", redraw);
    else openThing(id, "", redraw);
  }
  function openFact(id, key, redraw = true) {
    st.about = id;
    st.from = key || "";
    remember();
    drawFact(id);
    if (redraw) drawBody();
  }
  function openThing(id, key, redraw = true) {
    st.about = id;
    st.from = key || "";
    remember();
    if (side.hidden) { side.hidden = false; put(side, h("div", { class: "small faint" }, "Reading memory…")); }
    drawThing(id);
    if (redraw) drawBody();
  }
  /** The project this selection is shown in: the filter, the room it was opened from, or its first. */
  function contextKey(id) {
    const e = data.byId.get(id);
    if (st.project && (!e || e.groups.includes(st.project))) return st.project;
    if (st.from) return st.from;
    if (!e) return data.groups.find(g => g.key !== EVERYWHERE && g.facts.some(f => f.subject?.id === id || f.object?.id === id))?.key || "";
    const bySession = data.sessionProject.get(e?.fact?.ref?.session);
    return e?.groups.find(k => k !== EVERYWHERE) || e?.groups[0] || (bySession && groupOf(bySession) ? bySession : "");
  }
  const scopeOf = key => (key && key !== EVERYWHERE ? groupOf(key)?.scope || "*" : "*");

  function shell(labelText, heading) {
    const back = h("button", { type: "button", class: "mem-back", onclick: close }, h("span", { class: "mem-back-i" }, icon("right", 14)), "Memory");
    side.hidden = false;
    const main = h("div", { class: "mem-side-main" });
    put(side,
      h("div", { class: "mem-phone-top" }, back),
      h("div", { class: "mem-side-top" },
        h("span", { class: "lbl recall mem-side-lbl" }, h("span", { class: "dot recall", "aria-hidden": "true" }), labelText),
        h("button", { type: "button", class: "ibtn mem-close", "aria-label": "Close panel", onclick: close }, icon("close", 13))),
      h("h2", { class: "mem-side-h" }, heading),
      main);
    if (phone()) back.focus();
    return main;
  }

  function row(dt, dd) { return h("div", { class: "mem-dl-row" }, h("dt", null, dt), h("dd", null, dd)); }

  /** Pin and Mute for one node, in one scope, with their state read back from memory.facts. */
  function steering(node, nodeLabel, key, status) {
    const scope = scopeOf(key);
    const pin = h("button", { type: "button", class: "btn", "aria-pressed": "false", disabled: true }, icon("pin", 14), "Pin");
    const mute = h("button", { type: "button", class: "btn", "aria-pressed": "false", disabled: true }, icon("mute", 14), "Mute");
    let state = { pinned: false, muted: false };
    const read = async () => {
      const r = await attempt("memory.facts", { about: node, project_cwds: scope === "*" ? [] : [scope], limit: 1 });
      if (r.error) { put(status, r.error.missing ? `The ${r.error.module} module is not running, so pins cannot be changed.` : String(r.error.message)); return; }
      state = { pinned: !!r.data?.about?.pinned, muted: !!r.data?.about?.muted };
      pin.setAttribute("aria-pressed", String(state.pinned));
      mute.setAttribute("aria-pressed", String(state.muted));
      put(pin, icon("pin", 14), state.pinned ? "Pinned" : "Pin");
      put(mute, icon("mute", 14), state.muted ? "Muted" : "Mute");
      /** @type {HTMLButtonElement} */ (pin).disabled = !r.data?.about;
      /** @type {HTMLButtonElement} */ (mute).disabled = !r.data?.about;
    };
    const flip = async (tool, on) => {
      /** @type {HTMLButtonElement} */ (pin).disabled = /** @type {HTMLButtonElement} */ (mute).disabled = true;
      try {
        if (on) await call(tool, { node, scope });
        else { await call(tool, { node, scope, off: true }); if (scope !== "*") await call(tool, { node, scope: "*", off: true }); }
        const where = scope === "*" ? "everywhere" : `in ${projectName(key)}`;
        put(status, tool === "memory.pin" ? (on ? `Pinned ${nodeLabel} ${where}.` : `Unpinned ${nodeLabel}.`) : (on ? `Muted ${nodeLabel} ${where}.` : `Unmuted ${nodeLabel}.`));
      } catch (e) { put(status, String(/** @type {any} */ (e).message)); }
      await read();
    };
    pin.addEventListener("click", () => flip("memory.pin", !state.pinned));
    mute.addEventListener("click", () => flip("memory.mute", !state.muted));
    read();
    return [pin, mute];
  }

  /** SOURCES: the turns behind a fact or a thing, each as a quoted recalled block. */
  function sources(id, into, onCount) {
    const n = ++sideSeq;
    put(into, h("div", { class: "small faint mem-loading" }, "Reading the sources…"));
    attempt("memory.why", { fact: id, limit: 10 }).then(r => {
      if (n !== sideSeq || !ctx.alive()) return;
      if (r.error) { put(into, empty("The sources are not available.", r.error)); return; }
      const turns = r.data?.turns || [];
      const taught = r.data?.taught || [];
      const threads = new Set(turns.map(t => t.session));
      onCount?.(turns.length, threads.size);
      put(into,
        h("div", { class: "mem-src-head" }, h("h3", { class: "lbl" }, "Sources"),
          h("span", { class: "lbl" }, threads.size ? plural(threads.size, "thread") : taught.length ? plural(taught.length, "module") : "")),
        [...threads].map(sid => {
          const said = turns.filter(t => t.session === sid);
          const newest = Math.max(...said.map(t => t.ts || 0));
          return h("div", { class: "mem-turn" },
            h("div", { class: "mem-turn-top" }, icon("lines", 14),
              link(threadHref(sid), { class: "link ellipsis mem-turn-name" }, said[0].name || "Untitled thread"),
              h("span", { class: "mem-turn-when" }, newest ? `${when(newest)} · ${clock(newest)}` : "")),
            said.map(t => h("blockquote", { class: "recalled mem-quote" }, `“${t.text}”`,
              h("span", { class: "mem-who" }, t.role === "user" ? "You" : "The agent", t.age ? `, ${t.age} ago` : ""))));
        }),
        taught.map(t => h("div", { class: "mem-turn" },
          h("div", { class: "mem-turn-top" }, icon("branch", 14), h("span", { class: "mem-turn-name" }, `Taught by ${t.module}`),
            h("span", { class: "mem-turn-when" }, t.at ? when(t.at) : "")),
          t.text ? h("blockquote", { class: "recalled mem-quote" }, t.text, h("span", { class: "mem-who" }, t.kind)) : null)),
        !turns.length && !taught.length ? h("div", { class: "empty" }, "No turn behind this is still in the index.") : null,
        r.data?.gone ? h("p", { class: "small faint mem-gone" }, `${plural(r.data.gone, "turn")} behind this ${r.data.gone === 1 ? "is" : "are"} no longer in the index.`) : null);
    });
  }

  function drawFact(id) {
    const e = data.byId.get(id);
    const f = e?.fact;
    if (!f) {
      // Not in any list (muted, or past the limit): memory.why still knows the fact itself.
      if (side.hidden) side.hidden = false;
      put(side, h("div", { class: "small faint" }, "Reading memory…"));
      attempt("memory.why", { fact: id, limit: 1 }).then(r => {
        if (!ctx.alive() || st.about !== id) return;
        const head = r.data?.fact;
        if (head && head.id === id) { data.byId.set(id, { fact: head, groups: [] }); drawFact(id); }
        else drawThing(id);
      });
      return;
    }
    const key = contextKey(id);
    const pname = projectName(key) || "Everywhere";
    const main = shell(`Fact · ${pname}`, f.text);
    const status = h("p", { class: "small muted mem-status", role: "status" });
    const recalled = h("span", null, plural(f.evidence || 0, "turn"));
    const about = f.subject?.id
      ? h("button", { type: "button", class: "link mem-linkbtn", onclick: () => openThing(f.subject.id, key) }, f.subject.label)
      : h("span", null, "Unknown");
    const learned = [dateTime(learnedAt(f)), f.age ? `${f.age} ago` : ""].filter(Boolean).join(" · ") + (f.taught?.length && !f.ref ? `, by ${f.taught[0].module}` : "");
    const node = f.subject?.id || f.id;
    const label = f.subject?.label || "this";
    const src = h("div", { class: "mem-sources" });
    const forget = h("button", { type: "button", class: "btn btn-ghost mem-forget" }, "Forget this fact");
    forget.addEventListener("click", async () => {
      /** @type {HTMLButtonElement} */ (forget).disabled = true;
      try {
        await call("memory.mute", { node, scope: "*" });
        put(status, `Muted everywhere. Memory will not offer ${label} again. `,
          h("button", { type: "button", class: "link mem-linkbtn", onclick: async () => {
            await attempt("memory.mute", { node, scope: "*", off: true });
            put(status, `${label} is back.`);
            /** @type {HTMLButtonElement} */ (forget).disabled = false;
            load();
          } }, "Undo"));
        load();
      } catch (err) { put(status, String(/** @type {any} */ (err).message)); /** @type {HTMLButtonElement} */ (forget).disabled = false; }
    });
    const [pin, mute] = steering(node, label, key, status);
    const where = key && key !== EVERYWHERE ? `every ${pname} thread` : "every thread";
    put(main,
      h("dl", { class: "mem-dl" },
        row("About", about),
        row("Learned", learned || "Unknown"),
        row("Recalled", recalled),
        row("Confidence", pct(f.confidence))),
      h("div", { class: "mem-actions" }, pin, mute,
        h("button", { type: "button", class: "btn btn-ghost", disabled: true, "aria-describedby": "mem-edit-note" }, icon("edit", 14), "Edit")),
      h("p", { class: "mem-help" }, `Pin to recall ${label} first in ${where}. Mute to keep it here but never recall it.`),
      h("p", { class: "mem-help", id: "mem-edit-note" }, "Editing facts comes with the curator's next release."),
      status,
      src,
      h("div", { class: "mem-grow" }),
      forget);
    sources(id, src, (turns, threads) => put(recalled, threads ? `From ${plural(turns, "turn")} in ${plural(threads, "thread")}` : plural(f.evidence || 0, "turn")));
  }

  async function drawThing(id) {
    const n = ++sideSeq;
    const key = contextKey(id);
    const r = await attempt("memory.facts", { about: id, limit: 50 });
    if (n !== sideSeq || !ctx.alive() || st.about !== id) return;
    const a = r.data?.about;
    if (r.error || !a) {
      const main = shell("Memory", r.error ? "Memory is not available." : "Nothing in memory matches this.");
      put(main, r.error ? empty("", r.error) : h("p", { class: "small muted" }, "It may have been forgotten, or the address is out of date."));
      return;
    }
    const kind = a.kind === "person" ? "Person" : a.kind === "org" ? "Organisation" : a.kind === "email" ? "Email" : a.kind === "domain" ? "Domain" : a.kind === "repo" ? "Repository" : "Thing";
    const pname = key && key !== EVERYWHERE ? projectName(key) : "";
    const main = shell(pname ? `${kind} · ${pname}` : kind, a.label);
    const status = h("p", { class: "small muted mem-status", role: "status" });
    const [pin, mute] = steering(a.id, a.label, key, status);
    const facts = r.data?.facts || [];
    const src = h("div", { class: "mem-sources" });
    const where = pname ? `every ${pname} thread` : "every thread";
    put(main,
      h("dl", { class: "mem-dl" },
        row("First seen", dateTime(a.first) || "Unknown"),
        row("Last seen", [dateTime(a.last), a.age ? `${a.age} ago` : ""].filter(Boolean).join(" · ") || "Unknown"),
        row("Came up", `${plural(a.mentions || 0, "time")} in ${plural(a.sessions || 0, "thread")}`)),
      h("div", { class: "mem-actions" }, pin, mute),
      h("p", { class: "mem-help" }, `Pin to recall ${a.label} first in ${where}. Mute to keep it here but never recall it.`),
      status,
      facts.length ? h("div", { class: "mem-facts" },
        h("div", { class: "mem-src-head" }, h("h3", { class: "lbl" }, "Facts"), h("span", { class: "lbl" }, String(facts.length))),
        h("div", { class: "rows" }, facts.map(f => h("button", { type: "button", class: "mem-fact-btn", onclick: () => {
          if (!data.byId.has(f.id)) data.byId.set(f.id, { fact: f, groups: key ? [key] : [] });
          openFact(f.id, key);
        } }, h("span", { class: "dot recall", "aria-hidden": "true" }), h("span", null, f.text))))) : null,
      src);
    sources(id, src);
  }

  // ---- go ------------------------------------------------------------------------------------
  let rt = 0, lastW = 0, lastPhone = phone();
  const onResize = () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => {
      const w = body.clientWidth;
      if (w === lastW && phone() === lastPhone) return;
      lastW = w; lastPhone = phone();
      drawBody();
    }, 150);
  };
  window.addEventListener("resize", onResize);
  ctx.cleanup(() => { window.removeEventListener("resize", onResize); clearTimeout(rt); });
  const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape" && st.about && !(/** @type {Element} */ (e.target)).closest("select,input")) close(); };
  document.addEventListener("keydown", onKey);
  ctx.cleanup(() => document.removeEventListener("keydown", onKey));
  ctx.on("memory.curated", () => { clearTimeout(ct); ct = window.setTimeout(load, 400); });
  let ct = 0;
  ctx.cleanup(() => clearTimeout(ct));

  put(body, h("div", { class: "mem-pad small faint" }, "Reading memory…"));
  try { await Promise.race([document.fonts?.ready, new Promise(r => setTimeout(r, 800))]); } catch {}
  await load(true);
  lastW = body.clientWidth;
}
