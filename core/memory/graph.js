// @ts-check
// graph — reading Memory back: facts, what is relevant to a prompt, why a fact is believed, and
// the one write a person makes directly (pin or mute).
//
// Every fact carries its source (the turn it came from), its age and a confidence, because the
// Harness marks memory as memory and the security floor says anything Vyre tells the user it
// can show the source of. A fact whose turns are gone is not shown; the curator deletes it.

import { registrable } from "./lexicon.js";
import { T } from "./curator.js";
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
   * @param {{ version: number, hasRecall(): boolean }} curator  read for cache invalidation only
   * @param {{ now?: () => number }} [opts]
   */
  constructor(db, curator, opts = {}) {
    this.db = db;
    this.curator = curator;
    this.now = opts.now || (() => Date.now());
    this.cache = { version: -1, phrases: new Map(), longest: 1 };
  }

  // ------------------------------------------------------------------ nodes

  node(id) { return this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) || null; }

  summary(n) {
    if (!n) return null;
    return { id: n.id, label: n.label, kind: n.kind, role: n.role ?? null, sessions: n.sessions, mentions: n.mentions,
      first: n.first_seen ?? null, last: n.last_seen ?? null, age: ago(Number(n.last_seen), this.now()) };
  }

  /**
   * Find the node a person means: an id, an exact name, address or domain, a learned short form,
   * then a partial match, most-seen first.
   */
  resolve(ref) {
    const r = String(ref || "").trim();
    if (!r) return null;
    const db = this.db;
    return this.node(r)
      || db.prepare("SELECT * FROM memory_nodes WHERE lower(label) = lower(?) ORDER BY sessions DESC LIMIT 1").get(r)
      || db.prepare(`SELECT n.* FROM memory_shortforms f JOIN memory_nodes n ON n.id = f.node
                     WHERE f.form = lower(?) AND f.precision >= ? AND f.sessions >= ? ORDER BY f.precision DESC, n.sessions DESC LIMIT 1`).get(r, T.shortPrecision, T.shortMinSessions)
      || db.prepare(`SELECT * FROM memory_nodes WHERE lower(label) LIKE lower(?) ESCAPE '\\'
                     ORDER BY (role IS NULL) DESC, sessions DESC, label LIMIT 1`).get("%" + r.replace(/[\\%_]/g, "\\$&") + "%")
      || null;
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

  /** One edge as a fact: what it says, where it came from, how old and how sure. */
  fact(e) {
    const db = this.db;
    const ev = db.prepare("SELECT session, seq FROM memory_evidence WHERE edge = ? ORDER BY session, seq").all(e.id);
    const src = this.node(e.src), dst = String(e.dst).startsWith("session:") ? null : this.node(e.dst);
    const sessionId = String(e.dst).startsWith("session:") ? String(e.dst).slice(8) : null;
    // The most recent supporting turn is the one worth pointing at. Its time comes from the
    // observations, which carry each turn's own clock.
    const tsq = db.prepare("SELECT MAX(ts) ts FROM memory_obs WHERE session = ? AND seq = ?");
    let best = null, seen = 0;
    for (const v of ev) { const ts = Number(tsq.get(v.session, v.seq)?.ts || 0); if (!best || ts >= seen) { best = v; seen = ts; } }
    const names = this.labels([...(best ? [String(best.session)] : []), ...(sessionId ? [sessionId] : [])]);
    // Lessons: what modules taught that supports this edge. When no turn does, the module is
    // the source.
    const taught = db.prepare(`SELECT l.module, l.kind, l.key, t.fact, t.at FROM memory_lessons l
      LEFT JOIN memory_taught t ON t.module = l.module AND t.kind = l.kind AND t.key = l.key
      WHERE l.edge = ? ORDER BY t.at DESC, l.module, l.kind, l.key`).all(e.id);
    if (!best && taught.length) seen = Math.max(...taught.map(t => Number(t.at) || 0));
    const note = String(e.dst).startsWith("note:");
    const noteText = note ? (() => { try { return JSON.parse(String(taught[0]?.fact)).text; } catch { return null; } })() : null;
    const object = dst ? { id: dst.id, label: dst.label, kind: dst.kind, role: dst.role ?? null }
      : note ? { id: e.dst, label: noteText || "a note", kind: "note", role: null }
      : { id: e.dst, label: sessionId ? names.get(sessionId)?.name || sessionId : e.dst, kind: "session", role: null };
    const text = note ? `${src?.label ?? e.src}: ${noteText || "a note"}`
      : (PHRASE[e.rel] || ((a, b) => `${a} ${words(String(e.rel))} ${b}`))(src?.label ?? e.src, object.label);
    return {
      id: `${e.src}|${e.rel}|${e.dst}`,
      text,
      subject: src ? { id: src.id, label: src.label, kind: src.kind, role: src.role ?? null } : { id: e.src, label: e.src, kind: null, role: null },
      rel: e.rel, object,
      confidence: Number(e.confidence),
      since: Number(e.valid_from) || null,
      until: e.valid_to == null ? null : Number(e.valid_to),
      seen: seen || null, age: ago(seen, this.now()),
      // source is what a person reads: the thread's /rename name or its first message. ref is
      // the exact turn, for memory.why and anything that wants to open it.
      source: best ? names.get(String(best.session))?.name || String(best.session).slice(0, 8) : taught.length ? `taught by ${taught[0].module}` : null,
      ref: best ? { session: String(best.session), seq: Number(best.seq), name: names.get(String(best.session))?.name || null } : null,
      evidence: ev.length,
      taught: taught.map(t => ({ module: String(t.module), kind: String(t.kind) })),
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
    const q = this.db.prepare("SELECT id FROM recall_sessions WHERE cwd = ? OR cwd LIKE ? ESCAPE '\\'");
    const out = new Set();
    for (const c of cwds) {
      const base = String(c).replace(/\/+$/, "");
      for (const r of q.all(base, base.replace(/[\\%_]/g, "\\$&") + "/%")) out.add(String(r.id));
    }
    return out;
  }

  identityEdges(id, { closed = false } = {}) {
    return this.db.prepare(`SELECT * FROM memory_edges WHERE (src = ? OR dst = ?) AND rel != ?
      ${closed ? "" : "AND valid_to IS NULL"} ORDER BY valid_to IS NOT NULL, confidence DESC, id`).all(id, id, WHERE);
  }

  mentionEdges(id, limit = 5) {
    return this.db.prepare(`SELECT * FROM memory_edges WHERE src = ? AND rel = 'mentioned_in' ORDER BY valid_from DESC, id DESC LIMIT ?`).all(id, limit);
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
   * Does this edge belong in a view of these project folders? Anything a transcript supports,
   * or a lesson for everywhere, does. A fact taught only for other projects does not.
   */
  visibleIn(e, cwds, scopes) {
    if (!cwds.length) return true;
    const s = scopes.get(Number(e.id));
    if (!s || s.open) return true;
    if (this.db.prepare("SELECT 1 FROM memory_evidence WHERE edge = ? LIMIT 1").get(e.id)) return true;
    return s.cwds.some(c => within(c, cwds));
  }

  /**
   * Facts about one thing, about the things a project's sessions name, or about the outside
   * parties seen most across everything.
   * @param {{ about?: string, project_cwds?: string[], limit?: number }} input
   */
  facts({ about, project_cwds = [], limit = 20 } = {}) {
    const f = this.focus(project_cwds);
    const scopes = this.lessonScopes();
    if (about) {
      const n = this.resolve(about);
      if (!n) return { about: null, facts: [] };
      const facts = [...this.identityEdges(String(n.id), { closed: true }), ...this.mentionEdges(String(n.id))]
        .filter(e => this.visibleIn(e, project_cwds, scopes)).map(e => this.fact(e));
      return { about: { ...this.summary(n), pinned: f.pin.has(String(n.id)), muted: f.mute.has(String(n.id)) }, facts: facts.slice(0, limit) };
    }
    let ranked;
    if (project_cwds.length) {
      const scope = this.scoped(project_cwds);
      const score = new Map();
      if (scope.size) {
        const q = this.db.prepare("SELECT src, weight FROM memory_edges WHERE dst = ? AND rel = 'mentioned_in'");
        for (const s of scope) for (const r of q.all("session:" + s)) score.set(String(r.src), (score.get(String(r.src)) || 0) + Number(r.weight));
      }
      // Facts a module taught for this project (a watcher's items, say) bring their subject in,
      // whether or not any of the project's sessions name it.
      const edge = this.db.prepare("SELECT src FROM memory_edges WHERE id = ?");
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
      const edges = this.identityEdges(String(n.id));
      const list = edges.length ? edges : this.mentionEdges(String(n.id), 1);
      for (const e of list) {
        const k = `${e.src}|${e.rel}|${e.dst}`;
        if (seen.has(k) || out.length >= limit) continue;
        seen.add(k);
        const other = e.src === n.id ? e.dst : e.src;
        if (f.mute.has(String(other)) || !this.visibleIn(e, project_cwds, scopes)) continue;
        out.push(this.fact(e));
      }
    }
    return { about: null, facts: out };
  }

  // ------------------------------------------------------------------ relevant

  /**
   * Phrases that name a node, lowercased, to the nodes they name. Rebuilt only when the
   * curator has changed the graph, so a prompt costs a few map lookups.
   */
  phrases() {
    if (this.cache.version === this.curator.version && this.cache.phrases.size) return this.cache;
    const phrases = new Map();
    let longest = 1;
    const put = (p, node, weight, via) => {
      const k = p.toLowerCase();
      longest = Math.max(longest, k.split(" ").length);
      if (!phrases.has(k)) phrases.set(k, []);
      phrases.get(k).push({ node, weight, via });
    };
    for (const n of this.db.prepare("SELECT id, kind, label, role FROM memory_nodes").all()) {
      if (QUIET.has(String(n.role))) continue;
      put(String(n.label), String(n.id), 1, "name");
    }
    for (const r of this.db.prepare(`SELECT f.node, f.form, f.precision FROM memory_shortforms f JOIN memory_nodes n ON n.id = f.node
        WHERE f.precision >= ? AND f.sessions >= ? AND (n.role IS NULL OR n.role NOT IN ('own','tool','mail','hub'))
        ORDER BY f.form, f.precision DESC, f.sessions DESC`).all(T.shortPrecision, T.shortMinSessions)) {
      // One claimant per short form, the most precise.
      if (phrases.get(String(r.form))?.some(x => x.via === "short")) continue;
      put(String(r.form), String(r.node), Number(r.precision), "short");
    }
    this.cache = { version: this.curator.version, phrases, longest };
    return this.cache;
  }

  /**
   * The few facts worth adding to a prompt about this text, or [] when nothing is relevant.
   * Only what the text itself names counts: a pin raises a named thing, it never adds an
   * unnamed one. Precision over recall, because a wrong memory in a prompt costs more than a
   * missing one.
   * @param {{ text: string, project_cwds?: string[], limit?: number }} input
   */
  relevant({ text, project_cwds = [], limit = 5 }) {
    const { phrases, longest } = this.phrases();
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

    const f = this.focus(project_cwds);
    const scope = project_cwds.length ? this.scoped(project_cwds) : null;
    const inScope = id => {
      if (!scope || !scope.size) return false;
      return this.db.prepare("SELECT dst FROM memory_edges WHERE src = ? AND rel = 'mentioned_in'").all(id).some(r => scope.has(String(r.dst).slice(8)));
    };
    const scored = new Map();
    const scopes = this.lessonScopes();
    for (const [id, h] of hits) {
      if (f.mute.has(id)) continue;
      const boost = (f.pin.has(id) ? 1.5 : 1) * (inScope(id) ? 1.2 : 1);
      const edges = this.identityEdges(id);
      const list = edges.length ? edges : this.mentionEdges(id, 1);
      for (const e of list) {
        const other = e.src === id ? e.dst : e.src;
        if (f.mute.has(String(other)) || !this.visibleIn(e, project_cwds, scopes)) continue;
        const k = `${e.src}|${e.rel}|${e.dst}`;
        // A fact where the named thing is the subject answers "who is this"; one where it is the
        // object ("Dana works at Harlow" for a prompt naming Harlow) is context, slightly less.
        const s = h.weight * Number(e.confidence) * boost * (e.src === id ? 1 : 0.8) * (e.rel === "mentioned_in" ? 0.5 : 1);
        if (!scored.has(k) || scored.get(k).s < s) scored.set(k, { s, e, matched: h.matched });
      }
    }
    return [...scored.values()].sort((a, b) => b.s - a.s || a.e.id - b.e.id).slice(0, limit).map(({ e, matched, s }) => {
      const x = this.fact(e);
      return { id: x.id, text: x.text, matched, confidence: x.confidence, age: x.age, seen: x.seen, source: x.source, ref: x.ref, score: Number(s.toFixed(3)) };
    });
  }

  // ------------------------------------------------------------------ why

  /**
   * The turns behind a fact (its id, "src|rel|dst") or behind a node (where it came up).
   * A turn that no longer exists is counted as gone, never an error: Recall re-indexes
   * rewritten transcripts, and seq values restart when it does.
   */
  why({ fact, limit = 10 }) {
    const db = this.db;
    let edges = [], head = null;
    const parts = String(fact).split("|");
    if (parts.length === 3) {
      edges = db.prepare("SELECT * FROM memory_edges WHERE src = ? AND rel = ? AND dst = ? ORDER BY valid_to IS NOT NULL, valid_from DESC").all(...parts);
      if (edges.length) head = this.fact(edges[0]);
    }
    if (!edges.length) {
      const n = this.resolve(fact);
      if (!n) return { fact: null, turns: [], taught: [], gone: 0 };
      head = this.summary(n);
      edges = db.prepare("SELECT * FROM memory_edges WHERE src = ? AND rel = 'mentioned_in' ORDER BY valid_from DESC").all(n.id);
    }
    const lessons = [];
    for (const e of edges) for (const r of db.prepare(`SELECT l.module, l.kind, l.key, t.fact, t.at FROM memory_lessons l
        LEFT JOIN memory_taught t ON t.module = l.module AND t.kind = l.kind AND t.key = l.key WHERE l.edge = ?`).all(e.id)) {
      if (lessons.some(x => x.module === r.module && x.kind === r.kind && x.key === r.key)) continue;
      let text = null;
      try { text = JSON.parse(String(r.fact)).text ?? null; } catch {}
      lessons.push({ module: String(r.module), kind: String(r.kind), key: String(r.key), text, at: Number(r.at) || null, age: ago(Number(r.at), this.now()) });
    }
    const refs = [];
    for (const e of edges) for (const r of db.prepare("SELECT session, seq FROM memory_evidence WHERE edge = ? ORDER BY seq").all(e.id)) {
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
  steer({ node, scope = "*", mode, off = false, who = null }) {
    const n = this.resolve(node);
    if (!n) throw new Error(`nothing in memory matches "${node}"`);
    if (off) this.db.prepare("DELETE FROM memory_focus WHERE node = ? AND scope = ? AND mode = ?").run(n.id, scope, mode);
    else this.db.prepare(`INSERT INTO memory_focus (node, scope, mode, at, who) VALUES (?,?,?,?,?)
      ON CONFLICT(node, scope) DO UPDATE SET mode = excluded.mode, at = excluded.at, who = excluded.who`).run(n.id, scope, mode, this.now(), who);
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
      edges: one("SELECT COUNT(*) n FROM memory_edges"),
      facts: one(`SELECT COUNT(*) n FROM memory_edges WHERE rel != 'mentioned_in' AND valid_to IS NULL`),
      evidence: one("SELECT COUNT(*) n FROM memory_evidence"),
      byKind: Object.fromEntries(db.prepare("SELECT kind, COUNT(*) n FROM memory_nodes GROUP BY kind ORDER BY n DESC").all().map(r => [r.kind, r.n])),
      byRole: Object.fromEntries(db.prepare("SELECT coalesce(role, 'outside') role, COUNT(*) n FROM memory_nodes GROUP BY 1 ORDER BY n DESC").all().map(r => [r.role, r.n])),
      shortforms: Number(db.prepare("SELECT COUNT(*) n FROM memory_shortforms WHERE precision >= ? AND sessions >= ?").get(T.shortPrecision, T.shortMinSessions)?.n || 0),
      focus: one("SELECT COUNT(*) n FROM memory_focus"),
      taught: one("SELECT COUNT(*) n FROM memory_taught"),
      lastRun: last && { ...last, age: ago(Number(last.at), this.now()) },
    };
  }
}
