// @ts-check
// graph — reading Memory back: facts, what is relevant to a prompt, why a fact is believed, and
// the one write a person makes directly (pin or mute).
//
// Every fact carries its source (the turn it came from), its age and a confidence, because the
// Harness marks memory as memory and the security floor says anything Vyre tells the user it
// can show the source of. A fact whose turns are gone is not shown; the curator deletes it.

import path from "node:path";
import { registrable, OPENERS } from "./lexicon.js";
import { T, UNFILED } from "./curator.js";
import { within } from "./teach.js";

/** What one lesson taught for a project counts for, against a session's mentions, when ranking a project's facts. */
const LESSON_WEIGHT = 3;

/** mentioned_in says where something came up, not what it is; every other relation is a fact
 * about it, including the ones modules teach. */
const WHERE = "mentioned_in";
/** Roles that never count as an outside party: the user's own, tools, mail hosts, hubs. */
const QUIET = new Set(["own", "tool", "mail", "hub"]);

const PHRASE = {
  works_at: (a, b) => `${a} works at ${b}`,
  has_email: (a, b) => `${a}'s email is ${b}`,
  has_domain: (a, b) => `${a}'s domain is ${b}`,
  at_domain: (a, b) => `${a} is an address at ${b}`,
  owned_by: (a, b) => `the repo ${a} belongs to ${b}`,
  mentioned_in: (a, b) => `${a} came up in "${b}"`,
};
const words = rel => rel.replace(/_/g, " ");

const DAY = 86_400_000;
/**
 * How fast each kind of fact goes stale, read at read time (docs/adr/0007-intelligence.md,
 * decision 3): [half-life in days, floor]. Who someone is barely ages; where they work ages in
 * months; that a thing came up in a thread ages in weeks.
 */
const IDENTITY = [365, 0.4];
export const DECAY = {
  has_email: IDENTITY, has_domain: IDENTITY, at_domain: IDENTITY, owned_by: IDENTITY, repo_for: IDENTITY,
  works_at: [180, 0.25], has_title: [180, 0.25], client_of: [120, 0.25], prefers: [180, 0.25],
  decided: [60, 0.1], mentioned_in: [30, 0.1],
};
/** Below this a fact is stale: listed by memory.facts, marked, and left out of Enrich unless pinned. */
export const STALE = 0.35;

/**
 * fresh = max(floor, 0.5 ^ (days since seen / half-life)). What the user said or confirmed does
 * not decay, and a fact with no date is as fresh as it ever was. Silence never closes an edge.
 */
export function freshness(e, now = Date.now()) {
  if (["user", "confirmed"].includes(String(e.origin))) return 1;
  const seen = Number(e.seen) || Number(e.valid_from) || 0;
  if (!seen) return 1;
  const [half, floor] = DECAY[/** @type {keyof typeof DECAY} */ (String(e.rel))] || [180, 0.25];
  return Math.max(floor, 0.5 ** (Math.max(0, now - seen) / DAY / half));
}

/** "5 minutes", "3 weeks", "4 months": how old, the way a person says it. */
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, (now - ms) / 1000);
  const say = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (s < 3600) return say(Math.max(1, Math.round(s / 60)), "minute");
  if (s < 86400) return say(Math.round(s / 3600), "hour");
  const d = Math.round(s / 86400);
  if (d < 14) return say(d, "day");
  if (d < 60) return say(Math.round(d / 7), "week");
  if (d < 730) return say(Math.round(d / 30), "month");
  return say(Math.round(d / 365), "year");
}

export class Graph {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ version: number, hasRecall(): boolean, rooms(): { slug: string, name: string, folders: string[], threads: string[] }[], roomSessions(room: string): Set<string> }} curator  read for rooms and cache invalidation only
   * @param {{ now?: () => number }} [opts]
   */
  constructor(db, curator, opts = {}) {
    this.db = db;
    this.curator = curator;
    this.now = opts.now || (() => Date.now());
    /** Phrases per room ('*' is the main graph), rebuilt when the curator changes the graph. */
    this.cache = new Map();
  }

  // ------------------------------------------------------------------ nodes

  /** A node as the view sees it: in a room, that room's kind, role, counts and dates. */
  node(id, sc = null) {
    if (sc?.room) return this.db.prepare("SELECT * FROM memory_room_nodes WHERE room = ? AND id = ?").get(sc.room, id) || null;
    return this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) || null;
  }

  /**
   * A node for display. In a project's view its counts and times come from that project's
   * sessions and lessons only, so a summary never says how busy something is elsewhere.
   */
  summary(n, sc = null) {
    if (!n) return null;
    if (sc && !sc.room) {
      const ms = this.mentionEdges(String(n.id), 10_000, sc);
      const times = this.db.prepare("SELECT started, ended FROM recall_sessions WHERE id = ?");
      let first = 0, last = 0;
      for (const e of ms) {
        const r = this.curator.hasRecall() ? times.get(String(e.dst).slice(8)) : null;
        const a = Number(r?.started) || 0, b = Number(r?.ended) || a;
        if (a && (!first || a < first)) first = a;
        if (b > last) last = b;
      }
      return { id: n.id, label: n.label, kind: n.kind, role: n.role ?? null, sessions: ms.length, mentions: ms.reduce((x, e) => x + Number(e.weight), 0),
        first: first || null, last: last || null, age: ago(last, this.now()) };
    }
    return { id: n.id, label: n.label, kind: n.kind, role: n.role ?? null, sessions: n.sessions, mentions: n.mentions,
      first: n.first_seen ?? null, last: n.last_seen ?? null, age: ago(Number(n.last_seen), this.now()) };
  }

  /**
   * Find the node a person means: an id, an exact name, address or domain, a learned short form,
   * then a partial match, most-seen first.
   */
  resolve(ref, sc = null) {
    const r = String(ref || "").trim();
    if (!r) return null;
    const db = this.db;
    // In a project's view only nodes that view contains can be found: resolving over the whole
    // graph would say that someone only another client's sessions know exists, and when.
    // A room's view reads the room's own nodes and short forms, so what is found there is what
    // that room knows. The main graph and a folder view read the main graph's.
    const ok = sc && !sc.room ? (n => n && this.nodeIn(String(n.id), sc)) : (n => Boolean(n));
    const lim = sc && !sc.room ? 50 : 1;
    const room = sc?.room || "*";
    const nodes = sc?.room ? "(SELECT * FROM memory_room_nodes WHERE room = ?)" : "(SELECT * FROM memory_nodes WHERE ? = '*')";
    const steps = [
      () => [this.node(r, sc)],
      () => db.prepare(`SELECT * FROM ${nodes} WHERE lower(label) = lower(?) ORDER BY sessions DESC LIMIT ${lim}`).all(room, r),
      () => db.prepare(`SELECT n.* FROM memory_shortforms f JOIN ${nodes} n ON n.id = f.node
                     WHERE f.room = ? AND f.form = lower(?) AND f.precision >= ? AND f.sessions >= ? ORDER BY f.precision DESC, n.sessions DESC LIMIT ${lim}`).all(room, room, r, T.shortPrecision, T.shortMinSessions),
      () => db.prepare(`SELECT * FROM ${nodes} WHERE lower(label) LIKE lower(?) ESCAPE '\\'
                     ORDER BY (role IS NULL) DESC, sessions DESC, label LIMIT ${lim}`).all(room, "%" + r.replace(/[\\%_]/g, "\\$&") + "%"),
    ];
    for (const step of steps) { const hit = step().find(ok); if (hit) return hit; }
    return null;
  }

  /** Is this node part of the view: named in its sessions, or at one end of an edge in it? */
  nodeIn(id, sc) {
    if (!sc) return true;
    if (sc.room) return Boolean(this.node(id, sc));
    if (this.mentionEdges(id, 1, sc).length) return true;
    const scopes = this.lessonScopes();
    return this.db.prepare("SELECT * FROM memory_edges WHERE room = '*' AND (src = ? OR dst = ?) AND rel != 'mentioned_in'").all(id, id).some(e => this.edgeIn(e, sc, scopes));
  }

  // ------------------------------------------------------------------ facts

  /** Session names for display, when Recall is there to ask. */
  labels(ids) {
    const out = new Map();
    if (!ids.length || !this.curator.hasRecall()) return out;
    const q = this.db.prepare("SELECT id, name, title, cwd FROM recall_sessions WHERE id = ?");
    for (const id of new Set(ids)) { const r = q.get(id); if (r) out.set(id, { name: r.name || r.title || id, cwd: r.cwd }); }
    return out;
  }

  /**
   * One edge as a fact: what it says, where it came from, how old and how sure. In a project's
   * view only that project's turns and lessons count as its support, so a fact never cites
   * another project's thread as its source.
   */
  fact(e, sc = null) {
    const db = this.db;
    const ev = db.prepare("SELECT session, seq FROM memory_evidence WHERE edge = ? ORDER BY session, seq").all(e.id)
      .filter(v => !sc || sc.sessions.has(String(v.session)));
    const src = this.node(e.src, sc), dst = String(e.dst).startsWith("session:") ? null : this.node(e.dst, sc);
    const sessionId = String(e.dst).startsWith("session:") ? String(e.dst).slice(8) : null;
    // The most recent supporting turn is the one worth pointing at. Its time comes from the
    // observations, which carry each turn's own clock.
    const tsq = db.prepare("SELECT MAX(ts) ts FROM memory_obs WHERE session = ? AND seq = ?");
    let best = null, seen = 0;
    for (const v of ev) { const ts = Number(tsq.get(v.session, v.seq)?.ts || 0); if (!best || ts >= seen) { best = v; seen = ts; } }
    // The newest supporting turn over all evidence, not the capped few, when the row knows it
    // and the view is not a folder view (which counts only its own turns).
    if ((!sc || sc.room) && Number(e.seen) > seen) seen = Number(e.seen);
    const names = this.labels([...(best ? [String(best.session)] : []), ...(sessionId ? [sessionId] : [])]);
    // Lessons: what modules taught that supports this edge. When no turn does, the module is
    // the source.
    const taught = db.prepare(`SELECT l.module, l.kind, l.key, t.fact, t.at FROM memory_lessons l
      LEFT JOIN memory_taught t ON t.module = l.module AND t.kind = l.kind AND t.key = l.key
      WHERE l.edge = ? ORDER BY t.at DESC, l.module, l.kind, l.key`).all(e.id).filter(t => this.lessonIn(t.fact, sc));
    if (!best && taught.length) seen = Math.max(seen, ...taught.map(t => Number(t.at) || 0));
    const fresh = Number(freshness({ ...e, seen }, this.now()).toFixed(3));
    const note = String(e.dst).startsWith("note:");
    const noteText = note ? (() => { try { return JSON.parse(String(taught[0]?.fact)).text; } catch { return null; } })() : null;
    const object = dst ? { id: dst.id, label: dst.label, kind: dst.kind, role: dst.role ?? null }
      : note ? { id: e.dst, label: noteText || "a note", kind: "note", role: null }
      : { id: e.dst, label: sessionId ? names.get(sessionId)?.name || sessionId : e.dst, kind: "session", role: null };
    const text = note ? `${src?.label ?? e.src}: ${noteText || "a note"}`
      : (PHRASE[e.rel] || ((a, b) => `${a} ${words(String(e.rel))} ${b}`))(src?.label ?? e.src, object.label);
    // In a project's view, when a fact held comes from that project's own turns; and it reads as
    // closed only if what replaced it is in the view too. Otherwise another client's sessions
    // would show through as a date.
    let since = Number(e.valid_from) || null, until = e.valid_to == null ? null : Number(e.valid_to);
    if (sc && !sc.room) {
      if (since && ev.length) since = Math.min(...ev.map(v => Number(tsq.get(v.session, v.seq)?.ts || 0)).filter(Boolean)) || since;
      if (until !== null) {
        const scopes = this.lessonScopes();
        const next = db.prepare("SELECT * FROM memory_edges WHERE room = '*' AND src = ? AND rel = ? AND dst != ? AND valid_to IS NULL").all(e.src, e.rel, e.dst);
        if (!next.some(x => this.edgeIn(x, sc, scopes))) until = null;
      }
    }
    return {
      id: `${e.src}|${e.rel}|${e.dst}`,
      text,
      subject: src ? { id: src.id, label: src.label, kind: src.kind, role: src.role ?? null } : { id: e.src, label: e.src, kind: null, role: null },
      rel: e.rel, object,
      confidence: Number(e.confidence),
      since, until,
      seen: seen || null, age: ago(seen, this.now()),
      // Decay, read now: stale facts are still listed, marked, with when they were last said.
      fresh, stale: fresh < STALE, seen_age: ago(seen, this.now()),
      // source is what a person reads: the thread's /rename name or its first message. ref is
      // the exact turn, for memory.why and anything that wants to open it.
      source: best ? names.get(String(best.session))?.name || String(best.session).slice(0, 8) : taught.length ? `taught by ${taught[0].module}` : null,
      ref: best ? { session: String(best.session), seq: Number(best.seq), name: names.get(String(best.session))?.name || null } : null,
      evidence: ev.length,
      taught: taught.map(t => ({ module: String(t.module), kind: String(t.kind) })),
      // Two rooms believe different things and the user has not said which: the Deck asks.
      conflict: Boolean(e.conflict),
    };
  }

  focus(scopes) {
    const out = { pin: new Set(), mute: new Set() };
    const want = new Set(["*", ...scopes]);
    for (const r of this.db.prepare("SELECT node, scope, mode FROM memory_focus").all()) if (want.has(String(r.scope))) out[/** @type {"pin"|"mute"} */ (r.mode)].add(String(r.node));
    return out;
  }

  /** Sessions that ran in these folders or under them, subagents included. */
  scoped(cwds) {
    if (!cwds.length || !this.curator.hasRecall()) return new Set();
    // A plain prefix compare: LIKE ignores case, and on a case-sensitive disk /w/acme and
    // /w/ACME are two different clients.
    const q = this.db.prepare("SELECT id FROM recall_sessions WHERE cwd = ? OR substr(cwd, 1, length(?) + 1) = ? || '/'");
    const out = new Set();
    for (const c of cwds) {
      const base = String(c).replace(/\/+$/, "") || "/";
      for (const r of base === "/" ? this.db.prepare("SELECT id FROM recall_sessions WHERE substr(cwd, 1, 1) = '/'").all() : q.all(base, base, base)) out.add(String(r.id));
    }
    return out;
  }

  identityEdges(id, { closed = false, sc = null } = {}) {
    return this.db.prepare(`SELECT * FROM memory_edges WHERE room = ? AND (src = ? OR dst = ?) AND rel != ?
      ${closed ? "" : "AND valid_to IS NULL"} ORDER BY valid_to IS NOT NULL, confidence DESC, id`).all(sc?.room || "*", id, id, WHERE);
  }

  mentionEdges(id, limit = 5, sc = null) {
    const legacy = sc && !sc.room;
    const rows = this.db.prepare(`SELECT * FROM memory_edges WHERE room = ? AND src = ? AND rel = 'mentioned_in' ORDER BY valid_from DESC, id DESC ${legacy ? "" : "LIMIT ?"}`)
      .all(...(legacy ? ["*", id] : [sc?.room || "*", id, limit]));
    return legacy ? rows.filter(e => sc.sessions.has(String(e.dst).slice(8))).slice(0, limit) : rows;
  }

  /**
   * For each edge that lessons support: whether any of them is for everywhere, and the folders
   * of those scoped to a project.
   * @returns {Map<number, { open: boolean, cwds: string[] }>}
   */
  lessonScopes() {
    // Lessons change only when the curator derives, so this is cached per graph version: the
    // Enrich hook asks on every prompt, and a watcher can teach thousands of items.
    if (this.scopeCache?.version === this.curator.version) return this.scopeCache.map;
    const out = new Map();
    for (const r of this.db.prepare(`SELECT l.edge, t.fact FROM memory_lessons l
        JOIN memory_taught t ON t.module = l.module AND t.kind = l.kind AND t.key = l.key`).all()) {
      let cwds = null;
      try { cwds = JSON.parse(String(r.fact)).project_cwds || null; } catch {}
      const id = Number(r.edge);
      const e = out.get(id) || { open: false, cwds: [] };
      if (cwds) e.cwds.push(...cwds); else e.open = true;
      out.set(id, e);
    }
    this.scopeCache = { version: this.curator.version, map: out };
    return out;
  }

  /**
   * A view of the graph: null is the main graph, everything. A room (a project's slug, or
   * 'unfiled') is that room's own rows (docs/adr/0007-intelligence.md, decision 1); folders that
   * one project owns are its room. Folders no project owns are a folder view: the main graph's
   * rows, kept only where those folders' sessions or lessons support them (docs/SPEC.md, 7.4).
   * @param {string[]} [cwds]
   * @param {string} [room]
   * @returns {{ cwds: string[], sessions: Set<string>, room: string|null } | null}
   */
  view(cwds, room) {
    if (room && room !== "*") {
      if (room === UNFILED) return { cwds: [], sessions: this.curator.roomSessions(UNFILED), room: UNFILED };
      const p = this.curator.rooms().find(x => x.slug === room);
      if (!p) throw new Error(`no project ${room}`);
      return { cwds: p.folders, sessions: this.curator.roomSessions(p.slug), room: p.slug };
    }
    const clean = [...new Set((cwds || []).filter(c => typeof c === "string" && c.trim()).map(c => path.resolve(c).replace(/\/+$/, "") || "/"))];
    if (!clean.length) return null;
    const p = this.curator.rooms().find(x => x.folders.length && clean.every(c => within(c, x.folders)));
    if (p) return { cwds: p.folders, sessions: this.curator.roomSessions(p.slug), room: p.slug };
    return { cwds: clean, sessions: this.scoped(clean), room: null };
  }

  /** Does a lesson (its stored fact) belong in this view? One for everywhere belongs in all. */
  lessonIn(stored, sc) {
    if (!sc) return true;
    let cwds = null;
    try { cwds = JSON.parse(String(stored)).project_cwds || null; } catch {}
    return !cwds || cwds.some(c => within(c, sc.cwds));
  }

  /**
   * Is this edge part of the view? In a project's graph an edge counts only through that
   * project's own sessions or the lessons taught for it (or for everywhere): a fact another
   * client's sessions established never reaches this project, even about someone both name.
   */
  edgeIn(e, sc, scopes) {
    if (!sc) return String(e.room ?? "*") === "*";
    if (sc.room) return String(e.room) === sc.room;
    if (String(e.room ?? "*") !== "*") return false;
    if (e.rel === WHERE) return sc.sessions.has(String(e.dst).slice(8));
    for (const r of this.db.prepare("SELECT DISTINCT session FROM memory_evidence WHERE edge = ?").all(e.id)) if (sc.sessions.has(String(r.session))) return true;
    const s = scopes.get(Number(e.id));
    return Boolean(s && (s.open || s.cwds.some(c => within(c, sc.cwds))));
  }

  /**
   * Facts about one thing, about the things a project's sessions name, or about the outside
   * parties seen most across everything.
   * @param {{ about?: string, project_cwds?: string[], limit?: number }} input
   */
  facts({ about, project_cwds = [], room, limit = 20 } = {}) {
    const scopes = this.lessonScopes();
    const sc = this.view(project_cwds, room);
    const f = this.focus(sc ? sc.cwds : []);
    if (about) {
      const n = this.resolve(about, sc);
      if (!n) return { about: null, facts: [] };
      const facts = [...this.identityEdges(String(n.id), { closed: true, sc }), ...this.mentionEdges(String(n.id), 5, sc)]
        .filter(e => this.edgeIn(e, sc, scopes)).map(e => this.fact(e, sc));
      return { about: { ...this.summary(n, sc), pinned: f.pin.has(String(n.id)), muted: f.mute.has(String(n.id)) }, facts: facts.slice(0, limit) };
    }
    let ranked;
    if (sc?.room) {
      // A room's own rows: what its sessions name most, and what was taught for it.
      const score = new Map();
      for (const r of this.db.prepare("SELECT src, SUM(weight) w FROM memory_edges WHERE room = ? AND rel = 'mentioned_in' GROUP BY src").all(sc.room)) score.set(String(r.src), Number(r.w));
      const edge = this.db.prepare("SELECT src, room FROM memory_edges WHERE id = ?");
      for (const [id, l] of scopes) {
        const n = l.cwds.filter(c => within(c, sc.cwds)).length;
        const e = n && edge.get(id);
        if (e && e.room === sc.room) score.set(String(e.src), (score.get(String(e.src)) || 0) + LESSON_WEIGHT * n);
      }
      ranked = [...score].map(([id, s]) => ({ n: this.node(id, sc), s }));
    } else if (sc) {
      const score = new Map();
      if (sc.sessions.size) {
        const q = this.db.prepare("SELECT src, weight FROM memory_edges WHERE room = '*' AND dst = ? AND rel = 'mentioned_in'");
        for (const s of sc.sessions) for (const r of q.all("session:" + s)) score.set(String(r.src), (score.get(String(r.src)) || 0) + Number(r.weight));
      }
      // Facts a module taught for this project (a watcher's items, say) bring their subject in,
      // whether or not any of the project's sessions name it.
      const edge = this.db.prepare("SELECT src FROM memory_edges WHERE id = ? AND room = '*'");
      for (const [id, sc] of scopes) {
        const n = sc.cwds.filter(c => within(c, project_cwds)).length;
        const src = n && edge.get(id)?.src;
        if (src) score.set(String(src), (score.get(String(src)) || 0) + LESSON_WEIGHT * n);
      }
      ranked = [...score].map(([id, s]) => ({ n: this.node(id), s }));
    } else {
      ranked = this.db.prepare("SELECT * FROM memory_nodes WHERE kind IN ('org','person') ORDER BY sessions DESC, mentions DESC, label LIMIT 200").all()
        .map(n => ({ n, s: Number(n.sessions) }));
    }
    ranked = ranked.filter(r => r.n && !QUIET.has(String(r.n.role)) && !f.mute.has(String(r.n.id)) && ["org", "person", "name", "email", "repo"].includes(String(r.n.kind)))
      .sort((a, b) => Number(f.pin.has(String(b.n.id))) - Number(f.pin.has(String(a.n.id))) || b.s - a.s || String(a.n.label).localeCompare(String(b.n.label)));
    const out = [], seen = new Set();
    for (const { n } of ranked) {
      if (out.length >= limit) break;
      const edges = this.identityEdges(String(n.id), { sc });
      const inView = edges.filter(e => this.edgeIn(e, sc, scopes));
      const list = inView.length ? inView : this.mentionEdges(String(n.id), 1, sc);
      for (const e of list) {
        const k = `${e.src}|${e.rel}|${e.dst}`;
        if (seen.has(k) || out.length >= limit) continue;
        seen.add(k);
        const other = e.src === n.id ? e.dst : e.src;
        if (f.mute.has(String(other))) continue;
        out.push(this.fact(e, sc));
      }
    }
    return { about: null, facts: out };
  }

  // ------------------------------------------------------------------ relevant

  /**
   * Phrases that name a node, lowercased, to the nodes they name. Rebuilt only when the
   * curator has changed the graph, so a prompt costs a few map lookups.
   */
  phrases(room = "*") {
    const hit = this.cache.get(room);
    if (hit && hit.version === this.curator.version && hit.phrases.size) return hit;
    const phrases = new Map();
    let longest = 1;
    const put = (p, node, weight, via) => {
      const k = p.toLowerCase();
      longest = Math.max(longest, k.split(" ").length);
      if (!phrases.has(k)) phrases.set(k, []);
      phrases.get(k).push({ node, weight, via });
    };
    const nodes = room === "*" ? "(SELECT * FROM memory_nodes WHERE ? = '*')" : "(SELECT * FROM memory_room_nodes WHERE room = ?)";
    for (const n of this.db.prepare(`SELECT id, kind, label, role FROM ${nodes}`).all(room)) {
      if (QUIET.has(String(n.role))) continue;
      put(String(n.label), String(n.id), 1, "name");
    }
    // Every claimant of a short form, most precise first. Which one a prompt means is decided
    // when it is read: the first one in view.
    for (const r of this.db.prepare(`SELECT f.node, f.form, f.precision FROM memory_shortforms f JOIN ${nodes} n ON n.id = f.node
        WHERE f.room = ? AND f.precision >= ? AND f.sessions >= ? AND (n.role IS NULL OR n.role NOT IN ('own','tool','mail','hub'))
        ORDER BY f.form, f.precision DESC, f.sessions DESC, f.node`).all(room, room, T.shortPrecision, T.shortMinSessions)) {
      put(String(r.form), String(r.node), Number(r.precision), "short");
    }
    const out = { version: this.curator.version, phrases, longest };
    this.cache.set(room, out);
    return out;
  }

  /**
   * The few facts worth adding to a prompt about this text, or [] when nothing is relevant.
   * Only what the text itself names counts: a pin raises a named thing, it never adds an
   * unnamed one. Precision over recall, because a wrong memory in a prompt costs more than a
   * missing one.
   * @param {{ text: string, project_cwds?: string[], limit?: number }} input
   */
  relevant({ text, project_cwds = [], room, limit = 5 }) {
    // A session in a project draws only on that project's graph (docs/SPEC.md, section 7.4).
    const sc = this.view(project_cwds, room);
    const { phrases, longest } = this.phrases(sc?.room || "*");
    if (!phrases.size) return [];
    const tokens = String(text || "").match(/&|[\p{L}\p{N}][\p{L}\p{N}'’._@/-]*/gu) || [];
    const words = tokens.map(t => t.replace(/['’]s$/i, "").replace(/[._/-]+$/, "").toLowerCase());
    const hits = new Map();   // node -> { weight, matched }
    for (let i = 0; i < words.length;) {
      let step = 1;
      for (let n = Math.min(longest, words.length - i); n >= 1; n--) {
        const phrase = words.slice(i, i + n).join(" ");
        let list = phrases.get(phrase);
        // An address or a web address names its domain even when the domain itself was never
        // written bare.
        if (!list && n === 1 && /[.@]/.test(phrase)) {
          const host = phrase.includes("@") ? phrase.split("@")[1] : phrase.replace(/^https?:\/\//, "").split("/")[0];
          if (host.includes(".")) list = phrases.get(registrable(host));
        }
        if (!list) continue;
        // A full name names every thing spelled that way; a short form names one thing, the
        // most precise claimant this view contains.
        // A short form followed by another capitalised word is part of a different name:
        // "Summit" in "Summit Roofing" does not mean Summit Dental.
        const partOf = n === 1 && /^\p{Lu}/u.test(tokens[i + 1] || "") && !OPENERS.has(words[i + 1]);
        const short = partOf ? [] : list.filter(h => h.via === "short");
        const pick = short.length ? (sc && !sc.room ? short.find(h => this.nodeIn(h.node, sc)) : short[0]) : null;
        list = [...list.filter(h => h.via !== "short"), ...(pick ? [pick] : [])];
        if (!list.length) continue;
        for (const h of list) {
          const prev = hits.get(h.node);
          if (!prev || h.weight > prev.weight) hits.set(h.node, { weight: h.weight, matched: tokens.slice(i, i + n).join(" ") });
        }
        step = n;
        break;
      }
      i += step;
    }
    if (!hits.size) return [];

    const f = this.focus(sc ? sc.cwds : []);
    const scored = new Map();
    const scopes = this.lessonScopes();
    const now = this.now();
    for (const [id, h] of hits) {
      if (f.mute.has(id)) continue;
      const pinned = f.pin.has(id);
      const boost = pinned ? 1.5 : 1;
      const edges = this.identityEdges(id, { sc }).filter(e => this.edgeIn(e, sc, scopes));
      const list = edges.length ? edges : this.mentionEdges(id, 1, sc);
      for (const e of list) {
        const other = e.src === id ? e.dst : e.src;
        if (f.mute.has(String(other))) continue;
        const k = `${e.src}|${e.rel}|${e.dst}`;
        // A fact where the named thing is the subject answers "who is this"; one where it is the
        // object ("Dana works at Harlow" for a prompt naming Harlow) is context, slightly less.
        // Stale facts stay out of a prompt unless the user pinned what they are about.
        const fresh = freshness(e, now);
        if (fresh < STALE && !pinned && !f.pin.has(String(other))) continue;
        const s = h.weight * Number(e.confidence) * boost * (e.src === id ? 1 : 0.8) * (e.rel === "mentioned_in" ? 0.5 : 1) * fresh;
        if (!scored.has(k) || scored.get(k).s < s) scored.set(k, { s, e, matched: h.matched });
      }
    }
    return [...scored.values()].sort((a, b) => b.s - a.s || a.e.id - b.e.id).slice(0, limit).map(({ e, matched, s }) => {
      const x = this.fact(e, sc);
      return { id: x.id, text: x.text, matched, confidence: x.confidence, age: x.age, seen: x.seen, fresh: x.fresh, source: x.source, ref: x.ref, score: Number(s.toFixed(3)) };
    });
  }

  // ------------------------------------------------------------------ why

  /**
   * The turns behind a fact (its id, "src|rel|dst") or behind a node (where it came up).
   * A turn that no longer exists is counted as gone, never an error: Recall re-indexes
   * rewritten transcripts, and seq values restart when it does.
   */
  why({ fact, limit = 10, project_cwds = [], room }) {
    const db = this.db;
    const sc = this.view(project_cwds, room);
    const scopes = this.lessonScopes();
    let edges = [], head = null;
    const parts = String(fact).split("|");
    if (parts.length === 3) {
      edges = db.prepare("SELECT * FROM memory_edges WHERE room = ? AND src = ? AND rel = ? AND dst = ? ORDER BY valid_to IS NOT NULL, valid_from DESC").all(sc?.room || "*", ...parts)
        .filter(e => this.edgeIn(e, sc, scopes));
      if (edges.length) head = this.fact(edges[0], sc);
    }
    if (!edges.length) {
      const n = this.resolve(fact, sc);
      if (!n) return { fact: null, turns: [], taught: [], gone: 0 };
      head = this.summary(n, sc);
      edges = db.prepare("SELECT * FROM memory_edges WHERE room = ? AND src = ? AND rel = 'mentioned_in' ORDER BY valid_from DESC").all(sc?.room || "*", n.id)
        .filter(e => this.edgeIn(e, sc, scopes));
    }
    const lessons = [];
    for (const e of edges) for (const r of db.prepare(`SELECT l.module, l.kind, l.key, t.fact, t.at FROM memory_lessons l
        LEFT JOIN memory_taught t ON t.module = l.module AND t.kind = l.kind AND t.key = l.key WHERE l.edge = ?`).all(e.id)) {
      if (!this.lessonIn(r.fact, sc)) continue;
      if (lessons.some(x => x.module === r.module && x.kind === r.kind && x.key === r.key)) continue;
      let text = null;
      try { text = JSON.parse(String(r.fact)).text ?? null; } catch {}
      lessons.push({ module: String(r.module), kind: String(r.kind), key: String(r.key), text, at: Number(r.at) || null, age: ago(Number(r.at), this.now()) });
    }
    const refs = [];
    for (const e of edges) for (const r of db.prepare("SELECT session, seq FROM memory_evidence WHERE edge = ? ORDER BY seq").all(e.id)) {
      if (sc && !sc.sessions.has(String(r.session))) continue;
      if (!refs.some(x => x.session === r.session && x.seq === r.seq)) refs.push({ session: String(r.session), seq: Number(r.seq) });
    }
    const wanted = refs.slice(0, limit);
    const found = new Map();
    if (wanted.length && this.curator.hasRecall()) {
      const ids = [...new Set(wanted.map(w => w.session))];
      const rows = db.prepare(`SELECT session, seq, role, ts, text FROM recall_turns WHERE session IN (${ids.map(() => "?").join(",")})`).all(...ids);
      for (const r of rows) found.set(`${r.session}\u0000${r.seq}`, r);
    }
    const names = this.labels(wanted.map(w => w.session));
    const turns = [];
    let gone = 0;
    for (const w of wanted) {
      const r = found.get(`${w.session}\u0000${w.seq}`);
      if (!r) { gone++; continue; }
      turns.push({ session: w.session, seq: w.seq, name: names.get(w.session)?.name || null, role: r.role, ts: Number(r.ts) || null,
        age: ago(Number(r.ts), this.now()), text: String(r.text).slice(0, 400) });
    }
    return { fact: head, turns, taught: lessons, gone };
  }

  // ------------------------------------------------------------------ steering

  /** Pin or mute a node, or clear it with off. The one write a person makes directly. */
  steer({ node, scope = "*", mode, off = false, who = null, project_cwds = [] }) {
    const n = this.resolve(node, this.view(project_cwds));
    if (!n) throw new Error(`nothing in memory matches "${node}"`);
    if (off) this.db.prepare("DELETE FROM memory_focus WHERE node = ? AND scope = ? AND mode = ?").run(n.id, scope, mode);
    else this.db.prepare(`INSERT INTO memory_focus (node, scope, mode, at, who) VALUES (?,?,?,?,?)
      ON CONFLICT(node, scope) DO UPDATE SET mode = excluded.mode, at = excluded.at, who = excluded.who`).run(n.id, scope, mode, this.now(), who);
    this.curator.bump();
    return { node: n.id, label: n.label, scope, mode: off ? null : mode };
  }

  stats() {
    const db = this.db;
    const one = sql => Number(db.prepare(sql).get()?.n || 0);
    const last = db.prepare("SELECT at, sessions, turns, nodes, edges, ms FROM memory_runs ORDER BY id DESC LIMIT 1").get() || null;
    return {
      recall: this.curator.hasRecall(),
      sessions: one("SELECT COUNT(*) n FROM memory_curated"),
      nodes: one("SELECT COUNT(*) n FROM memory_nodes"),
      edges: one("SELECT COUNT(*) n FROM memory_edges WHERE room = '*'"),
      facts: one(`SELECT COUNT(*) n FROM memory_edges WHERE room = '*' AND rel != 'mentioned_in' AND valid_to IS NULL`),
      evidence: one("SELECT COUNT(*) n FROM memory_evidence"),
      byKind: Object.fromEntries(db.prepare("SELECT kind, COUNT(*) n FROM memory_nodes GROUP BY kind ORDER BY n DESC").all().map(r => [r.kind, r.n])),
      byRole: Object.fromEntries(db.prepare("SELECT coalesce(role, 'outside') role, COUNT(*) n FROM memory_nodes GROUP BY 1 ORDER BY n DESC").all().map(r => [r.role, r.n])),
      shortforms: Number(db.prepare("SELECT COUNT(*) n FROM memory_shortforms WHERE room = '*' AND precision >= ? AND sessions >= ?").get(T.shortPrecision, T.shortMinSessions)?.n || 0),
      rooms: this.curator.rooms().length,
      focus: one("SELECT COUNT(*) n FROM memory_focus"),
      taught: one("SELECT COUNT(*) n FROM memory_taught"),
      lastRun: last && { ...last, age: ago(Number(last.at), this.now()) },
    };
  }
}
