// @ts-check
// curator — the only writer of Memory.
//
// Sessions read; the curator writes. That rule is not about locking. A session that writes its
// own memory can convince itself of something false and then cite it back as established fact;
// keeping who observes apart from who records is a correctness property.
//
// It reads Recall's tables (core/recall/schema.js) and never runs a model. Two steps:
//
//   read     every turn not yet seen goes through extract() once, into memory_obs. Incremental
//            by (session, seq): a grown transcript costs its new turns, a rewritten one costs
//            dropping that session's rows and reading it again.
//   derive   the graph is rebuilt from the observations: which names are people and which are
//            organisations, who works where, which domain is whose, which short forms are safe.
//            That needs the whole corpus, and over observations rather than text it is cheap.
//            Derive writes only what changed, so a second pass over the same observations
//            changes nothing at all.
//
// Measured on the prototype: the graph is precise for identity and routing, and did NOT make
// passage retrieval better. So this holds facts, people and links, and leaves search to Recall.

import { sourceOf } from "./iq/fix.js";
import { extract } from "./extract.js";
import { lesson, within, ENDS } from "./teach.js";
import { MIGRATIONS } from "./schema.js";
import { migrate } from "../store/index.js";
import { OPENERS, HEADINGS, TOOL_WORDS, ORG_WORDS, FREE_MAIL, NO_PERSON, registrable, letters, stemOf } from "./lexicon.js";

/** Tunables. Each is a count or share, and each says why it is what it is. */
export const T = {
  // A name nothing corroborates must recur. An unclassified name needs three sessions and one
  // use mid-sentence, since a capital at the start of a sentence is not evidence of anything.
  personSessions: 2, orgSessions: 2, nameSessions: 3, domainSessions: 2,
  // A thing in more than this share of sessions (and at least hubFloor of them) is a hub: the
  // user's own company, a tool. It stays in the graph but gets no vote on who works where.
  hubShare: 0.12, hubFloor: 8,
  // A learned short form is used only at or above this precision, and only once said in two
  // sessions. The prototype measured surnames and invented words near 1.0, common given names
  // near 0.2, and put the line here.
  shortPrecision: 0.6, shortMinSessions: 2,
  // works_at needs a clear winner: at least one full vote, and half as much again as the
  // runner-up. Otherwise it records nothing, because a wrong employer is worse than none.
  voteMin: 1, voteLead: 1.5,
  // An explicit "X at Y" phrasing or an address at Y's domain outweighs co-occurrence.
  cueVote: 3, emailVote: 3,
  // A module saying so outright (ctx.memory.teach) outweighs any number of co-occurrences,
  // but a transcript that says otherwise, again and again, can still outvote it.
  taughtVote: 10,
  // Evidence kept per edge. Enough for memory.why to show where a fact came from without the
  // evidence table outgrowing the graph.
  evidencePerEdge: 6, turnsPerMention: 5,
};

/** Rows read per page before yielding to the event loop. */
const PAGE = 5000;
const parentOf = (id, sess) => sess.get(id)?.parent || (id.includes("/") ? id.split("/")[0] : id);
const yieldNow = () => new Promise(r => setImmediate(r));

export class Curator {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ me?: { domains?: string[], emails?: string[] }, now?: () => number, log?: (m: string) => void, relations?: { prefers?: boolean, decided?: boolean } }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || (() => {});
    // prefers and decided are read only when switched on: off until the eval shows them precise.
    this.relations = { prefers: Boolean(opts.relations?.prefers), decided: Boolean(opts.relations?.decided) };
    const me = opts.me || {};
    this.me = {
      domains: new Set((me.domains || []).map(d => registrable(String(d)))),
      emails: new Set((me.emails || []).map(e => String(e).toLowerCase())),
    };
    for (const e of this.me.emails) this.me.domains.add(registrable(e.split("@")[1] || ""));
    this.me.domains.delete("");
    this.me.stems = new Set([...this.me.domains].map(stemOf));
    migrate(db, "memory", MIGRATIONS);
    /** Highest recall_turns rowid read in this process: the cheap way to find what is new. */
    this.hw = 0;
    /** Bumped whenever derive changes the graph, so readers know to rebuild their caches. */
    this.version = 0;
    /** Which session each recall_turns rowid belongs to, filled by the scans pending() already
     * makes. Short forms are measured with rowid-only full-text queries, which skip Recall's
     * content table: on a 100k-turn corpus that took the measurement from 2.5s to 90ms. */
    this.rowSession = new Map();
    /** Something was reset since the last derive, so the next pass must derive even if it
     * reads nothing. */
    this.dirty = false;
    /** Which rooms each session is in, until the rooms or the sessions change. */
    this.members = null;
    /** The stored rooms, read once until setRooms changes them. */
    this.roomList = null;
    /** Sessions per room, for the membership above. */
    this.bySlug = null;
  }

  /** The durable graph cursor: how many times the drawable graph has changed. */
  updated() { return Number(this.db.prepare("SELECT v FROM memory_meta WHERE k = 'graph_version'").get()?.v || 0); }
  bump() { this.db.prepare("UPDATE memory_meta SET v = v + 1 WHERE k = 'graph_version'").run(); }

  /** Recall's tables may not exist yet (Recall not installed, or not run). That is not an error. */
  hasRecall() {
    const n = this.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('recall_sessions', 'recall_turns')").get();
    return Number(n?.n) === 2;
  }

  /** Nested-safe transaction: a savepoint works inside another module's open transaction too. */
  tx(fn) {
    this.db.exec("SAVEPOINT memory_tx");
    try { const r = fn(); this.db.exec("RELEASE memory_tx"); return r; }
    catch (e) { this.db.exec("ROLLBACK TO memory_tx"); this.db.exec("RELEASE memory_tx"); throw e; }
  }

  /** Forget what was read from one session, so the next pass reads it again from seq 0. */
  reset(session) {
    this.tx(() => {
      for (const t of ["memory_obs", "memory_cues", "memory_curated"]) this.db.prepare(`DELETE FROM ${t} WHERE session = ?`).run(session);
    });
    // A rewritten transcript can reuse rowids, so the rowid map is no longer to be trusted.
    this.rowSession.clear();
    this.members = null;
    this.dirty = true;
  }

  /**
   * Take a fact another module taught. Stored as given (checked, in a fixed shape) and folded
   * into the graph on the next pass. Teaching the same fact twice changes nothing.
   * @param {string} module  the module that taught it, as the loader identified the caller
   * @param {string} kind    one of the kinds that module declares under teaches.memory
   * @returns {{ key: string, changed: boolean }}
   */
  teach(module, kind, fact) {
    const l = lesson(fact);
    const db = this.db;
    if (l.forget) {
      const r = db.prepare("DELETE FROM memory_taught WHERE module = ? AND kind = ? AND key = ?").run(module, kind, l.key);
      if (r.changes) this.dirty = true;
      return { key: l.key, changed: r.changes > 0 };
    }
    const had = db.prepare("SELECT fact FROM memory_taught WHERE module = ? AND kind = ? AND key = ?").get(module, kind, l.key);
    if (had && had.fact === l.stored) return { key: l.key, changed: false };
    db.prepare(`INSERT INTO memory_taught (module, kind, key, fact, at) VALUES (?,?,?,?,?)
      ON CONFLICT DO UPDATE SET fact = excluded.fact, at = excluded.at`).run(module, kind, l.key, l.stored, this.now());
    this.dirty = true;
    return { key: l.key, changed: true };
  }

  /**
   * Read whatever is new, then derive the graph. Yields to the event loop between batches, so
   * a first pass over a large history never stalls the daemon.
   * A pass that read nothing and reset nothing skips the derive, since the graph already
   * matches the observations; force derives anyway.
   * @param {{ full?: boolean, force?: boolean, batch?: number, stopped?: () => boolean }} [opts]
   */
  async curate({ full = false, force = false, batch = 500, stopped = () => false } = {}) {
    const t0 = Date.now();
    // A migration that changed what derive writes asks every existing home to derive once more.
    const again = Number(this.db.prepare("SELECT v FROM memory_meta WHERE k = 'rederive'").get()?.v || 0);
    if (again) { this.db.prepare("DELETE FROM memory_meta WHERE k = 'rederive'").run(); this.dirty = true; }
    if (!this.hasRecall()) {
      // Nothing to read, but taught facts still make a graph.
      let changed = 0;
      if (this.dirty || force) { this.dirty = false; changed = await this.derive(); }
      return { recall: false, sessions: 0, turns: 0, ...this.counts(), changed, ms: Date.now() - t0 };
    }
    const db = this.db;
    // A migration that changed what extraction finds asks for every turn to be read again, once.
    if (Number(db.prepare("SELECT v FROM memory_meta WHERE k = 'reread'").get()?.v || 0)) { db.prepare("DELETE FROM memory_meta WHERE k = 'reread'").run(); full = true; }
    if (full) { this.tx(() => db.exec("DELETE FROM memory_obs; DELETE FROM memory_cues; DELETE FROM memory_curated;")); this.hw = 0; this.rowSession.clear(); }

    const recall = new Map(db.prepare("SELECT id, turns FROM recall_sessions").all().map(r => [String(r.id), Number(r.turns)]));
    const upto = new Map(db.prepare("SELECT session, upto FROM memory_curated").all().map(r => [String(r.session), Number(r.upto)]));
    // Gone from Recall: its turns are gone, so is everything read from them. Shrunk: the
    // transcript was rewritten and its seq values restarted, whether or not we heard about it.
    for (const [s, u] of upto) if (!recall.has(s) || /** @type {number} */ (recall.get(s)) < u) { this.reset(s); upto.delete(s); }

    /** @type {Map<string, number>} session -> first seq still to read */
    const need = new Map();
    for (const [s, n] of recall) if (n > (upto.get(s) || 0)) need.set(s, upto.get(s) || 0);

    let turns = 0;
    if (need.size) {
      const rows = this.pending(need);
      const obs = db.prepare("INSERT INTO memory_obs (session, seq, node, n, initial, ts) VALUES (?,?,?,?,?,?) ON CONFLICT DO UPDATE SET n = excluded.n, initial = excluded.initial, ts = excluded.ts");
      const cue = db.prepare("INSERT OR IGNORE INTO memory_cues (session, seq, rel, a, b, ts) VALUES (?,?,?,?,?,?)");
      const text = db.prepare("SELECT ts, text, role FROM recall_turns WHERE rowid = ?");
      const done = db.prepare("INSERT INTO memory_curated (session, upto, at) VALUES (?,?,?) ON CONFLICT DO UPDATE SET upto = excluded.upto, at = excluded.at");
      let since = 0;
      for (const [session, list] of rows) {
        if (stopped()) break;
        this.tx(() => {
          for (const { rowid, seq } of list) {
            const t = text.get(rowid);
            if (!t) continue;       // deleted since the scan: gone, not an error
            const ts = Number(t.ts) || 0;
            const agg = new Map();
            const { things, cues } = extract(String(t.text), { user: t.role === "user" });
            for (const th of things) {
              const a = agg.get(th.id) || { n: 0, initial: 1 };
              a.n++; if (!th.initial) a.initial = 0;
              agg.set(th.id, a);
            }
            for (const [node, a] of agg) obs.run(session, seq, node, a.n, a.initial, ts);
            for (const c of cues) cue.run(session, seq, c.rel, c.a, c.b, ts);
            turns++;
          }
          done.run(session, recall.get(session), this.now());
        });
        since += list.length;
        if (since >= batch) { since = 0; await yieldNow(); }
      }
      // Sessions Recall counts but whose turns we found none of still move their cursor, or
      // they would be asked for again on every pass.
      for (const s of need.keys()) if (!rows.has(s) && !stopped()) done.run(s, recall.get(s), this.now());
    }
    if (stopped()) return { recall: true, sessions: need.size, turns, ...this.counts(), ms: Date.now() - t0, stopped: true };

    const never = !db.prepare("SELECT 1 FROM memory_runs LIMIT 1").get();
    if (!(turns || full || force || this.dirty || never)) return { recall: true, sessions: need.size, turns, ...this.counts(), changed: 0, ms: Date.now() - t0 };
    this.dirty = false;
    const changed = await this.derive();
    const counts = this.counts();
    const ms = Date.now() - t0;
    db.prepare("INSERT INTO memory_runs (at, sessions, turns, nodes, edges, ms) VALUES (?,?,?,?,?,?)").run(this.now(), need.size, turns, counts.nodes, counts.edges, ms);
    return { recall: true, sessions: need.size, turns, ...counts, changed, ms };
  }

  /**
   * The turns to read, grouped by session in seq order. Tries the rows added since the last
   * pass first (a rowid range, which FTS5 answers cheaply); only when that does not account
   * for everything needed does it scan every turn's (session, seq), which never touches text.
   * @param {Map<string, number>} need
   * @returns {Map<string, { rowid: number, seq: number }[]>}
   */
  pending(need) {
    const db = this.db;
    const collect = rows => {
      const out = new Map();
      let hw = this.hw;
      for (const r of rows) {
        const s = String(r.session), seq = Number(r.seq), rowid = Number(r.rowid);
        if (rowid > hw) hw = rowid;
        this.rowSession.set(rowid, s);
        if (!need.has(s) || seq < /** @type {number} */ (need.get(s))) continue;
        if (!out.has(s)) out.set(s, []);
        out.get(s).push({ rowid, seq });
      }
      for (const l of out.values()) l.sort((a, b) => a.seq - b.seq);
      return { out, hw };
    };
    const recall = new Map(db.prepare("SELECT id, turns FROM recall_sessions").all().map(r => [String(r.id), Number(r.turns)]));
    const complete = out => [...need].every(([s, from]) => (out.get(s)?.length || 0) >= (recall.get(s) || 0) - from);
    if (this.hw > 0) {
      const quick = collect(db.prepare("SELECT rowid, session, seq FROM recall_turns WHERE rowid > ?").all(this.hw));
      if (complete(quick.out)) { this.hw = quick.hw; return quick.out; }
    }
    const all = collect(db.prepare("SELECT rowid, session, seq FROM recall_turns").all());
    this.hw = all.hw;
    return all.out;
  }

  counts() {
    const one = sql => Number(this.db.prepare(sql).get()?.n || 0);
    return { nodes: one("SELECT COUNT(*) n FROM memory_nodes"), edges: one("SELECT COUNT(*) n FROM memory_edges") };
  }

  // ------------------------------------------------------------------ corrections

  /**
   * Record what the user said about a fact, or a merge or split of nodes (ADR 0007, decision 4).
   * Stored as given and applied on the next derive, after the votes, so no transcript can
   * derive it away. Returns the row.
   * @param {{ action: string, src: string, rel?: string|null, dst?: string|null, object?: string|null, at?: number|null, scope?: string, note?: string|null, who?: string|null }} c
   */
  correct(c) {
    if (!ACTIONS.has(c.action)) throw new Error(`action must be one of ${[...ACTIONS].join(", ")}`);
    const r = this.db.prepare(`INSERT INTO memory_corrections (action, src, rel, dst, object, at, scope, note, who, created, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(c.action, c.src, c.rel ?? null, c.dst ?? null, c.object ?? null, c.at ?? null, c.scope || "*",
      c.note == null ? null : String(c.note).slice(0, 160), c.who ?? null, this.now(), sourceOf(c.who));
    this.dirty = true;
    return this.correction(Number(r.lastInsertRowid));
  }

  /** One correction row, or null. */
  correction(id) {
    const r = this.db.prepare("SELECT * FROM memory_corrections WHERE id = ?").get(id);
    return r ? { ...r } : null;
  }

  /** Undo a correction: it stops applying on the next derive and stays listed as undone. */
  uncorrect(id) {
    const r = this.db.prepare("UPDATE memory_corrections SET undone = ? WHERE id = ? AND undone IS NULL").run(this.now(), id);
    if (!r.changes) throw new Error(`no correction ${id} to undo`);
    this.dirty = true;
    return this.correction(id);
  }

  /**
   * Corrections, newest first: every scope, or '*' and one room's.
   * @param {{ scope?: string, all?: boolean }} [opts]  all includes undone ones
   */
  corrections({ scope, all = false } = {}) {
    return this.db.prepare(`SELECT * FROM memory_corrections WHERE (? IS NULL OR scope IN ('*', ?)) AND (? OR undone IS NULL) ORDER BY id DESC`)
      .all(scope ?? null, scope ?? null, all ? 1 : 0).map(r => ({ ...r }));
  }

  // ------------------------------------------------------------------ rooms

  /**
   * The projects Memory computes rooms for, as the projects module lists them. Stored, so a
   * derive is a function of the database alone; a change marks the graph for another pass.
   * @param {{ slug: string, name?: string, folders?: string[], threads?: string[] }[]} list
   * @returns {boolean} whether anything changed
   */
  setRooms(list) {
    const want = new Map();
    for (const p of list || []) {
      if (!p || !p.slug || p.slug === UNFILED || p.slug === "*") continue;
      const folders = [...new Set((p.folders || []).filter(Boolean).map(f => String(f).replace(/\/+$/, "") || "/"))].sort();
      const threads = [...new Set((p.threads || []).filter(Boolean).map(String))].sort();
      want.set(String(p.slug), { name: String(p.name || p.slug), folders: JSON.stringify(folders), threads: JSON.stringify(threads) });
    }
    const have = new Map(this.db.prepare("SELECT slug, name, folders, threads FROM memory_rooms").all().map(r => [String(r.slug), r]));
    let changed = false;
    this.tx(() => {
      const up = this.db.prepare(`INSERT INTO memory_rooms (slug, name, folders, threads) VALUES (?,?,?,?)
        ON CONFLICT(slug) DO UPDATE SET name = excluded.name, folders = excluded.folders, threads = excluded.threads`);
      for (const [slug, w] of want) {
        const h = have.get(slug);
        if (!h || h.name !== w.name || h.folders !== w.folders || h.threads !== w.threads) { up.run(slug, w.name, w.folders, w.threads); changed = true; }
      }
      for (const slug of have.keys()) if (!want.has(slug)) { this.db.prepare("DELETE FROM memory_rooms WHERE slug = ?").run(slug); changed = true; }
    });
    if (changed) { this.dirty = true; this.members = null; this.roomList = null; }
    return changed;
  }

  /** @returns {{ slug: string, name: string, folders: string[], threads: string[] }[]} */
  rooms() {
    if (!this.roomList) this.roomList = this.db.prepare("SELECT slug, name, folders, threads FROM memory_rooms ORDER BY slug").all()
      .map(r => ({ slug: String(r.slug), name: String(r.name), folders: JSON.parse(String(r.folders)), threads: JSON.parse(String(r.threads)) }));
    return this.roomList;
  }

  /**
   * Which rooms each session is in: every project whose folders it ran in or that picked it
   * (a subagent follows its parent), else unfiled. Cached until the rooms or the graph change.
   * @returns {Map<string, string[]>}
   */
  membership() {
    if (this.members) return this.members;
    const rooms = this.rooms();
    const out = new Map();
    if (this.hasRecall()) {
      for (const r of this.db.prepare("SELECT id, cwd, parent FROM recall_sessions").all()) {
        const id = String(r.id);
        const top = r.parent ? String(r.parent) : id.includes("/") ? id.split("/")[0] : id;
        // By folder, the most specific project that holds the session's folder: with acme at
        // ~/Work and northwind at ~/Work/northwind, a session in ~/Work/northwind is northwind's.
        const deep = r.cwd ? deepest(String(r.cwd), rooms) : null;
        const rs = rooms.filter(p => p === deep || p.threads.includes(top) || p.threads.includes(id)).map(p => p.slug);
        out.set(id, rs.length ? rs : [UNFILED]);
      }
    }
    this.members = out;
    return out;
  }

  /** The sessions in one room, cached with the membership they come from. */
  roomSessions(room) {
    const m = this.membership();
    if (this.bySlug?.members !== m) this.bySlug = { members: m, map: new Map() };
    let out = this.bySlug.map.get(room);
    if (!out) {
      out = new Set();
      for (const [s, rs] of m) if (rs.includes(room)) out.add(s);
      this.bySlug.map.set(room, out);
    }
    return out;
  }

  // ------------------------------------------------------------------ derive

  /**
   * Rebuild the graph from the observations and write only the difference. Each room is derived
   * from its own sessions and lessons only, with the same rules; then the main graph ('*') from
   * everything. It yields to the event loop between phases and while measuring short forms, so
   * on a large corpus vyred keeps answering the Enrich hook while it runs. Only the final write
   * is one piece, in one transaction. It never reads the clock for anything it writes as a fact.
   * @returns {Promise<number>} rows changed
   */
  async derive() {
    const db = this.db;
    const now = this.now();
    const recall = this.hasRecall();
    /** @type {Map<string, { parent: string|null, started: number }>} */
    const sess = new Map((recall ? db.prepare("SELECT id, parent, started FROM recall_sessions").all() : [])
      .map(r => [String(r.id), { parent: r.parent ? String(r.parent) : null, started: Number(r.started) || 0 }]));
    this.members = null;
    const member = this.membership();
    const rooms = this.rooms();

    // Observations, grouped by session, paged in key order with a yield between pages.
    /** @type {Map<string, { seq: number, node: string, n: number, initial: number, ts: number }[]>} */
    const obsBy = new Map();
    const turnTs = new Map();
    const obsPage = db.prepare(`SELECT session, seq, node, n, initial, ts FROM memory_obs
      WHERE (session, seq, node) > (?, ?, ?) ORDER BY session, seq, node LIMIT ?`);
    for (let at = ["", -1, ""]; ;) {
      const rows = obsPage.all(at[0], at[1], at[2], PAGE);
      for (const r of rows) {
        const s = String(r.session);
        turnTs.set(s + "\u0000" + r.seq, Number(r.ts));
        if (!obsBy.has(s)) obsBy.set(s, []);
        obsBy.get(s).push({ seq: Number(r.seq), node: String(r.node), n: Number(r.n), initial: Number(r.initial), ts: Number(r.ts) });
      }
      if (rows.length < PAGE) break;
      const l = rows[rows.length - 1];
      at = [String(l.session), Number(l.seq), String(l.node)];
      await yieldNow();
    }
    /** @type {Map<string, { session: string, seq: number, rel: string, a: string, b: string, ts: number }[]>} */
    const cuesBy = new Map();
    for (const r of db.prepare("SELECT session, seq, rel, a, b, ts FROM memory_cues ORDER BY session, seq").all()) {
      const s = String(r.session);
      if (!cuesBy.has(s)) cuesBy.set(s, []);
      cuesBy.get(s).push({ session: s, seq: Number(r.seq), rel: String(r.rel), a: String(r.a), b: String(r.b), ts: Number(r.ts) });
    }
    // What the user said. Merges and splits rename nodes before anything is counted; the rest
    // is applied after the votes, in each scope it names.
    const said = db.prepare("SELECT * FROM memory_corrections WHERE undone IS NULL ORDER BY id").all().map(r => /** @type {Correction} */ ({
      id: Number(r.id), action: String(r.action), src: String(r.src), rel: r.rel == null ? null : String(r.rel), dst: r.dst == null ? null : String(r.dst),
      object: r.object == null ? null : String(r.object), at: r.at == null ? null : Number(r.at), scope: String(r.scope), created: Number(r.created) }));
    const apart = new Set(said.filter(c => c.action === "split" && c.dst).flatMap(c => [`${c.src}\u0000${c.dst}`, `${c.dst}\u0000${c.src}`]));
    const into = new Map();
    for (const c of said) if (c.action === "merge" && c.dst && !apart.has(`${c.src}\u0000${c.dst}`)) into.set(c.src, c.dst);
    /** Where a merge sends a node, following chains, never round a loop. */
    const merged = id => { const seen = new Set(); while (into.has(id) && !seen.has(id)) { seen.add(id); id = /** @type {string} */ (into.get(id)); } return id; };
    const splits = said.filter(c => c.action === "split" && !c.dst && c.object).map(c => ({ node: merged(c.src), room: /** @type {string} */ (c.object) }));
    /** A node as a session in these rooms names it: merged, then split off for a room. */
    const alias = (id, session) => {
      let x = merged(id);
      for (const sp of splits) if (sp.node === x && (member.get(session) || []).includes(sp.room)) { x = `${x}#${sp.room}`; break; }
      return x;
    };
    const facts = said.filter(c => !["merge", "split"].includes(c.action))
      .map(c => ({ ...c, src: merged(c.src), dst: c.dst && merged(c.dst), object: c.object && merged(c.object) }));

    /** @type {Lesson[]} */
    const lessons = [];
    const renamed = r => r && { ...r, id: merged(r.id) };
    for (const r of db.prepare("SELECT module, kind, key, fact, at FROM memory_taught ORDER BY module, kind, key").all()) {
      try {
        const l = lesson(JSON.parse(String(r.fact)));
        const claims = into.size ? l.claims.map(c => ({ ...c, src: /** @type {any} */ (renamed(c.src)), dst: renamed(c.dst) })) : l.claims;
        lessons.push({ module: String(r.module), kind: String(r.kind), key: String(r.key), at: Number(r.at), factAt: l.at, text: l.text, claims, project: l.project });
      } catch { /* a fact that no longer checks out is ignored, not fatal */ }
    }

    // When each lesson was taught, by (module, kind, key), indexed once per derive.
    const lessonAt = new Map(lessons.map(l => [`${l.module}\u0000${l.kind}\u0000${l.key}`, l.at]));
    const common = { sess, obsBy, cuesBy, turnTs, recall, saidBy: new Map(), alias: into.size || splits.length ? alias : null, apart, lessonAt };
    const bySlug = new Map();
    for (const [s, rs] of member) for (const r of rs) { if (!bySlug.has(r)) bySlug.set(r, new Set()); bySlug.get(r).add(s); }
    /** @type {Result[]} */
    const results = [];
    for (const room of [...rooms, { slug: UNFILED, name: "", folders: [], threads: [] }]) {
      const sessions = bySlug.get(room.slug) || new Set();
      // A room sees lessons for everywhere and its own; unfiled only lessons for everywhere.
      const mine = lessons.filter(l => room.slug === UNFILED ? !l.project : !l.project || l.project.some(c => deepest(c, rooms) === room));
      if (!sessions.size && !mine.some(l => l.project)) continue;
      const multi = new Set([...sessions].filter(s => /** @type {string[]} */ (member.get(s)).length > 1));
      results.push(await this.compute({ room: room.slug, names: room.slug === UNFILED ? [] : [room.name], sessions, multi, lessons: mine, others: [],
        said: facts.filter(c => c.scope === "*" || c.scope === room.slug) }, common));
      await yieldNow();
    }
    results.push(await this.compute({ room: "*", names: rooms.map(r => r.name), sessions: null, multi: new Set(), lessons, others: results.slice(),
      said: facts.filter(c => c.scope === "*") }, common));
    conflicts(results);
    return await this.write(results, now);
  }

  /**
   * One scope's beliefs: a room from its own sessions and lessons, or the main graph from all.
   * The same rules everywhere; only what they are fed differs.
   * @param {{ room: string, names: string[], sessions: Set<string>|null, multi: Set<string>, lessons: Lesson[], others: Result[], said?: Correction[] }} scope
   * @param {{ sess: Map<string, { parent: string|null, started: number }>, obsBy: Map<string, any[]>, cuesBy: Map<string, any[]>, turnTs: Map<string, number>, recall: boolean, saidBy: Map<string, string[]>, alias?: ((id: string, session: string) => string)|null, apart?: Set<string>, lessonAt?: Map<string, number> }} common
   * @returns {Promise<Result>}
   */
  async compute(scope, common) {
    const { sess, obsBy, cuesBy, turnTs, recall } = common;
    const lessons = scope.lessons;
    const inScope = s => !scope.sessions || scope.sessions.has(s);
    const S = new Set([...sess.keys()].filter(inScope).map(id => parentOf(id, sess))).size;
    const hubCut = Math.max(T.hubFloor, T.hubShare * S);

    // ---- aggregate observations per node
    /** @type {Map<string, Agg>} */
    const agg = new Map();
    const touch = (id, session, seq, n, initial, ts) => {
      let a = agg.get(id);
      if (!a) {
        const i = id.indexOf(":");
        a = { id, kind: id.slice(0, i), key: id.slice(i + 1), by: new Map(), parents: new Set(), mentions: 0, first: 0, last: 0, mid: false };
        agg.set(id, a);
      }
      let b = a.by.get(session);
      if (!b) { b = { n: 0, turns: [], last: 0 }; a.by.set(session, b); }
      b.n += n;
      b.turns.push({ seq, ts });
      if (ts > b.last) b.last = ts;
      a.parents.add(parentOf(session, sess));
      a.mentions += n;
      if (ts && (!a.first || ts < a.first)) a.first = ts;
      if (ts > a.last) a.last = ts;
      if (!initial) a.mid = true;
    };
    // The anchor rule: a session in several rooms is evidence here only for what this room also
    // has from a session of its own or a lesson, so a shared planning thread cannot carry one
    // client into another's room.
    const anchor = new Set();
    for (const l of lessons) for (const c of l.claims) for (const r of [c.src, c.dst]) if (r) anchor.add(r.id);
    const own = [], shared = [];
    for (const s of scope.sessions || new Set([...obsBy.keys(), ...cuesBy.keys()])) (scope.multi.has(s) ? shared : own).push(s);
    own.sort(); shared.sort();
    const as0 = common.alias || ((id, _s) => id);
    // Two names written with one address are one person ("Dana M. Reyes" and "Dana Reyes" at
    // dana@...), when they share a first or last word and the user has not kept them apart.
    // Counted from this scope's own phrasings, so a room pools only what it says itself.
    const byAddress = new Map();
    for (const s of scope.sessions || cuesBy.keys()) for (const c of cuesBy.get(s) || []) if (c.rel === "email_of" && !NO_PERSON.test(c.b.slice(6).split("@")[0])) {
      const a = as0(c.a, s);
      if (!byAddress.has(c.b)) byAddress.set(c.b, new Set());
      byAddress.get(c.b).add(a);
    }
    const pool = new Map();
    for (const list of byAddress.values()) {
      if (list.size < 2) continue;
      const ns = [...list].sort((x, y) => x.split(" ").length - y.split(" ").length || x.length - y.length || (x < y ? -1 : 1));
      const head = ns[0], hw = labelOf(head.slice(5)).toLowerCase().split(/\s+/);
      for (const other of ns.slice(1)) {
        const ow = labelOf(other.slice(5)).toLowerCase().split(/\s+/);
        if (pool.has(other) || common.apart?.has(`${other}\u0000${head}`)) continue;
        if (hw[0] === ow[0] || hw[hw.length - 1] === ow[ow.length - 1]) pool.set(other, pool.get(head) || head);
      }
    }
    const as = pool.size ? (id, s) => { const x = as0(id, s); return pool.get(x) || x; } : as0;
    for (const s of own) for (const o of obsBy.get(s) || []) { const id = as(o.node, s); touch(id, s, o.seq, o.n, o.initial, o.ts); anchor.add(id); }
    for (const s of shared) for (const o of obsBy.get(s) || []) { const id = as(o.node, s); if (anchor.has(id)) touch(id, s, o.seq, o.n, o.initial, o.ts); }
    const cues = [];
    for (const s of [...own, ...shared].sort()) for (const c0 of cuesBy.get(s) || []) {
      const c = common.alias || pool.size ? { ...c0, a: as(c0.a, s), b: as(c0.b, s) } : c0;
      if (scope.multi.has(s) && !(anchor.has(c.a) && anchor.has(c.b))) continue;
      cues.push(c);
    }
    cues.sort((x, y) => (x.session < y.session ? -1 : x.session > y.session ? 1 : x.seq - y.seq));
    await yieldNow();

    // Taught facts: their things are nodes whatever the thresholds say, since a module asserted
    // them, and each claim remembers which lessons made it.
    const taughtIds = new Set(), hint = new Map();
    /** claim "src|rel|dst" -> lessons, as [module, kind, key] */
    const claimLessons = new Map();
    const nodeLessons = new Map();
    const clientOf = new Set();
    // Each lesson is noted once per claim or node, found by key rather than by scanning the list:
    // a watcher can teach thousands of items about one organisation.
    const noted = new Set();
    const note = (map, k, l) => {
      const id = `${k}\u0001${l.module}\u0000${l.kind}\u0000${l.key}`;
      if (noted.has(id)) return;
      noted.add(id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push([l.module, l.kind, l.key]);
    };
    for (const l of lessons) for (const c of l.claims) {
      for (const r of [c.src, c.dst]) {
        if (!r) continue;
        if (!agg.has(r.id)) {
          const i = r.id.indexOf(":");
          agg.set(r.id, { id: r.id, kind: r.id.slice(0, i), key: r.id.slice(i + 1), by: new Map(), parents: new Set(), mentions: 0, first: l.at, last: l.at, mid: true });
        }
        taughtIds.add(r.id);
        if (r.kind === "person" || r.kind === "org") hint.set(r.id, r.kind);
        note(nodeLessons, r.id, l);
      }
      if (c.rel === "client_of") clientOf.add(c.src.id);
      if (c.rel && c.dst) note(claimLessons, `${c.src.id}|${c.rel}|${c.dst.id}`, l);
      else if (l.text) note(claimLessons, `${c.src.id}|noted|note:${l.module}/${l.kind}/${l.key}`, l);
    }
    const lessonsFor = (src, rel, dst) => claimLessons.get(`${src}|${rel}|${dst}`) || [];
    /** For an edge derived from other facts: the lessons behind its ends, used only when no turn supports it. */
    const lessonsOfEnds = (src, dst) => {
      const seen = new Set();
      return [...(nodeLessons.get(src) || []), ...(nodeLessons.get(dst) || [])].filter(v => { const k = v.join("\u0000"); return !seen.has(k) && Boolean(seen.add(k)); });
    };
    // What the user added, replaced or confirmed names its things outright, like a lesson. In a
    // room only what was said for that room does: a correction for everywhere never brings a
    // thing into a room that does not already know it (see userSaid).
    const said = scope.said || [];
    const inRoom = scope.room !== "*";
    for (const c of said) if (["add", "replace", "confirm"].includes(c.action) && (!inRoom || c.scope !== "*")) {
      const ends = ENDS[/** @type {keyof typeof ENDS} */ (c.rel || "")] || [null, null];
      for (const [id, k] of [[c.src, ends[0]], [c.action === "replace" ? c.object : c.dst, ends[1]]]) {
        if (!id) continue;
        if (!agg.has(id)) { const i = id.indexOf(":"); agg.set(id, { id, kind: id.slice(0, i), key: id.slice(i + 1), by: new Map(), parents: new Set(), mentions: 0, first: c.created, last: c.created, mid: true }); }
        taughtIds.add(id);
        if (k && id.startsWith("name:")) hint.set(id, k);
      }
    }
    /** When a lesson says so: the newest of its lessons, for decay. */
    const lessonSeen = list => { let at = 0; for (const x of list) at = Math.max(at, common.lessonAt?.get(x.join("\u0000")) || 0); return at; };

    // An address implies its domain. The domain's own observations are kept apart from the
    // ones it gets through addresses, so "mentioned in" stays literal.
    const viaEmail = new Map();   // domain id -> email ids
    for (const a of agg.values()) if (a.kind === "email") {
      const d = "domain:" + registrable(a.key.split("@")[1]);
      if (!viaEmail.has(d)) viaEmail.set(d, []);
      viaEmail.get(d).push(a.id);
      if (!agg.has(d)) agg.set(d, { id: d, kind: "domain", key: d.slice(7), by: new Map(), parents: new Set(), mentions: 0, first: 0, last: 0, mid: true });
    }
    const sessionsOf = ids => { const s = new Set(); for (const id of ids) for (const k of agg.get(id)?.by.keys() || []) s.add(k); return s; };
    const domainSessions = d => sessionsOf([d, ...(viaEmail.get(d) || [])]);

    // ---- what each thing is
    const kind = new Map(), role = new Map();
    const domainRole = key => this.me.domains.has(key) ? "own" : FREE_MAIL.has(key) ? "mail" : TOOL_WORDS.has(stemOf(key)) ? "tool" : null;
    for (const a of agg.values()) {
      if (a.kind === "domain") { kind.set(a.id, "domain"); role.set(a.id, domainRole(a.key)); }
      else if (a.kind === "email") {
        kind.set(a.id, "email");
        const dom = registrable(a.key.split("@")[1]);
        role.set(a.id, this.me.emails.has(a.key) || this.me.domains.has(dom) ? "own" : null);
      }
      else if (a.kind === "repo") {
        kind.set(a.id, "repo");
        role.set(a.id, this.me.stems.has(letters(a.key.split("/")[0])) ? "own" : null);
      }
      // The user themself, when a module taught something about them (a preference).
      else if (a.id === ME) { kind.set(a.id, "me"); role.set(a.id, "own"); }
    }
    // Names. A name is an organisation when its last word says so, when a domain spells it, or
    // when someone is said to be "at" it; a person when an address or an "at" phrasing is
    // attached to it. Everything else stays a plain name.
    // A domain spells an organisation by its first label, by that label and a word-like TLD
    // ("harlow.law" is Harlow Law), or by the label less an organisation word at its end
    // ("keelasharchitects.com" is Keel & Ash).
    const domainByStem = new Map();
    const spell = (k, id) => { if (k.length >= 4 && !domainByStem.has(k)) domainByStem.set(k, id); };
    for (const a of agg.values()) if (a.kind === "domain") {
      const stem = stemOf(a.key), tld = a.key.split(".").pop() || "";
      domainByStem.set(stem, a.id);
      if (tld.length >= 3 && !PLAIN_TLDS.has(tld)) spell(stem + tld, a.id);
      for (const w of ORG_WORDS) if (w.length >= 3 && stem.endsWith(w) && stem.length - w.length >= 4) spell(stem.slice(0, -w.length), a.id);
    }
    // One organisation written several ways ("Keel & Ash", "Keel & Ash Architects") is one node
    // when the spellings share a domain. The longest proper spelling names it; the others fold
    // into it before anything is counted, so every fact about it is said once, and are kept as
    // aliases so a prompt using them still finds it. A name the user or a lesson spoke about,
    // or a room's split copy, is left as it is.
    const aliases = new Map();   // canonical id -> alias labels
    {
      const taughtDom = new Map();
      for (const l of lessons) for (const c of l.claims) if (c.rel === "has_domain" && c.dst && c.src.id.startsWith("name:")) taughtDom.set(c.src.id, c.dst.id);
      const spoken = new Set(said.flatMap(c => [c.src, c.dst, c.object]).filter(Boolean));
      const byDom = new Map();
      for (const a of agg.values()) {
        if (a.kind !== "name" || a.id.includes("#") || hint.get(a.id) === "person") continue;
        const dom = taughtDom.get(a.id) || orgStems(a.key).map(s => domainByStem.get(s)).find(Boolean);
        if (!dom) continue;
        if (!byDom.has(dom)) byDom.set(dom, []);
        byDom.get(dom).push(a.id);
      }
      const proper = id => labelOf(id.slice(5)).split(/\s+/).every(w => !/\p{L}/u.test(w[0]) || /\p{Lu}/u.test(w[0]));
      const into = new Map();
      for (const ids of byDom.values()) {
        if (ids.length < 2) continue;
        const [head, ...rest] = [...ids].sort((x, y) => Number(proper(y)) - Number(proper(x)) || y.length - x.length || (x < y ? -1 : 1));
        for (const id of rest) if (!taughtIds.has(id) && !spoken.has(id) && !common.apart?.has(`${id}\u0000${head}`)) into.set(id, head);
      }
      for (const [from, to] of into) {
        const a = /** @type {Agg} */ (agg.get(from)), b = /** @type {Agg} */ (agg.get(to));
        for (const [s, x] of a.by) {
          const y = b.by.get(s);
          if (!y) { b.by.set(s, { n: x.n, turns: [...x.turns], last: x.last }); continue; }
          y.n += x.n;
          y.turns = [...y.turns, ...x.turns.filter(t => !y.turns.some(u => u.seq === t.seq))].sort((p, q) => p.seq - q.seq);
          y.last = Math.max(y.last, x.last);
        }
        for (const p of a.parents) b.parents.add(p);
        b.mentions += a.mentions;
        if (a.first && (!b.first || a.first < b.first)) b.first = a.first;
        b.last = Math.max(b.last, a.last);
        b.mid = b.mid || a.mid;
        agg.delete(from);
        if (!aliases.has(to)) aliases.set(to, []);
        aliases.get(to).push(labelOf(a.key));
      }
      if (into.size) for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (into.has(c.a) || into.has(c.b)) cues[i] = { ...c, a: into.get(c.a) || c.a, b: into.get(c.b) || c.b };
      }
    }
    const cueObj = new Set(cues.filter(c => c.rel === "works_at" || c.rel === "client_of").map(c => c.rel === "works_at" ? c.b : c.a));
    for (const c of cues) if (c.rel === "client_of") clientOf.add(c.a);
    const cueSubj = new Set(cues.filter(c => c.rel === "works_at" || c.rel === "email_of" || c.rel === "has_title").map(c => c.a));
    const names = [...agg.values()].filter(a => a.kind === "name");
    const orgDomain = new Map();  // org id -> domain id
    for (const a of names) {
      const words = labelOf(a.key).split(/\s+/).filter(x => x !== "&");
      const last = words[words.length - 1].toLowerCase();
      const dom = orgStems(a.key).map(s => domainByStem.get(s)).find(Boolean);
      if (dom) orgDomain.set(a.id, dom);
      if (ORG_WORDS.has(last) || dom || cueObj.has(a.id)) kind.set(a.id, "org");
      else if (cueSubj.has(a.id)) kind.set(a.id, "person");
      else kind.set(a.id, "name");
    }
    for (const [id, k] of hint) if (id.startsWith("name:")) kind.set(id, k);
    // Taught relations say what their ends are, and override what the names alone suggest.
    for (const l of lessons) for (const c of l.claims) {
      if (c.rel === "has_domain" && c.dst && c.src.id.startsWith("name:")) orgDomain.set(c.src.id, c.dst.id);
    }

    // A person's address: stated outright ("Dana Reyes (dana@...)"), or an address whose local
    // part spells the name, seen in the same session. Several people matching one address is
    // a tie, and a tie records nothing.
    const hasEmail = new Map();   // email id -> { person, conf, rule }
    for (const c of cues) if (c.rel === "email_of" && agg.has(c.b) && kind.get(c.a) !== "org") {
      hasEmail.set(c.b, { person: c.a, conf: 0.95, rule: "email_cue" });
      kind.set(c.a, "person");
    }
    for (const l of lessons) for (const c of l.claims) if (c.rel === "has_email" && c.dst && c.dst.id.startsWith("email:") && c.src.id.startsWith("name:")) {
      hasEmail.set(c.dst.id, { person: c.src.id, conf: 0.9, rule: "taught" });
      kind.set(c.src.id, "person");
    }
    // Every local part a name could have, once, so matching an address is a lookup.
    const byLocal = new Map();
    for (const p of names) {
      if (kind.get(p.id) === "org") continue;
      const w = labelOf(p.key).toLowerCase().split(/\s+/).map(letters);
      const [f, l] = [w[0], w[w.length - 1]];
      for (const form of new Set([f, f + l, `${f}.${l}`, `${f}_${l}`, f[0] + l, `${f[0]}.${l}`, l])) {
        if (!byLocal.has(form)) byLocal.set(form, []);
        byLocal.get(form).push(p);
      }
    }
    for (const e of agg.values()) {
      if (e.kind !== "email" || hasEmail.has(e.id)) continue;
      const local = e.key.split("@")[0].replace(/\d+$/, "");
      if (NO_PERSON.test(local)) continue;
      const es = new Set(e.by.keys());
      let best = null, bestN = 0, tie = false;
      for (const p of byLocal.get(local) || []) {
        const sharedN = [...p.by.keys()].filter(s => es.has(s)).length;
        if (!sharedN) continue;
        if (sharedN > bestN) { best = p.id; bestN = sharedN; tie = false; } else if (sharedN === bestN) tie = true;
      }
      if (best && !tie) { hasEmail.set(e.id, { person: best, conf: 0.7, rule: "email_local" }); kind.set(best, "person"); }
    }
    const emailsOf = new Map();   // person id -> email ids
    for (const [e, h] of hasEmail) { if (!emailsOf.has(h.person)) emailsOf.set(h.person, []); emailsOf.get(h.person).push(e); }

    // Roles for names: the user's own organisation (a domain in config.me spells it), their
    // own people (an address of theirs), hubs. The hub rule: in the main graph an organisation
    // in at least max(3, rooms/2) rooms is a hub; anywhere, one past the session share is a hub
    // unless a project is named for it. One taught as a client is never a hub, so the user's
    // main client is never the thing Memory hides.
    const named = a => scope.names.some(n => { const x = letters(n); return x.length >= 3 && (orgStems(a.key).includes(x) || (orgDomain.has(a.id) && stemOf(agg.get(orgDomain.get(a.id))?.key || "") === x)); });
    const roomCut = Math.max(3, scope.others.length / 2);
    const roomsWith = id => scope.others.filter(r => r.kept.has(id)).length;
    for (const a of names) {
      const k = kind.get(a.id);
      let r = null;
      if (k === "org" && (orgStems(a.key).some(s => this.me.stems.has(s)) || role.get(orgDomain.get(a.id)) === "own")) r = "own";
      if (k === "person" && (emailsOf.get(a.id) || []).some(e => role.get(e) === "own")) r = "own";
      if (!r && !clientOf.has(a.id)) {
        const share = a.parents.size > hubCut;
        if (k === "org") { if ((scope.room === "*" && roomsWith(a.id) >= roomCut) || (share && !named(a))) r = "hub"; }
        else if (share) r = "hub";
      }
      role.set(a.id, r);
    }
    for (const a of agg.values()) if (a.kind === "domain" && !role.get(a.id) && [...domainSessions(a.id)].length && new Set([...domainSessions(a.id)].map(s => parentOf(s, sess))).size > hubCut) role.set(a.id, "hub");

    // ---- what is kept
    const kept = new Set();
    for (const a of agg.values()) {
      const k = kind.get(a.id), n = a.parents.size;
      if (taughtIds.has(a.id) || k === "email" || k === "repo") kept.add(a.id);
      else if (k === "domain") {
        const ds = new Set([...domainSessions(a.id)].map(s => parentOf(s, sess)));
        if (ds.size >= T.domainSessions || viaEmail.has(a.id) || [...orgDomain.values()].includes(a.id)) kept.add(a.id);
      }
      else if (k === "person") { if (cueSubj.has(a.id) || emailsOf.has(a.id) || (n >= T.personSessions && a.mid)) kept.add(a.id); }
      else if (k === "org") { if (orgDomain.has(a.id) || cueObj.has(a.id) || (n >= T.orgSessions && a.mid)) kept.add(a.id); }
      else if (n >= T.nameSessions && a.mid) kept.add(a.id);
    }

    await yieldNow();
    // ---- edges
    /** @type {Want[]} */
    const want = [];
    const turnsIn = (id, session, max = T.turnsPerMention) => (agg.get(id)?.by.get(session)?.turns || []).slice(0, max).map(t => /** @type {[string, number]} */ ([session, t.seq]));
    const tsOf = (session, seq) => turnTs.get(session + "\u0000" + seq) || 0;
    /** Turns where both appear, same turn first, then same session; capped. */
    const together = (xs, ys) => {
      const out = [], seen = new Set();
      const put = (s, q) => { const k = s + "\u0000" + q; if (!seen.has(k) && out.length < T.evidencePerEdge) { seen.add(k); out.push(/** @type {[string, number]} */ ([s, q])); } };
      const xt = new Map(), yt = new Map();
      for (const id of xs) for (const [s, b] of agg.get(id)?.by || []) for (const t of b.turns) xt.set(s + "\u0000" + t.seq, [s, t.seq]);
      for (const id of ys) for (const [s, b] of agg.get(id)?.by || []) for (const t of b.turns) yt.set(s + "\u0000" + t.seq, [s, t.seq]);
      for (const [k, v] of xt) if (yt.has(k)) put(v[0], v[1]);
      const ys2 = new Set([...yt.values()].map(v => v[0]));
      for (const v of xt.values()) if (ys2.has(v[0])) put(v[0], v[1]);
      for (const v of yt.values()) if (out.some(o => o[0] === v[0])) put(v[0], v[1]);
      return out;
    };
    /** The newest turn in a session both sides appear in, over all of them, not the capped few. */
    const newest = (xs, ys) => {
      const ys2 = sessionsOf(ys);
      let best = 0;
      for (const id of xs) for (const [s, b] of agg.get(id)?.by || []) if (ys2.has(s)) {
        best = Math.max(best, b.last);
        for (const y of ys) best = Math.max(best, agg.get(y)?.by.get(s)?.last || 0);
      }
      return best;
    };
    const lastOf = ids => Math.max(0, ...ids.map(id => agg.get(id)?.last || 0));

    for (const id of kept) {
      const a = /** @type {Agg} */ (agg.get(id));
      for (const [session, b] of a.by) {
        want.push({ src: id, rel: "mentioned_in", dst: "session:" + session, weight: b.n, from: sess.get(session)?.started || 0, conf: 0.8, ev: turnsIn(id, session), seen: b.last, rule: "mention" });
      }
    }
    // Edges derived from other facts carry lessons only when no turn supports them, so a
    // lesson is never shown as the reason for something the transcripts already say.
    const derived = (w) => {
      const own = lessonsFor(w.src, w.rel, w.dst);
      w.lessons = own.length ? own : w.ev.length ? [] : lessonsOfEnds(w.src, w.dst);
      if (!w.ev.length && w.lessons.length) { w.origin = "taught"; w.seen = Math.max(w.seen || 0, lessonSeen(w.lessons)); }
      want.push(w);
    };
    for (const [d, emails] of viaEmail) for (const e of emails) if (kept.has(e) && kept.has(d)) {
      derived({ src: e, rel: "at_domain", dst: d, weight: 1, from: 0, conf: 1, ev: [...agg.get(e).by.keys()].flatMap(s => turnsIn(e, s, 2)).slice(0, T.evidencePerEdge), seen: lastOf([e]), rule: "address" });
    }
    for (const [o, d] of orgDomain) if (kept.has(o) && kept.has(d)) {
      const ev = together([o], [d, ...(viaEmail.get(d) || [])]);
      const first = [...agg.get(o).by.keys()][0];
      derived({ src: o, rel: "has_domain", dst: d, weight: 1, from: 0, conf: 0.9, ev: ev.length ? ev : first ? turnsIn(o, first, 3) : [],
        seen: newest([o], [d, ...(viaEmail.get(d) || [])]) || lastOf([o]), rule: "domain_spelling" });
    }
    for (const [e, h] of hasEmail) if (kept.has(e) && kept.has(h.person)) {
      const cueEv = cues.filter(c => c.rel === "email_of" && c.a === h.person && c.b === e).map(c => /** @type {[string, number]} */ ([c.session, c.seq]));
      const ev = [...cueEv, ...together([h.person], [e])].filter((v, i, all) => all.findIndex(w => w[0] === v[0] && w[1] === v[1]) === i).slice(0, T.evidencePerEdge);
      derived({ src: h.person, rel: "has_email", dst: e, weight: 1, from: 0, conf: h.conf, ev, seen: newest([h.person], [e]), rule: h.rule });
    }
    for (const id of kept) {
      if (kind.get(id) !== "repo") continue;
      const owner = letters(agg.get(id).key.split("/")[0]);
      for (const [o, d] of [...kept].filter(x => kind.get(x) === "org").map(o => [o, orgDomain.get(o)])) {
        if (orgStems(agg.get(o).key).includes(owner) || (d && stemOf(agg.get(d).key) === owner)) {
          const first = [...agg.get(id).by.keys()][0];
          derived({ src: id, rel: "owned_by", dst: o, weight: 1, from: 0, conf: 0.8, ev: together([id], [o]).length ? together([id], [o]) : first ? turnsIn(id, first, 3) : [],
            seen: newest([id], [o]) || lastOf([id]), rule: "repo_owner" });
        }
      }
    }
    // Taught relations the rules above did not already produce, and taught notes.
    const have = new Set(want.map(w => `${w.src}|${w.rel}|${w.dst}`));
    for (const l of lessons) for (const c of l.claims) {
      const rel = c.rel && c.dst ? c.rel : l.text ? "noted" : null;
      if (!rel || rel === "works_at") continue;
      const dst = c.rel && c.dst ? c.dst.id : `note:${l.module}/${l.kind}/${l.key}`;
      const k = `${c.src.id}|${rel}|${dst}`;
      if (have.has(k) || !kept.has(c.src.id) || (c.dst && !kept.has(dst))) continue;
      have.add(k);
      const ls = lessonsFor(c.src.id, rel, dst);
      const ev = c.dst ? together([c.src.id], [dst]) : [];
      want.push({ src: c.src.id, rel, dst, weight: 1, from: l.factAt || 0, conf: 0.9, ev, lessons: ls, seen: Math.max(lessonSeen(ls), c.dst ? newest([c.src.id], [dst]) : 0), origin: ev.length ? "extract" : "taught", rule: "taught" });
    }

    // ---- short forms, measured
    const cluster = id => {
      const out = [id];
      const d = orgDomain.get(id);
      if (d) out.push(d, ...(viaEmail.get(d) || []));
      out.push(...(emailsOf.get(id) || []));
      return out;
    };
    // One thing written several ways ("Harlow Legal", "Harlow Legal Group") is one identity when
    // the spellings share a domain. Short forms are measured per identity, not per spelling.
    const identity = id => orgDomain.get(id) || id;
    const forms = !recall ? [] : await this.shortForms([...kept].filter(id => ["org", "person"].includes(kind.get(id)) && role.get(id) !== "hub"), agg, cluster, sess, identity, inScope, common.saidBy);

    // ---- who works where, by vote
    // Only outside organisations vote, and a session votes by focus: its share of the org
    // mentions in that session, so a planning session naming every client gives each a
    // fraction while a session about one client gives it a whole vote. Raw counts rewarded
    // hubs; in the prototype one session that named every client as an example came near the
    // top for all of them.
    const orgs = [...kept].filter(id => kind.get(id) === "org" && !["tool", "hub"].includes(/** @type {string} */ (role.get(id))));
    /** @type {Map<string, Map<string, number>>} session -> org -> presence */
    const presence = new Map();
    const add = (s, o, v) => { if (!presence.has(s)) presence.set(s, new Map()); const m = presence.get(s); m.set(o, (m.get(o) || 0) + v); };
    for (const o of orgs) {
      for (const id of cluster(o)) for (const [s, b] of agg.get(id)?.by || []) add(s, o, b.n);
      for (const f of forms.filter(f => f.node === o && f.usable)) for (const s of f.sessions) add(s, o, f.precision);
    }
    /** @type {Map<string, Work>} */
    const worksAt = new Map();
    // The user's word on who works where: an org they called wrong gets no vote; one they said
    // ended gets votes only from turns after it ended.
    const wrongAt = new Set(said.filter(c => c.action === "wrong" && c.rel === "works_at").map(c => `${c.src}\u0000${c.dst}`));
    const endedAt = new Map(said.filter(c => ["ended", "replace"].includes(c.action) && c.rel === "works_at").map(c => [`${c.src}\u0000${c.dst}`, c.at ?? c.created]));
    for (const p of [...kept].filter(id => kind.get(id) === "person" && role.get(id) !== "hub")) {
      const mineOwn = role.get(p) === "own";
      const eligible = new Set(orgs.filter(o => (role.get(o) === "own") === mineOwn));
      const votes = new Map();
      // Sessions that put this person clearly at an org: it held most of that session's org
      // mentions, or a phrasing or an address said so. The edge starts at the earliest of these,
      // not at a planning session that merely named them both.
      const strong = new Map();
      const mark = (o, ss) => { if (!strong.has(o)) strong.set(o, new Set()); for (const s of ss) strong.get(o).add(s); };
      const why = new Map();   // org -> the rule that gave it most
      const credit = (o, rule, v) => { const w = why.get(o) || {}; w[rule] = (w[rule] || 0) + v; why.set(o, w); };
      const psessions = sessionsOf([p, ...(emailsOf.get(p) || [])]);
      const ended = o => endedAt.get(`${p}\u0000${o}`);
      const after = (o, s) => { const at = ended(o); return at === undefined || Math.max(0, ...[p, ...(emailsOf.get(p) || [])].map(x => agg.get(x)?.by.get(s)?.last || 0)) > at; };
      for (const s of psessions) {
        const m = presence.get(s);
        if (!m) continue;
        let total = 0;
        for (const [o, v] of m) if (eligible.has(o)) total += v;
        for (const [o, v] of m) if (eligible.has(o) && after(o, s)) {
          votes.set(o, (votes.get(o) || 0) + v / total);
          credit(o, "focus", v / total);
          if (v / total > 0.5) mark(o, [s]);
        }
      }
      const cueSessions = new Map();
      for (const c of cues) if (c.rel === "works_at" && c.a === p && eligible.has(c.b) && (ended(c.b) === undefined || c.ts > /** @type {number} */ (ended(c.b)))) { if (!cueSessions.has(c.b)) cueSessions.set(c.b, new Set()); cueSessions.get(c.b).add(c.session); }
      for (const [o, ss] of cueSessions) { votes.set(o, (votes.get(o) || 0) + T.cueVote * ss.size); credit(o, "cue", T.cueVote * ss.size); mark(o, ss); }
      for (const e of emailsOf.get(p) || []) {
        const d = "domain:" + registrable(agg.get(e).key.split("@")[1]);
        for (const o of eligible) if (orgDomain.get(o) === d && ended(o) === undefined) { votes.set(o, (votes.get(o) || 0) + T.emailVote); credit(o, "email", T.emailVote); mark(o, agg.get(e).by.keys()); }
      }
      const taughtAt = new Map();
      for (const l of lessons) for (const c of l.claims) if (c.rel === "works_at" && c.src.id === p && c.dst && kept.has(c.dst.id) && ended(c.dst.id) === undefined) {
        votes.set(c.dst.id, (votes.get(c.dst.id) || 0) + T.taughtVote);
        credit(c.dst.id, "taught", T.taughtVote);
        if (l.factAt) taughtAt.set(c.dst.id, Math.min(taughtAt.get(c.dst.id) ?? Infinity, l.factAt));
      }
      for (const o of [...votes.keys()]) if (wrongAt.has(`${p}\u0000${o}`)) votes.delete(o);
      const ranked = [...votes].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      const [first, second] = ranked;
      if (!first || first[1] < T.voteMin || (second && first[1] < T.voteLead * second[1])) continue;
      const sum = ranked.reduce((n, r) => n + r[1], 0);
      const o = first[0];
      const cueEv = cues.filter(c => c.rel === "works_at" && c.a === p && c.b === o).map(c => /** @type {[string, number]} */ ([c.session, c.seq]));
      const since = ended(o);
      const ev = [...cueEv, ...together([p, ...(emailsOf.get(p) || [])], cluster(o))].filter((v, i, all) => all.findIndex(w => w[0] === v[0] && w[1] === v[1]) === i)
        .filter(([s, q]) => since === undefined || tsOf(s, q) > since).slice(0, T.evidencePerEdge);
      const taught = lessonsFor(p, "works_at", o);
      if (!ev.length && !taught.length) continue;
      const clear = ev.filter(([s]) => strong.get(o)?.has(s));
      const times = [...(clear.length ? clear : ev).map(([s, q]) => tsOf(s, q) || sess.get(s)?.started || 0), ...(taughtAt.has(o) ? [taughtAt.get(o)] : [])];
      const from = times.length ? Math.min(...times) : 0;
      const rule = Object.entries(why.get(o) || {}).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0] || "focus";
      worksAt.set(p, { org: o, conf: Number(Math.min(1, first[1] / sum).toFixed(2)), from, weight: Number(first[1].toFixed(3)), ev, lessons: taught,
        seen: Math.max(newest([p, ...(emailsOf.get(p) || [])], cluster(o)), lessonSeen(taught)), rule, origin: ev.length ? "extract" : "taught", conflict: 0 });
    }

    // ---- more relations: titles, clients, repos for an org, deadlines, and (when switched on)
    // preferences and decisions. All are this scope's own, from its own turns.
    /** A value at the far end of a relation (a title, a date, a preference): a node of its own. */
    const value = (id, ts = 0) => {
      if (!agg.has(id)) { const i = id.indexOf(":"); agg.set(id, { id, kind: id.slice(0, i), key: id.slice(i + 1), by: new Map(), parents: new Set(), mentions: 0, first: ts, last: ts, mid: true }); }
      const a = agg.get(id);
      if (ts && (!a.first || ts < a.first)) a.first = ts;
      if (ts > a.last) a.last = ts;
      kind.set(id, id.slice(0, id.indexOf(":")));
      role.set(id, null);
      kept.add(id);
      return id;
    };
    // Who a short reference means here: a name, or a short form this scope measured as usable.
    const usable = new Map(forms.filter(f => f.usable).map(f => [f.form, f.node]));
    const refer = a => a.startsWith("ref:") ? usable.get(a.slice(4)) ?? null : a;
    /** Sessions and turns behind a set of cues, as evidence. */
    const cueEv = list => list.map(c => /** @type {[string, number]} */ ([c.session, c.seq])).filter((v, i, all) => all.findIndex(w => w[0] === v[0] && w[1] === v[1]) === i).slice(0, T.evidencePerEdge);
    const group = rel => {
      const out = new Map();
      for (const c of cues) if (c.rel === rel) { const a = c.a === ME ? value(ME, c.ts) : refer(c.a); if (!a || !kept.has(a)) continue; const k = a + "\u0000" + c.b; if (!out.has(k)) out.set(k, { a, b: c.b, list: [] }); out.get(k).list.push(c); }
      return [...out.values()];
    };
    // has_title: the appositive, one title per person, the one said in most sessions (then newest).
    const titles = new Map();
    for (const g of group("has_title")) {
      if (kind.get(g.a) !== "person") continue;
      const n = new Set(g.list.map(c => c.session)).size, last = Math.max(...g.list.map(c => c.ts));
      const t = titles.get(g.a);
      if (!t || n > t.n || (n === t.n && last > t.last)) titles.set(g.a, { ...g, n, last });
    }
    for (const t of titles.values()) want.push({ src: t.a, rel: "has_title", dst: value(t.b, t.last), weight: t.n, from: Math.min(...t.list.map(c => c.ts)), conf: 0.9, ev: cueEv(t.list), seen: t.last, rule: "appositive" });
    // client_of: the user said so ("Northwind Bakery is a new client").
    for (const g of group("client_of")) if (kind.get(g.a) === "org" && role.get(g.a) !== "own") {
      want.push({ src: g.a, rel: "client_of", dst: value(ME), weight: g.list.length, from: Math.min(...g.list.map(c => c.ts)), conf: 0.9, ev: cueEv(g.list), seen: Math.max(...g.list.map(c => c.ts)), rule: "client_said" });
    }
    // repo_for: a repo named after an organisation's short form, the two together in 2+ sessions.
    for (const id of kept) if (kind.get(id) === "repo") {
      const words = agg.get(id).key.split("/")[1].toLowerCase().split(/[-_.]+/);
      for (const o of orgs) {
        if (role.get(o) === "own") continue;
        const first = labelOf(agg.get(o).key).split(/\s+/)[0].toLowerCase();
        const short = first.length >= 3 && !ORG_WORDS.has(first) && !OPENERS.has(first) ? letters(first) : null;
        if (!words.some(w => (short && w === short) || orgStems(agg.get(o).key).includes(w))) continue;
        const both = [...sessionsOf([id])].filter(s => sessionsOf(cluster(o)).has(s));
        if (new Set(both.map(s => parentOf(s, sess))).size < 2) continue;
        want.push({ src: id, rel: "repo_for", dst: o, weight: both.length, from: 0, conf: 0.8, ev: together([id], cluster(o)), seen: newest([id], cluster(o)), rule: "repo_name" });
      }
    }
    // deadline: "due / launches / ships (on / by) <date>", the date read against the turn's own time.
    for (const g of group("deadline")) {
      if (!["org", "person"].includes(/** @type {string} */ (kind.get(g.a))) || ["hub", "tool"].includes(/** @type {string} */ (role.get(g.a)))) continue;
      const byDate = new Map();
      for (const c of g.list) { const d = dateOf(c.b.slice(5), c.ts); if (d) { if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(c); } }
      for (const [d, list] of byDate) want.push({ src: g.a, rel: "deadline", dst: value("date:" + d, Math.max(...list.map(c => c.ts))), weight: list.length,
        from: Math.min(...list.map(c => c.ts)), conf: 0.9, ev: cueEv(list), seen: Math.max(...list.map(c => c.ts)), rule: "deadline_said" });
    }
    for (const rel of /** @type {("prefers"|"decided")[]} */ (["prefers", "decided"])) if (this.relations[rel]) for (const g of group(rel)) {
      if (rel === "prefers" && kind.get(g.a) !== "person") continue;
      want.push({ src: rel === "decided" ? value(ME) : g.a, rel, dst: value(g.b, Math.max(...g.list.map(c => c.ts))), weight: g.list.length,
        from: Math.min(...g.list.map(c => c.ts)), conf: 0.8, ev: cueEv(g.list), seen: Math.max(...g.list.map(c => c.ts)), rule: rel + "_said" });
    }
    // An address matches a person across sessions when exactly one kept person has its local
    // part and works at the address's domain.
    for (const e of agg.values()) {
      if (e.kind !== "email" || hasEmail.has(e.id) || !kept.has(e.id)) continue;
      const local = e.key.split("@")[0].replace(/\d+$/, "");
      if (NO_PERSON.test(local)) continue;
      const d = "domain:" + registrable(e.key.split("@")[1]);
      const who = [...new Set((byLocal.get(local) || []).map(p => p.id))].filter(p => kept.has(p) && orgDomain.get(worksAt.get(p)?.org || "") === d);
      if (who.length !== 1) continue;
      hasEmail.set(e.id, { person: who[0], conf: 0.75, rule: "email_local_org" });
      if (!emailsOf.has(who[0])) emailsOf.set(who[0], []);
      emailsOf.get(who[0]).push(e.id);
      derived({ src: who[0], rel: "has_email", dst: e.id, weight: 1, from: 0, conf: 0.75, ev: [...e.by.keys()].flatMap(s => turnsIn(e.id, s, 2)).slice(0, T.evidencePerEdge), seen: lastOf([e.id]), rule: "email_local_org" });
    }

    // Facts the user called wrong here: no row keeps them, whatever evidence is left.
    const wrong = new Set(said.filter(c => c.action === "wrong").map(c => `${c.src}\u0000${c.rel}\u0000${c.dst}`));
    const out = { room: scope.room, agg, kept, kind, role, want, worksAt, forms, together, cluster, emailsOf, lessonsFor, wrong, aliases, value, inRoom };
    if (said.length) this.userSaid(out, said, tsOf);
    return out;
  }

  /**
   * Apply what the user said, after the votes. The user outranks a lesson and a lesson outranks
   * a vote; a transcript that later disagrees with the user raises a conflict, never a change.
   * @param {Result} r
   * @param {Correction[]} said
   */
  userSaid(r, said, tsOf) {
    const k = (s, rel, d) => `${s}\u0000${rel}\u0000${d}`;
    const userRow = (c, dst, from) => ({ src: c.src, rel: /** @type {string} */ (c.rel), dst, weight: 1, from, conf: 1, ev: [], lessons: [], seen: c.created, origin: "user", rule: "user", conflict: 0 });
    for (const c of said) {
      if (!c.rel) continue;
      const at = c.at ?? c.created;
      // A correction for everywhere, read in a room (docs/adr/0007-intelligence.md, decision 1):
      // wrong, ended and confirm touch only rows this room derived itself; add and replace only
      // when the room already keeps the subject, and the new object is one it keeps or a value
      // the correction names (a title, a date). So it never carries a thing into a room whose
      // own sessions do not know it.
      const wide = r.inRoom && c.scope === "*";
      /** May the new object be written here? A value (a title, a date) is made when it may. */
      const reach = id => {
        if (!r.kept.has(c.src)) return false;
        if (VALUE.test(id)) { r.value(id, c.created); return true; }
        return r.kept.has(id);
      };
      if (c.rel === "works_at") {
        const w = r.worksAt.get(c.src);
        if (c.action === "ended" || c.action === "replace") {
          // History: the old belief, closed when the user says it ended.
          if (r.kept.has(c.src) && c.dst && r.kept.has(c.dst)) {
            const ev = r.together([c.src, ...(r.emailsOf.get(c.src) || [])], r.cluster(c.dst)).filter(([s, q]) => tsOf(s, q) <= at);
            const times = ev.map(([s, q]) => tsOf(s, q)).filter(Boolean);
            const from = times.length ? Math.min(...times) : 0;
            // Everywhere's word closes what this room's own turns said, never a row it never had.
            if (ev.length || !wide) r.want.push({ src: c.src, rel: "works_at", dst: c.dst, weight: 1, from, to: Math.max(from, at), conf: 1, ev, lessons: [], seen: Math.max(0, ...times),
              origin: ev.length ? "extract" : "user", rule: ev.length ? "vote" : "user", conflict: 0 });
          }
        }
        const says = c.action === "replace" ? c.object : ["confirm", "add"].includes(c.action) ? c.dst : null;
        if (says && r.kept.has(c.src) && r.kept.has(says) && !(wide && c.action === "confirm" && w?.org !== says)) {
          const agrees = w && w.org === says;
          // A vote for someone else, newer than what the user said, is a question for them.
          const conflict = w && !agrees && (w.seen || 0) > c.created ? 1 : 0;
          if (agrees && c.action === "confirm") r.worksAt.set(c.src, { ...w, conf: 1, origin: "confirmed", conflict: 0, keep: new Set() });
          else r.worksAt.set(c.src, { ...userRow(c, says, c.action === "replace" ? at : agrees ? /** @type {Work} */ (w).from : 0), org: says,
            ev: agrees ? /** @type {Work} */ (w).ev : [], origin: c.action === "confirm" ? "confirmed" : "user", conflict });
        }
        continue;
      }
      const hit = r.want.filter(w => k(w.src, w.rel, w.dst) === k(c.src, c.rel, c.dst || ""));
      if (c.action === "wrong") { r.want = r.want.filter(w => !hit.includes(w)); continue; }
      if (c.action === "ended" || c.action === "replace") for (const w of hit) {
        const before = w.ev.filter(([s, q]) => tsOf(s, q) <= at), later = w.ev.filter(([s, q]) => tsOf(s, q) > at);
        if (later.length) r.want.push({ ...w, from: Math.min(...later.map(([s, q]) => tsOf(s, q))), ev: later, to: null });
        Object.assign(w, { to: Math.max(w.from, at), ev: before.length ? before : w.ev });
      }
      if (c.action === "confirm") {
        if (hit.length) for (const w of hit) Object.assign(w, { conf: 1, origin: "confirmed" });
        else if (!wide && c.dst && r.kept.has(c.src) && r.kept.has(c.dst)) r.want.push({ ...userRow(c, c.dst, 0), origin: "confirmed" });
      }
      const says = c.action === "replace" ? c.object : c.action === "add" ? c.dst : null;
      if (says && reach(says)) {
        const same = r.want.find(w => k(w.src, w.rel, w.dst) === k(c.src, c.rel, says) && w.to == null);
        if (same) Object.assign(same, { conf: 1, origin: "user", rule: "user" });
        else r.want.push(userRow(c, says, c.action === "replace" ? at : 0));
      }
    }
  }

  /**
   * Measure each candidate short form: of the sessions whose text says the form, the share that
   * are about the thing (the thing itself, its domain or its addresses appear). Read from
   * Recall's full-text index, so it counts the word wherever it was said, not only where the
   * extractor noticed it. In a room only that room's sessions count, so a form measured
   * elsewhere never decides what a word means here.
   */
  async shortForms(ids, agg, cluster, sess, identity = id => id, inScope = () => true, saidBy = new Map()) {
    const q = this.db.prepare("SELECT rowid FROM recall_turns WHERE recall_turns MATCH ?");
    const one = this.db.prepare("SELECT session FROM recall_turns WHERE rowid = ?");
    if (!this.rowSession.size) {
      // Paged by rowid with a yield between pages: one pass over 100k turns in one piece held
      // the event loop for a quarter of a second.
      const page = this.db.prepare("SELECT rowid, session FROM recall_turns WHERE rowid > ? ORDER BY rowid LIMIT ?");
      for (let after = 0; ;) {
        const rows = page.all(after, PAGE);
        for (const r of rows) this.rowSession.set(Number(r.rowid), String(r.session));
        if (rows.length < PAGE) break;
        after = Number(rows[rows.length - 1].rowid);
        await yieldNow();
      }
    }
    const sessionOf = rowid => {
      let s = this.rowSession.get(rowid);
      if (s === undefined) { s = one.get(rowid)?.session; if (s !== undefined) this.rowSession.set(rowid, (s = String(s))); }
      return s;
    };
    const measured = [];
    let asked = 0;
    /** form -> identity -> the spellings of that identity starting with the form */
    const claims = new Map();
    for (const id of ids) {
      const words = labelOf(agg.get(id).key).split(/\s+/).filter(w => w !== "&");
      if (words.length < 2) continue;
      const form = words[0].toLowerCase();
      if (form.length < 3 || OPENERS.has(form) || HEADINGS.has(form) || TOOL_WORDS.has(form) || ORG_WORDS.has(form)) continue;
      if (!claims.has(form)) claims.set(form, new Map());
      const byIdentity = claims.get(form);
      const who = identity(id);
      if (!byIdentity.has(who)) byIdentity.set(who, []);
      byIdentity.get(who).push(id);
    }
    const aboutOf = list => { const out = new Set(); for (const id of list) for (const c of cluster(id)) for (const s of agg.get(c)?.by.keys() || []) out.add(parentOf(s, sess)); return out; };
    for (const [form, byIdentity] of claims) {
      let all = saidBy.get(form);
      if (!all) {
        try { all = [...new Set(q.all(`"${form.replace(/"/g, "")}"`).map(r => sessionOf(Number(r.rowid))).filter(Boolean))]; } catch { all = []; }
        saidBy.set(form, all);
        if (++asked % 50 === 0) await yieldNow();
      }
      const said = all.filter(inScope);
      if (!said.length) continue;
      const saidParents = new Set(said.map(s => parentOf(s, sess)));
      const precisionOf = about => Number(([...saidParents].filter(s => about.has(s)).length / saidParents.size).toFixed(3));
      for (const list of byIdentity.values()) {
        // Measured on the whole identity and credited to its most-seen spelling; the other
        // spellings keep their own, lower, measure, so they never win the form. On a real
        // corpus one firm written three ways measured 0.57, 0.29 and 0.21 apart, and none of
        // them could be called by the word everyone used for it.
        const lead = [...list].sort((a, b) => agg.get(b).parents.size - agg.get(a).parents.size || (a < b ? -1 : 1))[0];
        for (const id of list) {
          const precision = id === lead ? precisionOf(aboutOf(list)) : precisionOf(aboutOf([id]));
          measured.push({ node: id, form, precision, count: saidParents.size, sessions: said, usable: false });
        }
      }
    }
    // Two things can claim one word; only the best claimant may vote with it, so the weaker
    // reading never dilutes the stronger one. Every claimant is stored; reads pick the one in view.
    const best = new Map();
    for (const m of measured) if (m.precision >= T.shortPrecision && m.count >= T.shortMinSessions) {
      const b = best.get(m.form);
      if (!b || m.precision > b.precision || (m.precision === b.precision && (m.count > b.count || (m.count === b.count && m.node < b.node)))) best.set(m.form, m);
    }
    for (const m of best.values()) m.usable = true;
    return measured;
  }

  /**
   * Write every scope's derived graph as a difference against what is stored: one transaction
   * per scope, with a yield between, so the event loop is never held for more than one scope's
   * rows. Each room is consistent on its own; the cursor moves once, at the end.
   * @param {Result[]} results
   */
  async write(results, now) {
    let changed = 0;
    for (const r of results) {
      changed += this.tx(() => this.writeScope(r, now));
      await yieldNow();
    }
    // Rooms that are gone keep nothing.
    changed += this.tx(() => {
      const keep = results.map(r => r.room);
      const marks = keep.map(() => "?").join(",");
      const db = this.db;
      let n = 0;
      n += db.prepare(`DELETE FROM memory_evidence WHERE edge IN (SELECT id FROM memory_edges WHERE room NOT IN (${marks}))`).run(...keep).changes;
      n += db.prepare(`DELETE FROM memory_lessons WHERE edge IN (SELECT id FROM memory_edges WHERE room NOT IN (${marks}))`).run(...keep).changes;
      n += db.prepare(`DELETE FROM memory_edges WHERE room NOT IN (${marks})`).run(...keep).changes;
      n += db.prepare(`DELETE FROM memory_room_nodes WHERE room NOT IN (${marks})`).run(...keep).changes;
      n += db.prepare(`DELETE FROM memory_shortforms WHERE room NOT IN (${marks})`).run(...keep).changes;
      n += db.prepare(`DELETE FROM memory_aliases WHERE room NOT IN (${marks})`).run(...keep).changes;
      return Number(n);
    });
    if (changed) { this.version++; this.bump(); }
    return changed;
  }

  /**
   * One scope's rows as a difference: its nodes, edges, evidence, lessons and short forms.
   * @param {Result} r
   * @returns {number} rows changed
   */
  writeScope(r, now) {
    const db = this.db;
    const room = r.room, star = room === "*";
    let changed = 0;
    // What this scope has now, read before anything changes, so evidence and lessons of edges
    // deleted below are found and removed too.
    const haveEv = new Set(db.prepare("SELECT v.edge, v.session, v.seq FROM memory_evidence v JOIN memory_edges e ON e.id = v.edge WHERE e.room = ?").all(room)
      .map(x => `${x.edge}\u0000${x.session}\u0000${x.seq}`));
    const haveL = new Set(db.prepare("SELECT l.edge, l.module, l.kind, l.key FROM memory_lessons l JOIN memory_edges e ON e.id = l.edge WHERE e.room = ?").all(room)
      .map(x => [x.edge, x.module, x.kind, x.key].join("\u0000")));

    // nodes: the main graph's in memory_nodes, a room's in memory_room_nodes
    const have = new Map((star ? db.prepare("SELECT * FROM memory_nodes").all() : db.prepare("SELECT * FROM memory_room_nodes WHERE room = ?").all(room)).map(x => [String(x.id), x]));
    const upNode = star ? db.prepare(`INSERT INTO memory_nodes (id, kind, key, label, role, sessions, mentions, first_seen, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, key=excluded.key, label=excluded.label,
      role=excluded.role, sessions=excluded.sessions, mentions=excluded.mentions, first_seen=excluded.first_seen, last_seen=excluded.last_seen`)
      : db.prepare(`INSERT INTO memory_room_nodes (room, id, kind, key, label, role, sessions, mentions, first_seen, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(room, id) DO UPDATE SET kind=excluded.kind, key=excluded.key, label=excluded.label,
      role=excluded.role, sessions=excluded.sessions, mentions=excluded.mentions, first_seen=excluded.first_seen, last_seen=excluded.last_seen`);
    for (const id of r.kept) {
      const a = r.agg.get(id);
      const row = [id, r.kind.get(id), a.key, labelOf(a.key), r.role.get(id) ?? null, a.parents.size || new Set([...a.by.keys()]).size, a.mentions, a.first || null, a.last || null];
      const h = have.get(id);
      if (!h || h.kind !== row[1] || h.label !== row[3] || (h.role ?? null) !== row[4] || Number(h.sessions) !== row[5] || Number(h.mentions) !== row[6] || (h.first_seen ?? null) !== row[7] || (h.last_seen ?? null) !== row[8]) {
        if (star) upNode.run(...row); else upNode.run(room, ...row);
        changed++;
      }
    }
    const delNode = star ? db.prepare("DELETE FROM memory_nodes WHERE id = ?") : db.prepare("DELETE FROM memory_room_nodes WHERE room = ? AND id = ?");
    for (const id of have.keys()) if (!r.kept.has(id)) { if (star) delNode.run(id); else delNode.run(room, id); changed++; }

    // edges
    const edges = db.prepare("SELECT id, room, src, rel, dst, weight, valid_from, valid_to, confidence, seen, conflict, origin, rule FROM memory_edges WHERE room = ?").all(room)
      .map(x => ({ id: Number(x.id), room: String(x.room), src: String(x.src), rel: String(x.rel), dst: String(x.dst), weight: Number(x.weight), from: Number(x.valid_from),
        to: x.valid_to == null ? null : Number(x.valid_to), conf: Number(x.confidence), seen: x.seen == null ? null : Number(x.seen), conflict: Number(x.conflict), origin: String(x.origin), rule: x.rule == null ? null : String(x.rule) }));
    const ins = db.prepare("INSERT INTO memory_edges (room, src, rel, dst, weight, valid_from, valid_to, observed, confidence, seen, conflict, origin, rule) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const upd = db.prepare("UPDATE memory_edges SET weight = ?, confidence = ?, valid_to = ?, valid_from = ?, observed = ?, seen = ?, conflict = ?, origin = ?, rule = ? WHERE id = ?");
    const del = db.prepare("DELETE FROM memory_edges WHERE id = ?");
    /** @type {Map<number, [string, number][]>} */
    const evidence = new Map();
    /** @type {Map<number, string[][]>} */
    const taught = new Map();
    const wanted = new Set();
    const key = (s, rl, d, f) => `${s}\u0000${rl}\u0000${d}\u0000${f}`;
    const same = (e, w, to) => e.weight === w.weight && e.conf === w.conf && e.to === to && e.seen === (w.seen || null) && e.conflict === (w.conflict || 0)
      && e.origin === (w.origin || "extract") && e.rule === (w.rule ?? null);
    const put = (w, to = null) => ins.run(room, w.src, w.rel, w.dst, w.weight, w.from, to, now, w.conf, w.seen || null, w.conflict || 0, w.origin || "extract", w.rule ?? null);
    const set = (id, w, to, from) => upd.run(w.weight, w.conf, to, from, now, w.seen || null, w.conflict || 0, w.origin || "extract", w.rule ?? null, id);
    const byKey = new Map(edges.map(e => [key(e.src, e.rel, e.dst, e.from), e]));
    for (let w of r.want) {
      if (!w.ev.length && !w.lessons?.length && w.origin !== "user") continue;
      const k = key(w.src, w.rel, w.dst, w.from);
      const to = w.to ?? null;
      let e = byKey.get(k);
      // A belief the user ended closes the row that held it, whatever start the vote gave it.
      if (!e && to !== null) e = edges.find(x => x.src === w.src && x.rel === w.rel && x.dst === w.dst && (x.to === null || x.to === to) && !wanted.has(x.id));
      if (e && e.from !== w.from && to !== null) w = { ...w, from: e.from };
      if (!e) {
        const id = Number(put(w, to).lastInsertRowid);
        e = { id, room, src: w.src, rel: w.rel, dst: w.dst, weight: w.weight, from: w.from, to, conf: w.conf, seen: w.seen || null, conflict: w.conflict || 0, origin: w.origin || "extract", rule: w.rule ?? null };
        byKey.set(k, e); changed++;
      } else if (!same(e, w, to)) {
        set(e.id, w, to, w.from); changed++;
        Object.assign(e, { weight: w.weight, conf: w.conf, to, from: w.from, seen: w.seen || null, conflict: w.conflict || 0, origin: w.origin || "extract", rule: w.rule ?? null });
      }
      wanted.add(e.id);
      evidence.set(e.id, w.ev);
      taught.set(e.id, w.lessons || []);
    }

    // works_at is bi-temporal. When the vote moves a person to another organisation, the old
    // edge is CLOSED at the point the new one starts, never deleted: what was believed in
    // June stays readable in September. A closed edge lives as long as its evidence does.
    const works = edges.filter(e => e.rel === "works_at");
    const people = new Set([...works.map(e => e.src), ...r.worksAt.keys()]);
    for (const p of people) {
      const mine = works.filter(e => e.src === p);
      const w = r.worksAt.get(p);
      if (w) {
        const x = { ...w, src: p, rel: "works_at", dst: w.org };
        const open = mine.find(e => e.to === null && e.dst === w.org);
        for (const e of mine) if (e.to === null && e.dst !== w.org && !w.keep?.has(e.dst)) {
          e.to = Math.max(e.from, w.from);
          upd.run(e.weight, e.conf, e.to, e.from, now, e.seen, e.conflict, e.origin, e.rule, e.id); changed++;
        }
        const to = w.to ?? null;
        if (open && to === null) {
          if (open.from !== w.from || !same(open, x, null)) {
            const clash = byKey.get(key(p, "works_at", w.org, w.from));
            if (clash && clash.id !== open.id) { del.run(clash.id); changed++; }
            set(open.id, x, null, w.from); changed++;
            Object.assign(open, { from: w.from, weight: w.weight, conf: w.conf });
          }
          wanted.add(open.id); evidence.set(open.id, w.ev); taught.set(open.id, w.lessons);
        } else {
          const hit = byKey.get(key(p, "works_at", w.org, w.from));
          let id;
          if (hit) { if (!same(hit, x, to)) { set(hit.id, x, to, w.from); changed++; } id = hit.id; }
          else { id = Number(put(x, to).lastInsertRowid); changed++; }
          wanted.add(id); evidence.set(id, w.ev); taught.set(id, w.lessons);
        }
      }
      // Every other works_at edge of this person stays while the turns or lessons behind it exist.
      for (const e of mine) {
        if (wanted.has(e.id) || !r.kept.has(e.src) || !r.kept.has(e.dst) || r.wrong?.has(`${e.src}\u0000works_at\u0000${e.dst}`)) continue;
        const ev = r.together([e.src, ...(r.emailsOf.get(e.src) || [])], r.cluster(e.dst));
        const ls = r.lessonsFor(e.src, "works_at", e.dst);
        if (ev.length || ls.length) { wanted.add(e.id); evidence.set(e.id, ev); taught.set(e.id, ls); }
      }
    }
    for (const e of edges) if (!wanted.has(e.id)) { del.run(e.id); changed++; }

    // evidence, as a difference
    const wantEv = new Set();
    for (const [id, list] of evidence) for (const [s, q] of list) wantEv.add(`${id}\u0000${s}\u0000${q}`);
    const insEv = db.prepare("INSERT INTO memory_evidence (edge, session, seq) VALUES (?,?,?)");
    const delEv = db.prepare("DELETE FROM memory_evidence WHERE edge = ? AND session = ? AND seq = ?");
    for (const k of wantEv) if (!haveEv.has(k)) { const [e, s, q] = k.split("\u0000"); insEv.run(Number(e), s, Number(q)); changed++; }
    for (const k of haveEv) if (!wantEv.has(k)) { const [e, s, q] = k.split("\u0000"); delEv.run(Number(e), s, Number(q)); changed++; }

    // lessons, the same way
    const wantL = new Set();
    for (const [id, list] of taught) for (const l of list) wantL.add([id, ...l].join("\u0000"));
    const insL = db.prepare("INSERT INTO memory_lessons (edge, module, kind, key) VALUES (?,?,?,?)");
    const delL = db.prepare("DELETE FROM memory_lessons WHERE edge = ? AND module = ? AND kind = ? AND key = ?");
    for (const k of wantL) if (!haveL.has(k)) { const [e, m, kd, ky] = k.split("\u0000"); insL.run(Number(e), m, kd, ky); changed++; }
    for (const k of haveL) if (!wantL.has(k)) { const [e, m, kd, ky] = k.split("\u0000"); delL.run(Number(e), m, kd, ky); changed++; }

    // short forms, every claimant
    const haveSf = new Map(db.prepare("SELECT node, form, precision, sessions FROM memory_shortforms WHERE room = ?").all(room).map(x => [`${x.node}\u0000${x.form}`, x]));
    const upSf = db.prepare("INSERT INTO memory_shortforms (room, node, form, precision, sessions, at) VALUES (?,?,?,?,?,?) ON CONFLICT DO UPDATE SET precision = excluded.precision, sessions = excluded.sessions, at = excluded.at");
    const wantSf = new Set();
    for (const f of r.forms) {
      const k = `${f.node}\u0000${f.form}`;
      wantSf.add(k);
      const h = haveSf.get(k);
      if (!h || Number(h.precision) !== f.precision || Number(h.sessions) !== f.count) { upSf.run(room, f.node, f.form, f.precision, f.count, now); changed++; }
    }
    const delSf = db.prepare("DELETE FROM memory_shortforms WHERE room = ? AND node = ? AND form = ?");
    for (const [k] of haveSf) if (!wantSf.has(k)) { const [nd, f] = k.split("\u0000"); delSf.run(room, nd, f); changed++; }

    // aliases: the other spellings of a kept node
    const haveAl = new Set(db.prepare("SELECT node, alias FROM memory_aliases WHERE room = ?").all(room).map(x => `${x.node}\u0000${x.alias}`));
    const wantAl = new Set();
    for (const [nd, list] of r.aliases || []) if (r.kept.has(nd)) for (const al of list) wantAl.add(`${nd}\u0000${al}`);
    const insAl = db.prepare("INSERT INTO memory_aliases (room, node, alias) VALUES (?,?,?)");
    const delAl = db.prepare("DELETE FROM memory_aliases WHERE room = ? AND node = ? AND alias = ?");
    for (const k of wantAl) if (!haveAl.has(k)) { const [nd, al] = k.split("\u0000"); insAl.run(room, nd, al); changed++; }
    for (const k of haveAl) if (!wantAl.has(k)) { const [nd, al] = k.split("\u0000"); delAl.run(room, nd, al); changed++; }
    return changed;
  }
}

/**
 * The project whose folder holds this one most closely, or null. Projects can nest: a folder
 * belongs to the deepest project folder above it, and a tie goes to the first by slug.
 * @template {{ folders: string[] }} P
 * @param {string} cwd
 * @param {P[]} rooms
 * @returns {P|null}
 */
export function deepest(cwd, rooms) {
  let best = null, depth = -1;
  for (const p of rooms) for (const f of p.folders) {
    const base = String(f).replace(/\/+$/, "");
    if (base.length > depth && within(cwd, [base])) { best = p; depth = base.length; }
  }
  return best;
}

/** The room for sessions in no project. */
export const UNFILED = "unfiled";

/** The user, as the far end of client_of and the near end of decided. */
export const ME = "me:you";

/** Top-level domains that are not words, so "harlowlegal.com" is never "harlowlegalcom". */
const PLAIN_TLDS = new Set(["com", "org", "net", "info", "biz", "xyz", "app", "dev", "run", "page", "site", "online", "cloud", "tech", "email"]);

const MONTH = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/**
 * A date as a person wrote it ("18 september", "oct 2", "friday", "2026-10-02"), read against
 * the turn's own time: a weekday is the next one on or after that day, a day and month without
 * a year is the next one no more than a week back. Never the clock. Null when unsure.
 * @returns {string|null} YYYY-MM-DD
 */
export function dateOf(text, ts) {
  const t = String(text).toLowerCase().trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return t;
  if (!ts) return null;
  const at = new Date(ts);
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const w = WEEKDAY.indexOf(t);
  if (w >= 0) return new Date(day + ((w - at.getUTCDay() + 7) % 7) * 86_400_000).toISOString().slice(0, 10);
  const m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$/.exec(t) || /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  if (!m) return null;
  const [dd, mon] = /^\d/.test(m[1]) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
  const mi = MONTH.indexOf(mon.slice(0, 3));
  if (mi < 0 || dd < 1 || dd > 31) return null;
  let y = at.getUTCFullYear();
  if (Date.UTC(y, mi, dd) < day - 7 * 86_400_000) y++;
  const d = new Date(Date.UTC(y, mi, dd));
  return d.getUTCMonth() === mi ? d.toISOString().slice(0, 10) : null;
}

/** Values at the far end of a relation: a correction for everywhere may name one in a room. */
const VALUE = /^(title|date|note|pref|decision):/;

/** What memory.correct can say, plus the merge and split of nodes. */
export const ACTIONS = new Set(["wrong", "ended", "replace", "confirm", "add", "merge", "split"]);

/** Origins derive never overrides. */
const USER = new Set(["user", "confirmed"]);

/** How long apart two rooms' beliefs may be seen and still be a question for the user, not an update. */
const CONFLICT_MS = 90 * 86_400_000;

/**
 * Where rooms disagree about who works where. When two rooms' winners differ and were seen
 * within 90 days of each other, the main graph's row is marked conflict and the Deck asks
 * "Same person?". Otherwise the newer room's winner is the main graph's, and the older closes
 * in '*' while it stays open in its own room.
 * @param {Result[]} results  the rooms, then '*' last
 */
function conflicts(results) {
  const star = results[results.length - 1];
  const rooms = results.slice(0, -1);
  const people = new Set(rooms.flatMap(r => [...r.worksAt.keys()]));
  for (const p of people) {
    // What the user said or confirmed is never closed by derive, in a room or in '*'.
    const wins = rooms.map(r => r.worksAt.get(p)).filter(Boolean).filter(w => !USER.has(w.origin));
    if (new Set(wins.map(w => w.org)).size < 2) continue;
    const s = star.worksAt.get(p);
    if (s && USER.has(s.origin)) continue;
    wins.sort((a, b) => (b.seen || 0) - (a.seen || 0) || (a.org < b.org ? -1 : 1));
    const top = wins[0];
    const close = wins.some(w => w.org !== top.org && Math.abs((top.seen || 0) - (w.seen || 0)) <= CONFLICT_MS);
    if (close) { if (s) s.conflict = 1; else star.worksAt.set(p, { ...top, conflict: 1 }); continue; }
    if (!s || s.org !== top.org) star.worksAt.set(p, { ...top, conflict: 0 });
    // The older beliefs, closed where the newer one starts, so the main graph keeps the history
    // even on a first pass.
    const done = new Set([top.org]);
    for (const w of wins) if (!done.has(w.org)) {
      done.add(w.org);
      star.want.push({ src: p, rel: "works_at", dst: w.org, weight: w.weight, from: w.from, to: Math.max(w.from, top.from), conf: w.conf,
        ev: w.ev, lessons: w.lessons, seen: w.seen, origin: w.origin, rule: w.rule, conflict: 0 });
    }
  }
}

/** A node's label: its key, without the room a split gave it ("Dana Reyes#bramble"). */
const labelOf = key => key.replace(/#[a-z0-9-]+$/, "");

/** Letters of a name, and of the name without its last word when that says it is an organisation. */
function orgStems(label) {
  const w = label.replace(/#[a-z0-9-]+$/, "").split(/\s+/).filter(x => x !== "&");
  const out = [letters(w.join(" "))];
  if (w.length > 1 && ORG_WORDS.has(w[w.length - 1].toLowerCase())) out.push(letters(w.slice(0, -1).join(" ")));
  return out.filter(s => s.length >= 4);
}

/**
 * @typedef {{ id: string, kind: string, key: string, by: Map<string, { n: number, turns: { seq: number, ts: number }[], last: number }>, parents: Set<string>, mentions: number, first: number, last: number, mid: boolean }} Agg
 * @typedef {{ module: string, kind: string, key: string, at: number, factAt: number, text: string|null, claims: import("./teach.js").Claim[], project: string[]|null }} Lesson
 * @typedef {{ src: string, rel: string, dst: string, weight: number, from: number, to?: number|null, conf: number, ev: [string, number][], lessons?: string[][], seen?: number, conflict?: number, origin?: string, rule?: string }} Want
 * @typedef {{ org: string, conf: number, from: number, to?: number|null, weight: number, ev: [string, number][], lessons: string[][], seen: number, rule: string, origin: string, conflict: number, keep?: Set<string> }} Work
 * @typedef {{ id: number, action: string, src: string, rel: string|null, dst: string|null, object: string|null, at: number|null, scope: string, created: number }} Correction
 * @typedef {{ room: string, wrong?: Set<string>, agg: Map<string, Agg>, kept: Set<string>, kind: Map<string, string>, role: Map<string, string|null>, want: Want[], worksAt: Map<string, Work>, forms: any[], together: Function, cluster: Function, emailsOf: Map<string, string[]>, lessonsFor: Function, aliases?: Map<string, string[]>, value: (id: string, ts?: number) => string, inRoom: boolean }} Result
 */
