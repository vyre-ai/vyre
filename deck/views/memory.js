// @ts-check
// Memory: what the curator has learned, drawn as a floor plan (one room per project) or listed
// with where each fact came from, one fact or thing at a time in the side panel, and the Lessons
// tab. Board: DeckMemory. ADR 0007, decision 13.
//
// Everything here came from memory, so Recall gold marks the facts and their sources. Signal marks
// only focus (the selected node's ring). Tools: memory.graph (one call, with the `since` cursor),
// memory.facts, memory.why, memory.pin, memory.mute, memory.correct, memory.uncorrect,
// projects.list; the Lessons tab is memory-lessons.js.
//
// Light (SPEC principle 8): no timers. A memory.curated event whose `updated` is what is drawn
// does nothing; while the tab is hidden it only marks the view dirty, and the one fetch waits for
// visibilitychange.
//
// Address: /memory?tab=lessons | ?project=<slug>&view=list&about=<fact or node id>&around=<node id>

import { h, put, link, go, empty } from "../js/dom.js";
import { attempt, call } from "../js/api.js";
import { icon } from "../js/icons.js";
import { when, clock, startOfToday, plural } from "../js/fmt.js";
import { floor, legendMark } from "./memory-map.js";
import { graphCursor, projectsFrom, turnHref, relWords, pct, roomInput } from "./memory-data.js";
import { correctForm, corrected, errWords } from "./memory-correct.js";

const phone = () => window.matchMedia("(max-width: 760px)").matches;
const typing = el => !!el && typeof el.closest === "function" && el.closest("input, textarea, select, [contenteditable]") !== null;
const seenAt = f => f.seen || f.since || 0;
/** "3 weeks ago" from an age in words; nothing for "today", which the date already says. */
const ago = age => (age && /\d/.test(String(age)) ? `${age} ago` : "");
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
    tab: q.get("tab") === "lessons" ? "lessons" : "facts",
    mode: q.get("view") === "list" ? "list" : "map",
    today: false,
    project: q.get("project") || "",
    about: q.get("about") || "",
    around: q.get("around") || "",
    newest: true,
    scale: 1,
    correcting: "",   // the fact id whose form is open, in the list or the panel
  };
  const data = {
    /** @type {{ slug: string, name: string, folders: string[] }[]} */ projects: [],
    /** @type {any} */ graph: null,
    /** @type {any[]} */ facts: [],
    /** @type {Map<string, any>} */ byId: new Map(),
    /** @type {Map<string, any>} */ nodes: new Map(),
    /** @type {Map<string, string>} */ sessionProject: new Map(),
    /** @type {any} */ error: null,
    /** @type {any} */ factsError: null,
    /** @type {Map<string, { pinned: boolean, muted: boolean }>} */ steer: new Map(),
    /** corrections made here, shown until the next curator pass: fact id -> { action, object, id, fact } */
    done: new Map(),
  };

  // ---- skeleton ------------------------------------------------------------------------------
  const tabBtn = (id, label, extra) => h("button", { type: "button", role: "tab", id: "mem-tab-" + id, "aria-controls": "mem-panel",
    "aria-selected": String(st.tab === id), tabindex: st.tab === id ? "0" : "-1", class: "mem-tab", onclick: () => switchTab(id) }, label, extra || null);
  const beacon = h("span", { class: "mem-beacon", hidden: true, "aria-label": "" });
  const tabs = h("div", { class: "mem-tabs", role: "tablist", "aria-label": "Memory",
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const next = st.tab === "facts" ? "lessons" : "facts";
      switchTab(next); /** @type {HTMLElement} */ (tabs.querySelector("#mem-tab-" + next))?.focus();
    } },
    tabBtn("facts", "Memory"), tabBtn("lessons", "Lessons", beacon));
  const seg = h("div", { class: "seg mem-seg", role: "group", "aria-label": "View" },
    ["map", "list"].map(m => h("button", { type: "button", "data-mode": m, "aria-pressed": String(st.mode === m),
      onclick: () => { st.mode = /** @type {any} */ (m); remember(); drawBody(); drawSeg(); } }, m === "map" ? "Map" : "List")));
  const drawSeg = () => seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === st.mode)));
  const todayChip = h("button", { type: "button", class: "mem-today", "aria-pressed": "false",
    onclick: () => { st.today = !st.today; todayChip.setAttribute("aria-pressed", String(st.today)); drawBody(); } },
    h("span", { class: "dot recall", "aria-hidden": "true" }), "Learned today");
  const select = /** @type {HTMLSelectElement} */ (h("select", { class: "mem-select", "aria-label": "Scope",
    onchange: () => { st.project = select.value; st.around = ""; closeSide(false); remember(); refetch(true); } }));
  const projectPick = h("label", { class: "mem-pick" }, select, icon("chevron", 14));
  const counts = h("span", { class: "small faint mem-counts" });
  const crumbs = h("nav", { class: "mem-crumbs", "aria-label": "Where you are", hidden: true });
  const body = h("div", { class: "mem-body" });
  const foot = h("div", { class: "mem-foot" });
  const side = h("aside", { class: "mem-side", "aria-label": "Selected fact", hidden: true });
  const controls = h("div", { class: "mem-controls" }, seg, todayChip, projectPick);
  const head = h("div", { class: "mem-head" }, h("h1", { class: "vh" }, "Memory"), tabs, controls, h("div", { class: "mem-grow" }), counts);
  const main = h("div", { class: "mem-main", id: "mem-panel", role: "tabpanel" }, crumbs, body, foot);
  put(ctx.root, h("div", { class: "mem" }, h("div", { class: "mem-col" }, head, main), side));

  function remember() {
    const u = new URLSearchParams();
    if (st.tab === "lessons") u.set("tab", "lessons");
    else {
      if (st.project) u.set("project", st.project);
      if (st.mode === "list") u.set("view", "list");
      if (st.around) u.set("around", st.around);
      if (st.about) u.set("about", st.about);
    }
    const qs = u.toString();
    history.replaceState(null, "", "/memory" + (qs ? "?" + qs : ""));
  }

  // ---- tabs ----------------------------------------------------------------------------------
  let lessonsView = null;
  async function switchTab(tab) {
    if (tab === st.tab && (tab === "facts" ? !lessonsView : lessonsView)) return;
    st.tab = tab;
    for (const id of ["facts", "lessons"]) {
      const b = /** @type {HTMLElement} */ (tabs.querySelector("#mem-tab-" + id));
      b.setAttribute("aria-selected", String(id === tab));
      b.setAttribute("tabindex", id === tab ? "0" : "-1");
    }
    main.setAttribute("aria-labelledby", "mem-tab-" + tab);
    ctx.root.querySelector(".mem")?.classList.toggle("is-lessons", tab === "lessons");
    remember();
    if (tab === "lessons") {
      closeSide(false);
      controls.hidden = true; put(counts); crumbs.hidden = true; put(foot);
      put(body, h("div", { class: "mem-pad small faint" }, "Reading lessons…"));
      const mod = await import("./memory-lessons.js");
      if (!ctx.alive() || st.tab !== "lessons") return;
      lessonsView = await mod.default(body, ctx, { onCount: drawBeacon, names: () => new Map(data.projects.map(p => [p.slug, p.name])) });
    } else {
      lessonsView?.stop?.();
      lessonsView = null;
      controls.hidden = false;
      if (data.graph) { drawCounts(); drawBody(); } else { put(body, h("div", { class: "mem-pad small faint" }, "Reading memory…")); refetch(true); }
    }
  }
  /** The Lessons tab's beacon: how many proposals wait for the user. */
  function drawBeacon(n) {
    beacon.hidden = !n;
    put(beacon, n ? String(n) : "");
    beacon.setAttribute("aria-label", n ? `, ${plural(n, "proposal")} waiting` : "");
  }
  async function countProposed() {
    const r = await attempt("learn.lessons", { status: "proposed" });
    if (!ctx.alive() || st.tab === "lessons") return;
    drawBeacon(Array.isArray(r.data) ? r.data.length : Array.isArray(r.data?.lessons) ? r.data.lessons.length : 0);
  }

  // ---- data ----------------------------------------------------------------------------------
  const cwdsOf = slug => data.projects.find(p => p.slug === slug)?.folders || [];
  const scopeOf = () => (st.project ? cwdsOf(st.project)[0] || "*" : "*");
  const projectName = slug => data.projects.find(p => p.slug === slug)?.name || slug;

  /** memory.graph and memory.facts for the current scope; the graph carries the cursor. */
  async function fetchGraph(since) {
    const input = { limit: 150, ...roomInput(st.project), ...(st.around ? { around: st.around, depth: 1 } : {}), ...(since !== undefined ? { since } : {}) };
    const g = await attempt("memory.graph", input);
    if (!ctx.alive()) return { unchanged: true };
    if (g.error) { data.error = g.error; data.graph = null; drawCounts(); drawBody(); return { unchanged: true }; }
    if (g.data?.unchanged) return g.data;
    // Only a changed graph costs the facts read.
    const f = await attempt("memory.facts", { limit: 200, ...roomInput(st.project) });
    if (!ctx.alive()) return { unchanged: true };
    data.facts = f.data?.facts || [];
    data.factsError = f.error || null;
    return g.data;
  }
  function useGraph(g) {
    data.error = null;
    data.graph = g;
    data.nodes = new Map((g.nodes || []).map(n => [n.id, n]));
    for (const n of g.nodes || []) data.steer.set(n.id, { pinned: !!n.pinned, muted: !!n.muted });
    data.byId = new Map(data.facts.map(f => [f.id, f]));
    // Which project a thread belongs to, for linking its turns: the graph's thread nodes say.
    for (const n of g.nodes || []) if (n.kind === "thread") {
      const room = (n.rooms || [n.room]).find(r => String(r).startsWith("project:"));
      const slug = room ? String(room).slice(8) : st.project || "";
      if (slug) data.sessionProject.set(String(n.id).replace(/^session:/, ""), slug);
    }
    if (!st.project && g.scope === "main" && !data.projects.length) { data.projects = projectsFrom(null, g.rooms); drawSelect(); }
    drawCounts();
    if (st.tab === "facts") drawBody();
    if (st.about && !side.hidden) reopen();
  }
  const cursor = graphCursor({ fetch: fetchGraph, draw: useGraph, hidden: () => document.hidden });
  const refetch = (fresh = false) => cursor.request(fresh);

  function drawSelect() {
    put(select,
      h("option", { value: "" }, "Everything"),
      data.projects.map(p => h("option", { value: p.slug }, p.name)));
    if (st.project && data.projects.length && !data.projects.some(p => p.slug === st.project)) st.project = "";
    select.value = st.project;
  }
  function drawCounts() {
    const c = data.graph?.counts;
    put(counts, !c || data.error || st.tab !== "facts" ? "" : st.project ? `${plural(c.facts, "fact")} · ${plural(c.nodes, "thing")}` : `${plural(c.facts, "fact")} · ${plural(data.projects.length, "project")}`);
  }

  // ---- body: map or list ---------------------------------------------------------------------
  function drawBody() {
    if (st.tab !== "facts") return;
    const list = st.mode === "list" || phone();
    body.classList.toggle("is-list", list);
    drawCrumbs();
    if (data.error) { put(body, h("div", { class: "mem-pad" }, empty("Memory is not available.", data.error))); put(foot); return; }
    if (!data.graph) return;
    if (list) { drawList(); put(foot); return; }
    drawMap();
  }

  function drawCrumbs() {
    const here = st.project ? projectName(st.project) : "Everything";
    if (!st.around) { crumbs.hidden = true; put(crumbs); return; }
    const n = data.nodes.get(st.around);
    crumbs.hidden = false;
    put(crumbs, h("ol", null,
      h("li", null, h("button", { type: "button", class: "link quiet mem-linkbtn", onclick: () => { st.around = ""; remember(); refetch(true); } }, here)),
      h("li", { "aria-current": "page" }, `Around ${n?.label || "one thing"}`)));
  }

  function emptyNote() {
    if (st.today && data.facts.length) {
      const newest = Math.max(...data.facts.map(seenAt));
      return h("div", { class: "empty mem-empty" },
        h("p", null, `Nothing learned today${st.project ? ` in ${projectName(st.project)}` : ""}. The newest fact is from ${when(newest)}.`),
        h("button", { type: "button", class: "btn btn-ghost mem-show-all", onclick: () => todayChip.click() }, "Show all facts"));
    }
    if (st.project) return h("div", { class: "empty mem-empty" }, h("p", null, `Memory holds nothing about ${projectName(st.project)} yet.`),
      h("p", { class: "small faint" }, "It learns from this project's threads as they are indexed."));
    return h("div", { class: "empty mem-empty" }, h("p", null, "Memory holds no facts yet."),
      h("p", { class: "small faint" }, "It learns people, organisations and what links them from your threads as they are indexed."));
  }

  // List ---------------------------------------------------------------------------------------
  const listStatus = h("p", { class: "small muted mem-status", role: "status" });
  function visibleFacts() {
    let rows = data.facts.filter(f => !st.today || seenAt(f) >= startOfToday());
    if (st.around) rows = rows.filter(f => data.nodes.has(f.subject?.id) || data.nodes.has(f.object?.id));
    return rows.sort((a, b) => (st.newest ? 1 : -1) * (seenAt(b) - seenAt(a)) || String(a.text).localeCompare(String(b.text)));
  }
  function drawList() {
    if (data.factsError) { put(body, h("div", { class: "mem-pad" }, empty("The facts are not available.", data.factsError))); return; }
    // Corrections made here stay in view, with their Undo, even once the curator has closed the
    // old fact and it has left memory.facts.
    const listed = visibleFacts();
    const ids = new Set(listed.map(f => f.id));
    const rows = [...[...data.done.values()].filter(c => !ids.has(c.fact.id)).map(c => c.fact), ...listed];
    if (!rows.length) { put(body, h("div", { class: "mem-pad" }, emptyNote())); return; }
    const sortBtn = h("button", { type: "button", class: "mem-sort lbl", "aria-label": st.newest ? "Sorted newest first. Sort oldest first" : "Sorted oldest first. Sort newest first",
      onclick: () => { st.newest = !st.newest; drawBody(); } }, "Age ", st.newest ? "↓" : "↑");
    const list = h("div", { class: "mem-list", role: "list", "aria-label": "Facts", onkeydown: listKeys }, rows.map(f => factRow(f)));
    put(body, h("div", { class: "mem-pad" },
      h("div", { class: "mem-lrow mem-lhead", "aria-hidden": "true" },
        h("span", { class: "lbl mem-c-text" }, "Fact"), h("span", { class: "lbl mem-c-src" }, "Source"),
        h("span", { class: "mem-c-age" }, sortBtn), h("span", { class: "lbl mem-c-conf" }, "Conf."), h("span", { class: "mem-c-act" })),
      listStatus, list));
    roving(list);
  }
  /** Only one row is in the tab order: the open one, or the first. */
  function roving(list) {
    const rows = [...list.querySelectorAll(".mem-row")];
    const on = rows.find(r => r.getAttribute("data-id") === st.about) || rows[0];
    for (const r of rows) r.setAttribute("tabindex", r === on ? "0" : "-1");
  }
  function listKeys(/** @type {KeyboardEvent} */ e) {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!t.classList.contains("mem-row")) return;
    const rows = /** @type {HTMLElement[]} */ ([...body.querySelectorAll(".mem-row")]);
    const i = rows.indexOf(t);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
      for (const r of rows) r.setAttribute("tabindex", r === next ? "0" : "-1");
      next?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const next = e.key === "Home" ? rows[0] : rows[rows.length - 1];
      for (const r of rows) r.setAttribute("tabindex", r === next ? "0" : "-1");
      next?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openFact(String(t.getAttribute("data-id")));
    }
  }
  function threadLink(f, cls = "mem-src") {
    const href = turnHref(f.ref, s => data.sessionProject.get(s));
    if (href) return link(href, { class: "link recall-link ellipsis " + cls, title: f.ref.seq !== undefined ? `Turn ${f.ref.seq} of ${f.ref.name || f.source || "the thread"}` : undefined },
      f.ref.name || f.source || "A thread");
    if (f.taught?.length) return h("span", { class: "mem-gold " + cls }, `Taught by ${f.taught[0].module}`);
    return h("span", { class: "faint" }, "Unknown");
  }
  function factRow(f) {
    const done = data.done.get(f.id);
    if (done) return h("div", { class: "mem-row mem-row-done", role: "listitem", tabindex: "-1", "data-id": f.id, "aria-label": `Corrected: ${f.text}` },
      corrected(f, done, { status: listStatus, onUndone: () => { data.done.delete(f.id); drawBody(); refetch(); } }));
    if (st.correcting === f.id && side.hidden) return h("div", { class: "mem-row mem-row-cx", role: "listitem", "data-id": f.id },
      correctForm(f, { project: st.project || undefined, status: listStatus,
        onDone: c => { st.correcting = ""; data.done.set(f.id, { ...c, fact: f }); drawBody(); focusRow(f.id); },
        onCancel: () => { st.correcting = ""; drawBody(); focusRow(f.id); } }));
    const subj = f.subject?.label || "this";
    const sv = data.steer.get(f.subject?.id) || { pinned: false, muted: false };
    const stop = (/** @type {Event} */ e) => e.stopPropagation();
    return h("div", { class: "mem-row mem-lrow" + (st.about === f.id ? " on" : "") + (f.until ? " closed" : ""), role: "listitem", tabindex: "-1", "data-id": f.id,
      "aria-label": `${f.text}. From ${f.ref?.name || f.source || "an unknown thread"}, ${f.age || when(seenAt(f))}, confidence ${pct(f.confidence)}`,
      onclick: (/** @type {MouseEvent} */ ev) => { if (!(/** @type {Element} */ (ev.target)).closest("a,button")) openFact(f.id); } },
      h("span", { class: "mem-c-text" }, h("span", { class: "dot recall", "aria-hidden": "true" }), h("span", { class: "mem-ltext" }, f.text)),
      h("span", { class: "mem-c-src small", onclick: stop }, threadLink(f)),
      h("span", { class: "mem-c-age code" }, f.age || when(seenAt(f))),
      h("span", { class: "mem-c-conf code" }, pct(f.confidence)),
      h("span", { class: "mem-c-act", onclick: stop },
        f.subject?.id ? h("button", { type: "button", class: "ibtn", tabindex: "-1", "aria-pressed": String(sv.pinned),
          "aria-label": `${sv.pinned ? "Unpin" : "Pin"} ${subj}, the subject of this fact`, title: `${sv.pinned ? "Unpin" : "Pin"} ${subj}`,
          onclick: () => steerNode(f.subject.id, subj, "pin", !sv.pinned, listStatus) }, icon("pin", 14)) : null,
        f.subject?.id ? h("button", { type: "button", class: "ibtn", tabindex: "-1", "aria-pressed": String(sv.muted),
          "aria-label": `${sv.muted ? "Unmute" : "Mute"} ${subj}, the subject of this fact`, title: `${sv.muted ? "Unmute" : "Mute"} ${subj}`,
          onclick: () => steerNode(f.subject.id, subj, "mute", !sv.muted, listStatus) }, icon("mute", 14)) : null,
        h("button", { type: "button", class: "ibtn", tabindex: "-1", "aria-label": `Correct: ${f.text}`, title: "Correct",
          onclick: () => { st.correcting = f.id; drawBody(); } }, icon("edit", 14))));
  }
  function focusRow(id) {
    const r = /** @type {HTMLElement|null} */ (body.querySelector(`.mem-row[data-id="${CSS.escape(id)}"]`));
    if (!r) return;
    for (const x of body.querySelectorAll(".mem-row")) x.setAttribute("tabindex", x === r ? "0" : "-1");
    r.focus();
  }

  /** Pin or mute a node, here: in this project when one is chosen, else everywhere. */
  async function steerNode(node, label, mode, on, status) {
    const scope = scopeOf();
    const tool = mode === "pin" ? "memory.pin" : "memory.mute";
    try {
      if (on) await call(tool, { node, scope });
      else { await call(tool, { node, scope, off: true }); if (scope !== "*") await call(tool, { node, scope: "*", off: true }); }
      const cur = data.steer.get(node) || { pinned: false, muted: false };
      data.steer.set(node, mode === "pin" ? { ...cur, pinned: on } : { ...cur, muted: on });
      const where = scope === "*" ? "everywhere" : `in ${projectName(st.project)}`;
      put(status, mode === "pin" ? (on ? `Pinned ${label} ${where}.` : `Unpinned ${label}.`) : (on ? `Muted ${label} ${where}. Memory keeps it but never recalls it.` : `Unmuted ${label}.`),
        on ? " " : null, on ? h("button", { type: "button", class: "link mem-linkbtn", onclick: () => steerNode(node, label, mode, false, status) }, "Undo") : null);
    } catch (e) { put(status, errWords(e, mode === "pin" ? "Pinning" : "Muting")); }
    if (st.tab === "facts") {
      const focused = /** @type {HTMLElement|null} */ (document.activeElement);
      const rowId = focused?.closest?.(".mem-row")?.getAttribute("data-id");
      if (body.classList.contains("is-list")) { drawBody(); if (rowId) focusRow(rowId); }
      if (!side.hidden) reopen();
    }
  }

  // Map ----------------------------------------------------------------------------------------
  let mapState = null;
  function drawMap() {
    const g = data.graph;
    if (!(g.nodes || []).length && !(g.rooms || []).some(r => r.kind === "project")) { put(body, h("div", { class: "mem-pad" }, emptyNote())); put(foot); return; }
    const today = startOfToday();
    // When a link was last said: its fact's newest turn when listed, else when it began. In a
    // project's graph `learned` is that project's newest turn; in the main graph it is when the
    // curator stored the row, which a full rebuild makes today for everything, so it is not used.
    const said = e => data.byId.get(e.id)?.seen ?? e.since ?? (g.scope === "project" ? e.learned : null) ?? 0;
    const shown = st.today ? { ...g, edges: g.edges.filter(e => said(e) >= today) } : g;
    if (st.today) {
      const keep = new Set(shown.edges.flatMap(e => [e.src, e.dst]));
      shown.nodes = g.nodes.filter(n => keep.has(n.id));
      if (!shown.nodes.length) { put(body, h("div", { class: "mem-pad" }, emptyNote())); put(foot); return; }
    }
    const { svg, W, H } = floor(shown, {
      width: body.clientWidth || 960, selected: st.about,
      today: e => said(e) >= today,
      factText: (e, a, b) => data.byId.get(e.id)?.text || `${a.label} ${relWords(e.rel)} ${b.label}`,
      onNode: n => (n.kind === "fact" ? openFact(n.id) : openThing(n.id)),
      onFact: e => openFact(e.id),
      onThread: n => go(turnHref({ session: String(n.id).replace(/^session:/, "") }, s => data.sessionProject.get(s)) || "/now"),
    });
    const scroller = h("div", { class: "mem-scroll" }, svg);
    mapState = { W, H, svg, scroller };
    put(body, scroller);
    applyScale();
    const zoom = f => { st.scale = Math.min(2.5, Math.max(0.3, st.scale * f)); applyScale(); };
    const c = g.counts || {};
    put(foot,
      h("div", { class: "mem-foot-l" },
        g.truncated ? h("p", { class: "small muted mem-trunc" },
          `Drawing ${c.drawn ?? g.nodes.length} of ${plural(c.nodes ?? g.nodes.length, "thing")}. `,
          st.about && data.nodes.has(st.about) && !st.around
            ? h("button", { type: "button", class: "link mem-linkbtn", onclick: () => aroundNode(st.about) }, `Show what is around ${data.nodes.get(st.about).label}`)
            : "Open a person or thing and choose Around to see the rest near it.") : null,
        h("div", { class: "mem-legend", "aria-hidden": "true" },
          legend("today", "Learned today"), legend("earlier", "Earlier"), legend("fact", "Fact"), legend("person", "Person"), legend("thing", "Thing or thread"))),
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
  const legend = (kind, text) => h("span", { class: "mem-leg" }, legendMark(kind), h("span", null, text));
  function aroundNode(id) {
    st.around = id;
    remember();
    refetch(true);
  }

  // ---- side panel ----------------------------------------------------------------------------
  let sideSeq = 0;
  let panelKeys = { pin: /** @type {HTMLElement|null} */ (null), mute: /** @type {HTMLElement|null} */ (null), correct: /** @type {(() => void)|null} */ (null) };
  function closeSide(redraw = true) {
    const was = st.about;
    st.about = ""; st.correcting = "";
    side.hidden = true;
    put(side);
    panelKeys = { pin: null, mute: null, correct: null };
    remember();
    if (redraw && st.tab === "facts") { drawBody(); if (was) focusRow(was); }
  }
  function reopen() {
    if (!st.about) return;
    if (data.byId.has(st.about) || st.about.split("|").length === 3) drawFact(st.about); else drawThing(st.about);
  }
  /** Redraw the list or map, keeping keyboard focus where it was (a row, or a node on the map). */
  function redrawKeepingFocus() {
    const a = /** @type {Element|null} */ (document.activeElement);
    const id = a?.closest?.("[data-id]")?.getAttribute("data-id");
    const inBody = !!a && body.contains(a);
    drawBody();
    if (!inBody || !id) return;
    const el = /** @type {HTMLElement|null} */ (body.querySelector(`[data-id="${CSS.escape(id)}"]`));
    if (el?.classList.contains("mem-row")) focusRow(id); else el?.focus();
  }
  function openFact(id) {
    st.about = id;
    if (st.correcting !== id) st.correcting = "";
    remember();
    drawFact(id);
    redrawKeepingFocus();
    if (phone()) /** @type {HTMLElement|null} */ (side.querySelector(".mem-back"))?.focus();
  }
  function openThing(id) {
    st.about = id;
    st.correcting = "";
    remember();
    drawThing(id);
    redrawKeepingFocus();
  }

  function shell(labelText, heading) {
    const back = h("button", { type: "button", class: "mem-back", onclick: () => closeSide() }, h("span", { class: "mem-back-i" }, icon("right", 14)), "Memory");
    side.hidden = false;
    side.setAttribute("role", phone() ? "dialog" : "complementary");
    if (phone()) side.setAttribute("aria-modal", "true"); else side.removeAttribute("aria-modal");
    const inner = h("div", { class: "mem-side-main" });
    put(side,
      h("div", { class: "mem-phone-top" }, back),
      h("div", { class: "mem-side-top" },
        h("span", { class: "lbl recall mem-side-lbl" }, h("span", { class: "dot recall", "aria-hidden": "true" }), labelText),
        h("button", { type: "button", class: "ibtn mem-close", "aria-label": "Close panel", onclick: () => closeSide() }, icon("close", 13))),
      h("h2", { class: "mem-side-h", tabindex: "-1" }, heading),
      inner);
    return inner;
  }
  const row = (dt, dd) => h("div", { class: "mem-dl-row" }, h("dt", null, dt), h("dd", null, dd));
  const where = () => (st.project ? projectName(st.project) : "Everywhere");

  function steerButtons(node, label, status) {
    const sv = data.steer.get(node) || { pinned: false, muted: false };
    const pin = h("button", { type: "button", class: "btn", "aria-pressed": String(sv.pinned), "aria-keyshortcuts": "P",
      "aria-label": `${sv.pinned ? "Unpin" : "Pin"} ${label}`, onclick: () => steerNode(node, label, "pin", !sv.pinned, status) },
      icon("pin", 14), sv.pinned ? "Pinned" : "Pin");
    const mute = h("button", { type: "button", class: "btn", "aria-pressed": String(sv.muted), "aria-keyshortcuts": "M",
      "aria-label": `${sv.muted ? "Unmute" : "Mute"} ${label}`, onclick: () => steerNode(node, label, "mute", !sv.muted, status) },
      icon("mute", 14), sv.muted ? "Muted" : "Mute");
    panelKeys.pin = pin; panelKeys.mute = mute;
    return [pin, mute];
  }

  /** SOURCES: the turns behind a fact or a thing, each a quoted recalled block with a link to that turn. */
  function sources(id, into, onCount) {
    const n = ++sideSeq;
    put(into, h("div", { class: "small faint mem-loading" }, "Reading the sources…"));
    attempt("memory.why", { fact: id, limit: 10, ...roomInput(st.project) }).then(r => {
      if (n !== sideSeq || !ctx.alive()) return;
      if (r.error) { put(into, empty("The sources are not available.", r.error)); return; }
      const turns = r.data?.turns || [];
      const taught = r.data?.taught || [];
      const threads = [...new Set(turns.map(t => t.session))];
      onCount?.(turns.length, threads.length);
      put(into,
        h("div", { class: "mem-src-head" }, h("h3", { class: "lbl" }, "Sources"),
          h("span", { class: "lbl" }, threads.length ? plural(threads.length, "thread") : taught.length ? plural(taught.length, "module") : "")),
        threads.map(sid => {
          const said = turns.filter(t => t.session === sid);
          const newest = Math.max(...said.map(t => t.ts || 0));
          return h("div", { class: "mem-turn" },
            h("div", { class: "mem-turn-top" }, icon("lines", 14),
              link(turnHref({ session: sid, seq: said[0].seq }, s => data.sessionProject.get(s)) || "#", { class: "link recall-link ellipsis mem-turn-name" }, said[0].name || "Untitled thread"),
              h("span", { class: "mem-turn-when" }, newest ? (when(newest) === clock(newest) ? `Today · ${clock(newest)}` : `${when(newest)} · ${clock(newest)}`) : "")),
            said.map(t => h("blockquote", { class: "recalled mem-quote" }, `“${t.text}”`,
              h("span", { class: "mem-who" }, t.role === "user" ? "You" : "The agent", ago(t.age) ? `, ${ago(t.age)}` : "",
                Number.isInteger(t.seq) ? " · " : "",
                Number.isInteger(t.seq) ? link(turnHref({ session: sid, seq: t.seq }, s => data.sessionProject.get(s)) || "#", { class: "link quiet" }, `turn ${t.seq}`) : null))));
        }),
        taught.map(t => h("div", { class: "mem-turn" },
          h("div", { class: "mem-turn-top" }, icon("branch", 14), h("span", { class: "mem-turn-name" }, `Taught by ${t.module}`),
            h("span", { class: "mem-turn-when" }, t.at ? when(t.at) : "")),
          t.text ? h("blockquote", { class: "recalled mem-quote" }, t.text, h("span", { class: "mem-who" }, t.kind)) : null)),
        !turns.length && !taught.length ? h("div", { class: "empty" }, "No turn behind this is still in the index.") : null,
        r.data?.gone ? h("p", { class: "small faint mem-gone" }, `${plural(r.data.gone, "turn")} behind this ${r.data.gone === 1 ? "is" : "are"} no longer in the index.`) : null);
    });
  }

  /** A fact the facts list does not hold (past the limit), built from its graph edge. */
  function fromEdge(id) {
    const e = (data.graph?.edges || []).find(x => x.id === id);
    if (!e) return null;
    const a = data.nodes.get(e.src), b = data.nodes.get(e.dst);
    return { id, text: `${a?.label || e.src} ${relWords(e.rel)} ${b?.label || e.dst}`, subject: a ? { id: a.id, label: a.label, kind: a.kind } : null,
      object: b ? { id: b.id, label: b.label, kind: b.kind } : null, rel: e.rel, confidence: e.confidence, since: e.since, until: e.until, seen: e.learned, ref: null };
  }

  function drawFact(id) {
    let f = data.byId.get(id) || fromEdge(id);
    const node = data.nodes.get(id);
    if (!f && node?.kind === "fact") f = { id, text: node.label, subject: null, object: null, confidence: 1, seen: node.last, ref: null };
    if (!f) {
      // Not drawn and not listed (muted, or past the limit): memory.why still knows the fact.
      side.hidden = false;
      put(side, h("div", { class: "small faint" }, "Reading memory…"));
      attempt("memory.why", { fact: id, limit: 1, ...roomInput(st.project) }).then(r => {
        if (!ctx.alive() || st.about !== id) return;
        const head = r.data?.fact;
        if (head && head.id === id) { data.byId.set(id, head); drawFact(id); } else drawThing(id);
      });
      return;
    }
    const inner = shell(`Fact · ${where()}`, f.text);
    const status = h("p", { class: "small muted mem-status", role: "status" });
    const recalled = h("span", null, f.evidence ? plural(f.evidence, "turn") : "Reading…");
    const about = f.subject?.id
      ? h("button", { type: "button", class: "link mem-linkbtn", onclick: () => openThing(f.subject.id) }, f.subject.label)
      : h("span", null, "A note");
    const learned = [dateTime(f.since || f.seen), ago(f.age)].filter(Boolean).join(" · ");
    const label = f.subject?.label || "this";
    const src = h("div", { class: "mem-sources" });
    const cx = h("div", { class: "mem-side-cx" });
    const drawCx = () => {
      const d = data.done.get(id);
      /** @type {HTMLButtonElement} */ (correctBtn).disabled = !f.object || !!d;
      panelKeys.correct = f.object && !d ? () => { st.correcting = id; drawCx(); } : null;
      if (d) { put(cx, corrected(f, d, { status, onUndone: () => { data.done.delete(id); drawFact(id); if (body.classList.contains("is-list")) drawBody(); refetch(); } })); return; }
      if (st.correcting === id) {
        put(cx, correctForm(f, { project: st.project || undefined, status, cls: "in-side",
          onDone: c => { st.correcting = ""; data.done.set(id, { ...c, fact: f }); drawCx(); if (body.classList.contains("is-list")) drawBody(); /** @type {HTMLElement|null} */ (cx.querySelector(".mem-undo"))?.focus(); },
          onCancel: () => { st.correcting = ""; drawCx(); correctBtn.focus(); } }));
      } else put(cx);
    };
    const correctBtn = h("button", { type: "button", class: "btn btn-ghost", "aria-keyshortcuts": "C",
      onclick: () => { st.correcting = id; drawCx(); } }, icon("edit", 14), "Correct");
    const [pin, mute] = f.subject?.id ? steerButtons(f.subject.id, label, status) : [null, null];
    put(inner,
      h("dl", { class: "mem-dl" },
        row("About", about),
        row("Learned", learned || "Unknown"),
        row("Source", threadLink(f, "mem-src-panel")),
        row("Recalled", recalled),
        row("Confidence", h("span", { class: "code mem-conf" }, pct(f.confidence))),
        f.until ? row("Until", dateTime(f.until)) : null),
      h("div", { class: "mem-actions" }, pin, mute, correctBtn),
      h("p", { class: "mem-help" }, f.subject?.id
        ? `Pin and Mute act on ${label}, the subject of this fact, ${st.project ? `in ${projectName(st.project)}` : "everywhere"}. Correct changes this fact only.`
        : "Correct changes this fact only."),
      h("p", { class: "mem-help mem-keys", "aria-hidden": "true" }, h("span", { class: "kbd" }, "P"), " pin ", h("span", { class: "kbd" }, "M"), " mute ", h("span", { class: "kbd" }, "C"), " correct ", h("span", { class: "kbd" }, "Esc"), " close"),
      status, cx, src);
    drawCx();
    sources(id, src, (turns, threads) => put(recalled, threads ? `From ${plural(turns, "turn")} in ${plural(threads, "thread")}` : plural(f.evidence || 0, "turn")));
  }

  async function drawThing(id) {
    const n = ++sideSeq;
    if (side.hidden) { side.hidden = false; put(side, h("div", { class: "small faint" }, "Reading memory…")); }
    const r = await attempt("memory.facts", { about: id, limit: 50, ...roomInput(st.project) });
    if (n !== sideSeq || !ctx.alive() || st.about !== id) return;
    const a = r.data?.about || (data.nodes.get(id) ? { ...data.nodes.get(id) } : null);
    if (r.error && !a) {
      const inner = shell("Memory", "Memory is not available.");
      put(inner, empty("", r.error));
      return;
    }
    if (!a) {
      const inner = shell("Memory", "Nothing in memory matches this.");
      put(inner, h("p", { class: "small muted" }, "It may have been forgotten, or the address is out of date."));
      return;
    }
    if (r.data?.about) data.steer.set(a.id, { pinned: !!a.pinned, muted: !!a.muted });
    const kind = { person: "Person", org: "Organisation", email: "Email", domain: "Domain", repo: "Repository", name: "Name" }[a.kind] || "Thing";
    const inner = shell(`${kind} · ${where()}`, a.label);
    const status = h("p", { class: "small muted mem-status", role: "status" });
    const [pin, mute] = steerButtons(a.id, a.label, status);
    panelKeys.correct = null;
    const facts = r.data?.facts || [];
    const src = h("div", { class: "mem-sources" });
    const around = st.around === a.id ? null
      : h("button", { type: "button", class: "btn btn-ghost", onclick: () => aroundNode(a.id) }, icon("memory", 14), "Around");
    put(inner,
      h("dl", { class: "mem-dl" },
        row("First seen", dateTime(a.first) || "Unknown"),
        row("Last seen", [dateTime(a.last), ago(a.age)].filter(Boolean).join(" · ") || "Unknown"),
        a.sessions !== undefined ? row("Came up", `${plural(a.mentions || 0, "time")} in ${plural(a.sessions || 0, "thread")}`) : null),
      h("div", { class: "mem-actions" }, pin, mute, phone() ? null : around),
      h("p", { class: "mem-help" }, `Pin to recall ${a.label} first ${st.project ? `in ${projectName(st.project)}` : "everywhere"}. Mute to keep it here but never recall it.`),
      status,
      facts.length ? h("div", { class: "mem-facts" },
        h("div", { class: "mem-src-head" }, h("h3", { class: "lbl" }, "Facts"), h("span", { class: "lbl" }, String(facts.length))),
        h("div", { class: "rows" }, facts.map(f => h("button", { type: "button", class: "mem-fact-btn", onclick: () => {
          if (!data.byId.has(f.id)) data.byId.set(f.id, f);
          openFact(f.id);
        } }, h("span", { class: "dot recall", "aria-hidden": "true" }), h("span", null, f.text))))) : null,
      src);
    sources(id, src);
  }

  // ---- keys, resize, events ------------------------------------------------------------------
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (st.tab !== "facts") return;
    const t = /** @type {Element} */ (e.target);
    if (e.key === "Escape") {
      if (typing(t) || !st.about) return;
      e.preventDefault();
      closeSide();
      return;
    }
    if (side.hidden || !st.about || typing(t) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "p" && panelKeys.pin) { e.preventDefault(); panelKeys.pin.click(); }
    else if (k === "m" && panelKeys.mute) { e.preventDefault(); panelKeys.mute.click(); }
    else if (k === "c" && panelKeys.correct) { e.preventDefault(); panelKeys.correct(); }
  };
  document.addEventListener("keydown", onKey);
  ctx.cleanup(() => document.removeEventListener("keydown", onKey));

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

  // A background tab does nothing but remember that something changed.
  const onVisible = () => { if (!document.hidden) cursor.visible(); };
  document.addEventListener("visibilitychange", onVisible);
  ctx.cleanup(() => document.removeEventListener("visibilitychange", onVisible));
  ctx.on("memory.curated", e => { if (st.tab === "facts" || data.graph) cursor.curated(e.payload); });
  for (const t of ["lesson.proposed", "lesson.learned", "lesson.retired"]) ctx.on(t, () => { if (st.tab === "facts" && !document.hidden) countProposed(); });

  // ---- go ------------------------------------------------------------------------------------
  const pl = await attempt("projects.list");
  if (!ctx.alive()) return;
  data.projects = projectsFrom(pl.data?.projects || null, null);
  drawSelect();
  countProposed();
  if (st.tab === "lessons") { st.tab = "facts"; await switchTab("lessons"); return; }
  controls.hidden = false;
  put(body, h("div", { class: "mem-pad small faint" }, "Reading memory…"));
  try { await Promise.race([document.fonts?.ready, new Promise(r => setTimeout(r, 800))]); } catch {}
  // With no projects.list, the main graph names the projects; a scoped first view needs them.
  if (st.project && !data.projects.length) { const p = st.project; st.project = ""; await cursor.request(true); st.project = data.projects.some(x => x.slug === p) ? p : ""; drawSelect(); }
  await cursor.request(true);
  lastW = body.clientWidth;
  if (st.about) reopen();
}
