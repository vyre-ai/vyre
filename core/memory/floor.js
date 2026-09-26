// @ts-check
// floor — the graph as the Deck draws it: a floor plan with one room per project, a room for the
// people and organisations several projects share, and a room for what belongs to none.
//
// Each project has its own context graph: what its own sessions established and what was taught
// for it (docs/SPEC.md, section 7.4). A scoped call returns exactly that graph, by the same rule
// memory.facts uses, so nothing from one client's project is drawn in another's. The unscoped call
// is the main graph, every project's graph together; who may ask for it is checked by the module,
// not here.
//
// Capped by construction: entities first (pinned, then the most-seen), then the facts taught about
// them, then a few recent threads each. A floor plan with a thousand nodes is not readable, and
// the Deck asks for more with `around` rather than with a bigger limit.

import { within } from "./teach.js";
import { deadlineEnd } from "./graph.js";

/** Roles that never get a room: tools, mail hosts and hubs are beside the work, not in it; the
 * user's own things are everywhere by definition. Same rule as memory.facts. */
const QUIET = new Set(["own", "tool", "mail", "hub"]);
const THREADS_PER_NODE = 2;

/**
 * @typedef {{ slug: string, name: string, folders: string[], threads?: string[] }} Project
 * @param {import("./graph.js").Graph} g
 * @param {{ project_cwds?: string[], room?: string, around?: string, depth?: number, limit?: number, since?: number, projects?: Project[] }} input
 */
export function floorPlan(g, { project_cwds = [], room, around, depth = 1, limit = 150, since, projects = [] } = {}) {
  const db = g.db;
  const updated = g.curator.updated();
  // A poll that has nothing new costs one read.
  if (since !== undefined && since === updated) return { updated, unchanged: true };

  const sc = g.view(project_cwds, room);
  const scopes = g.lessonScopes();
  const focus = g.focus(sc ? sc.cwds : []);
  const recall = g.curator.hasRecall();

  // ---- rooms, and which rooms each session is in
  const rooms = [];
  if (sc) {
    // The room is named for the project that owns every folder asked for; a parent folder that
    // spans several projects is named for the folder, not for whichever project comes first.
    const p = sc.room ? projects.find(p => p.slug === sc.room) || g.curator.rooms().find(p => p.slug === sc.room) : projects.find(p => sc.cwds.every(c => within(c, p.folders)));
    if (sc.room === "unfiled") rooms.push({ id: "unfiled", kind: "unfiled", label: "No project", slug: null, folders: [] });
    else rooms.push({ id: p ? "project:" + p.slug : "project", kind: "project", label: p ? p.name : lastPart(sc.cwds[0]), slug: p?.slug ?? null, folders: p ? p.folders : sc.cwds });
  } else {
    for (const p of projects) rooms.push({ id: "project:" + p.slug, kind: "project", label: p.name, slug: p.slug, folders: p.folders });
    rooms.push({ id: "shared", kind: "shared", label: "Shared", slug: null, folders: [] });
    rooms.push({ id: "unfiled", kind: "unfiled", label: "No project", slug: null, folders: [] });
  }
  const sessions = new Map();   // id -> { name, ended, rooms: string[] }
  if (recall) for (const r of db.prepare("SELECT id, cwd, name, title, ended FROM recall_sessions").all()) {
    const id = String(r.id);
    let rs;
    if (sc) rs = sc.sessions.has(id) ? [rooms[0].id] : null;
    else rs = projects.filter(p => (r.cwd && within(String(r.cwd), p.folders)) || (Array.isArray(p.threads) && p.threads.includes(id.split("/")[0]))).map(p => "project:" + p.slug);
    if (rs) sessions.set(id, { name: String(r.name || r.title || id.slice(0, 8)), ended: Number(r.ended) || 0, rooms: rs });
  }
  // A lesson's rooms: the projects its folders fall in. One for everywhere has no room of its own.
  const lessonRooms = cwds => sc ? (cwds.some(c => within(c, sc.cwds)) ? [rooms[0].id] : [])
    : projects.filter(p => cwds.some(c => within(c, p.folders))).map(p => "project:" + p.slug);

  // ---- every edge in the view, with the rooms it belongs to
  const evidence = new Map();
  for (const r of db.prepare("SELECT edge, session FROM memory_evidence").all()) {
    const k = Number(r.edge);
    if (!evidence.has(k)) evidence.set(k, new Set());
    evidence.get(k).add(String(r.session));
  }
  const edges = [];
  // A room's view is its own rows; the main graph and a folder view read the main graph's.
  for (const e of db.prepare("SELECT id, src, rel, dst, confidence, valid_from, valid_to, observed, conflict FROM memory_edges WHERE room = ? ORDER BY id").all(sc?.room || "*")) {
    const id = Number(e.id), rel = String(e.rel);
    const er = new Set();
    let inView = !sc;
    if (sc?.room) { inView = true; er.add(rooms[0].id); }
    else if (rel === "mentioned_in") {
      const s = sessions.get(String(e.dst).slice(8));
      if (!s) continue;
      inView = true;
      for (const r of s.rooms) er.add(r);
    } else {
      for (const s of evidence.get(id) || []) { const x = sessions.get(s); if (x) { inView = true; for (const r of x.rooms) er.add(r); } }
      const l = scopes.get(id);
      if (l) {
        if (l.open) inView = true;
        const lr = lessonRooms(l.cwds);
        if (lr.length) inView = true;
        for (const r of lr) er.add(r);
      }
    }
    // A deadline closes two days after its date, read now (docs/adr/0007-intelligence.md).
    const due = deadlineEnd({ rel, dst: e.dst });
    const until = e.valid_to != null ? Number(e.valid_to) : due !== null && due <= g.now() ? due : null;
    if (inView) edges.push({ id, src: String(e.src), rel, dst: String(e.dst), confidence: Number(e.confidence),
      since: Number(e.valid_from) || null, until, learned: Number(e.observed) || null,
      taught: scopes.has(id), conflict: Boolean(e.conflict), rooms: er, row: e });
  }

  // ---- entities in the view: weight, rooms
  const nodes = new Map((sc?.room ? db.prepare("SELECT id, kind, label, role, sessions, last_seen FROM memory_room_nodes WHERE room = ?").all(sc.room)
    : db.prepare("SELECT id, kind, label, role, sessions, last_seen FROM memory_nodes").all()).map(n => [String(n.id), n]));
  const ent = new Map();   // id -> { weight, rooms: Set }
  const touch = (id, w, rs) => {
    const n = nodes.get(id);
    if (!n || QUIET.has(String(n.role))) return;
    const x = ent.get(id) || { weight: 0, rooms: new Set() };
    x.weight += w;
    for (const r of rs) x.rooms.add(r);
    ent.set(id, x);
  };
  for (const e of edges) {
    if (e.rel === "mentioned_in") touch(e.src, 1, e.rooms);
    else { touch(e.src, e.taught && !evidence.has(e.id) ? 1 : 0, e.rooms); if (!e.dst.startsWith("note:")) touch(e.dst, 0, e.rooms); }
  }
  const roomOf = x => sc ? rooms[0].id : x.rooms.size === 1 ? [...x.rooms][0] : x.rooms.size > 1 ? "shared" : "unfiled";

  // ---- around a node: its neighbourhood in the view, depth hops over facts (not threads)
  let allowed = null;
  if (around) {
    const start = g.resolve(around, sc);
    allowed = new Set();
    if (start && ent.has(String(start.id))) {
      allowed.add(String(start.id));
      const near = new Map();   // node -> neighbours, built once
      for (const e of edges) if (e.rel !== "mentioned_in") for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]]) {
        if (!near.has(a)) near.set(a, []);
        near.get(a).push(b);
      }
      let frontier = [String(start.id)];
      for (let d = 0; d < Math.min(3, Math.max(1, depth)) && frontier.length; d++) {
        const next = [];
        for (const a of frontier) for (const b of near.get(a) || []) if (!allowed.has(b) && (ent.has(b) || b.startsWith("note:"))) { allowed.add(b); next.push(b); }
        frontier = next;
      }
    }
  }

  // ---- choose, within the cap
  const cap = Math.min(500, Math.max(10, limit));
  const ranked = [...ent].filter(([id]) => !allowed || allowed.has(id))
    .sort((a, b) => Number(focus.pin.has(b[0])) - Number(focus.pin.has(a[0])) || b[1].weight - a[1].weight || String(nodes.get(a[0])?.label).localeCompare(String(nodes.get(b[0])?.label)));
  const picked = new Map();
  for (const [id, x] of ranked.slice(0, Math.ceil(cap * 0.6))) {
    const n = nodes.get(id);
    // In a project's view, when a thing was last seen is when that project last saw it.
    const last = sc && !sc.room ? g.summary(n, sc).last : Number(n.last_seen) || null;
    picked.set(id, { id, kind: String(n.kind), label: String(n.label), weight: x.weight, pinned: focus.pin.has(id), muted: focus.mute.has(id),
      role: n.role ?? null, room: roomOf(x), rooms: sc ? [rooms[0].id] : [...x.rooms].sort(), last });
  }
  // Facts taught about the chosen entities are nodes of their own (the Deck's gold dots).
  const noteText = new Map();
  let dropped = false;
  for (const e of edges) if (e.rel === "noted" && picked.has(e.src) && (!allowed || allowed.has(e.dst))) {
    if (picked.size >= cap) { dropped = true; continue; }
    if (!noteText.has(e.dst)) noteText.set(e.dst, lessonText(db, e.dst));
    picked.set(e.dst, { id: e.dst, kind: "fact", label: noteText.get(e.dst) || "a note", weight: 1, pinned: false, muted: false, role: null,
      room: picked.get(e.src).room, rooms: picked.get(e.src).rooms, last: e.learned });
  }
  // A few recent threads each, while there is room.
  const byEntity = new Map();
  for (const e of edges) if (e.rel === "mentioned_in" && picked.has(e.src)) {
    if (!byEntity.has(e.src)) byEntity.set(e.src, []);
    byEntity.get(e.src).push(e);
  }
  for (const [id, list] of byEntity) {
    list.sort((a, b) => (sessions.get(b.dst.slice(8))?.ended || 0) - (sessions.get(a.dst.slice(8))?.ended || 0));
    for (const e of list.slice(0, THREADS_PER_NODE)) {
      if (picked.size >= cap) break;
      if (picked.has(e.dst)) { picked.get(e.dst).weight++; continue; }
      const s = sessions.get(e.dst.slice(8));
      const rs = s ? s.rooms : [];
      picked.set(e.dst, { id: e.dst, kind: "thread", label: s ? s.name : e.dst.slice(8, 16), weight: 1, pinned: false, muted: false, role: null,
        room: sc ? rooms[0].id : rs.length === 1 ? rs[0] : rs.length > 1 ? "shared" : "unfiled", rooms: sc ? [rooms[0].id] : [...rs].sort(), last: s?.ended || null });
    }
    if (picked.size >= cap) break;
  }

  // ---- edges among what was chosen
  const out = [];
  for (const e of edges) {
    if (!picked.has(e.src) || !picked.has(e.dst)) continue;
    let { since, until, learned } = e;
    if (sc && !sc.room && e.rel !== "mentioned_in") {
      // The same in-view dates memory.facts reports, so a scoped drawing never dates a fact by
      // another project's turns.
      const f = g.fact(e.row, sc);
      since = f.since; until = f.until; learned = f.seen;
    }
    out.push({ id: `${e.src}|${e.rel}|${e.dst}`, src: e.src, rel: e.rel, dst: e.dst, confidence: e.confidence, since, until, learned, taught: e.taught, conflict: e.conflict });
  }

  // ---- room counts, over the whole view rather than the capped drawing
  const count = new Map(rooms.map(r => [r.id, { nodes: 0, facts: 0 }]));
  for (const x of ent.values()) { const c = count.get(roomOf(x)); if (c) c.nodes++; }
  for (const e of edges) if (e.rel !== "mentioned_in" && e.until === null) {
    const x = ent.get(e.src);
    const c = x && count.get(roomOf(x));
    if (c) c.facts++;
  }
  const factsInView = edges.filter(e => e.rel !== "mentioned_in" && e.until === null).length;
  return {
    updated,
    scope: sc ? "project" : "main",
    rooms: rooms.map(r => ({ ...r, ...count.get(r.id) })).filter(r => r.kind === "project" || r.nodes > 0),
    nodes: [...picked.values()],
    edges: out,
    counts: { nodes: ent.size, facts: factsInView, drawn: picked.size },
    truncated: ranked.length > Math.ceil(cap * 0.6) || picked.size >= cap || dropped,
  };
}

const lastPart = p => String(p).replace(/\/+$/, "").split("/").pop() || String(p);

/** The text a note node shows: the lesson it came from. "note:<module>/<kind>/<key>". */
function lessonText(db, id) {
  const rest = id.slice(5);
  const a = rest.indexOf("/"), b = rest.indexOf("/", a + 1);
  if (a < 0 || b < 0) return null;
  const row = db.prepare("SELECT fact FROM memory_taught WHERE module = ? AND kind = ? AND key = ?").get(rest.slice(0, a), rest.slice(a + 1, b), rest.slice(b + 1));
  try { return row ? JSON.parse(String(row.fact)).text || null : null; } catch { return null; }
}
