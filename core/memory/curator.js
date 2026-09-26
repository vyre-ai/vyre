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

import { extract } from "./extract.js";
import { lesson } from "./teach.js";
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
   * @param {{ me?: { domains?: string[], emails?: string[] }, now?: () => number, log?: (m: string) => void }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || (() => {});
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
  }

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
    if (!this.hasRecall()) {
      // Nothing to read, but taught facts still make a graph.
      let changed = 0;
      if (this.dirty || force) { this.dirty = false; changed = await this.derive(); }
      return { recall: false, sessions: 0, turns: 0, ...this.counts(), changed, ms: Date.now() - t0 };
    }
    const db = this.db;
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
      const text = db.prepare("SELECT ts, text FROM recall_turns WHERE rowid = ?");
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
            const { things, cues } = extract(String(t.text));
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

  // ------------------------------------------------------------------ derive

  /**
   * Rebuild the graph from the observations and write only the difference. It yields to the
   * event loop between phases and while measuring short forms, so on a large corpus (about
   * two seconds over 100k turns) vyred keeps answering the Enrich hook while it runs. Only the
   * final write is one piece, in one transaction.
   * @returns {Promise<number>} rows changed
   */
  async derive() {
    const db = this.db;
    const now = this.now();
    /** @type {Map<string, { parent: string|null, started: number }>} */
    const recall = this.hasRecall();
    const sess = new Map((recall ? db.prepare("SELECT id, parent, started FROM recall_sessions").all() : [])
      .map(r => [String(r.id), { parent: r.parent ? String(r.parent) : null, started: Number(r.started) || 0 }]));
    const S = new Set([...sess.keys()].map(id => parentOf(id, sess))).size;
    const hubCut = Math.max(T.hubFloor, T.hubShare * S);

    // ---- aggregate observations per node
    /** @typedef {{ id: string, kind: string, key: string, by: Map<string, { n: number, turns: { seq: number, ts: number }[] }>, parents: Set<string>, mentions: number, first: number, last: number, mid: boolean }} Agg */
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
      if (!b) { b = { n: 0, turns: [] }; a.by.set(session, b); }
      b.n += n;
      b.turns.push({ seq, ts });
      a.parents.add(parentOf(session, sess));
      a.mentions += n;
      if (ts && (!a.first || ts < a.first)) a.first = ts;
      if (ts > a.last) a.last = ts;
      if (!initial) a.mid = true;
    };
    const turnTs = new Map();
    // Paged in key order, yielding between pages, for the same reason as the rowid map.
    const obsPage = db.prepare(`SELECT session, seq, node, n, initial, ts FROM memory_obs
      WHERE (session, seq, node) > (?, ?, ?) ORDER BY session, seq, node LIMIT ?`);
    for (let at = ["", -1, ""]; ;) {
      const rows = obsPage.all(at[0], at[1], at[2], PAGE);
      for (const r of rows) {
        turnTs.set(r.session + "\u0000" + r.seq, Number(r.ts));
        touch(String(r.node), String(r.session), Number(r.seq), Number(r.n), Number(r.initial), Number(r.ts));
      }
      if (rows.length < PAGE) break;
      const l = rows[rows.length - 1];
      at = [String(l.session), Number(l.seq), String(l.node)];
      await yieldNow();
    }
    const cues = db.prepare("SELECT session, seq, rel, a, b, ts FROM memory_cues ORDER BY session, seq").all()
      .map(r => ({ session: String(r.session), seq: Number(r.seq), rel: String(r.rel), a: String(r.a), b: String(r.b), ts: Number(r.ts) }));

    // Taught facts: their things are nodes whatever the thresholds say, since a module asserted
    // them, and each claim remembers which lessons made it.
    /** @type {{ module: string, kind: string, key: string, at: number, factAt: number, text: string|null, claims: import("./teach.js").Claim[] }[]} */
    const lessons = [];
    for (const r of db.prepare("SELECT module, kind, key, fact, at FROM memory_taught ORDER BY module, kind, key").all()) {
      try {
        const l = lesson(JSON.parse(String(r.fact)));
        lessons.push({ module: String(r.module), kind: String(r.kind), key: String(r.key), at: Number(r.at), factAt: l.at, text: l.text, claims: l.claims });
      } catch { /* a fact that no longer checks out is ignored, not fatal */ }
    }
    const taughtIds = new Set(), hint = new Map();
    /** claim "src|rel|dst" -> lessons, as [module, kind, key] */
    const claimLessons = new Map();
    const nodeLessons = new Map();
    const note = (map, k, l) => { if (!map.has(k)) map.set(k, []); const list = map.get(k); if (!list.some(x => x[0] === l.module && x[1] === l.kind && x[2] === l.key)) list.push([l.module, l.kind, l.key]); };
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
      if (c.rel && c.dst) note(claimLessons, `${c.src.id}|${c.rel}|${c.dst.id}`, l);
      else if (l.text) note(claimLessons, `${c.src.id}|noted|note:${l.module}/${l.kind}/${l.key}`, l);
    }
    const lessonsFor = (src, rel, dst) => claimLessons.get(`${src}|${rel}|${dst}`) || [];
    /** For an edge derived from other facts: the lessons behind its ends, used only when no turn supports it. */
    const lessonsOfEnds = (src, dst) => [...(nodeLessons.get(src) || []), ...(nodeLessons.get(dst) || [])]
      .filter((v, i, all) => all.findIndex(w => w.join("\u0000") === v.join("\u0000")) === i);

    await yieldNow();
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
    }
    // Names. A name is an organisation when its last word says so, when a domain spells it, or
    // when someone is said to be "at" it; a person when an address or an "at" phrasing is
    // attached to it. Everything else stays a plain name.
    const domainByStem = new Map();
    for (const a of agg.values()) if (a.kind === "domain") domainByStem.set(stemOf(a.key), a.id);
    const orgStems = label => {
      const w = label.split(/\s+/).filter(x => x !== "&");
      const out = [letters(label)];
      if (w.length > 1 && ORG_WORDS.has(w[w.length - 1].toLowerCase())) out.push(letters(w.slice(0, -1).join(" ")));
      return out.filter(s => s.length >= 4);
    };
    const cueObj = new Set(cues.filter(c => c.rel === "works_at").map(c => c.b));
    const cueSubj = new Set(cues.map(c => c.a));
    const names = [...agg.values()].filter(a => a.kind === "name");
    const orgDomain = new Map();  // org id -> domain id
    for (const a of names) {
      const words = a.key.split(/\s+/).filter(x => x !== "&");
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
    const hasEmail = new Map();   // email id -> { person, conf, cue }
    for (const c of cues) if (c.rel === "email_of" && agg.has(c.b) && kind.get(c.a) !== "org") {
      hasEmail.set(c.b, { person: c.a, conf: 0.95 });
      kind.set(c.a, "person");
    }
    for (const l of lessons) for (const c of l.claims) if (c.rel === "has_email" && c.dst && c.dst.id.startsWith("email:") && c.src.id.startsWith("name:")) {
      hasEmail.set(c.dst.id, { person: c.src.id, conf: 0.9 });
      kind.set(c.src.id, "person");
    }
    // Every local part a name could have, once, so matching an address is a lookup.
    const byLocal = new Map();
    for (const p of names) {
      if (kind.get(p.id) === "org") continue;
      const w = p.key.toLowerCase().split(/\s+/).map(letters);
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
        const shared = [...p.by.keys()].filter(s => es.has(s)).length;
        if (!shared) continue;
        if (shared > bestN) { best = p.id; bestN = shared; tie = false; } else if (shared === bestN) tie = true;
      }
      if (best && !tie) { hasEmail.set(e.id, { person: best, conf: 0.7 }); kind.set(best, "person"); }
    }
    const emailsOf = new Map();   // person id -> email ids
    for (const [e, h] of hasEmail) { if (!emailsOf.has(h.person)) emailsOf.set(h.person, []); emailsOf.get(h.person).push(e); }

    // Roles for names: the user's own organisation (a domain in config.me spells it), their
    // own people (an address of theirs), hubs.
    for (const a of names) {
      const k = kind.get(a.id);
      let r = null;
      if (k === "org" && (orgStems(a.key).some(s => this.me.stems.has(s)) || role.get(orgDomain.get(a.id)) === "own")) r = "own";
      if (k === "person" && (emailsOf.get(a.id) || []).some(e => role.get(e) === "own")) r = "own";
      if (!r && a.parents.size > hubCut) r = "hub";
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
    /** @typedef {{ src: string, rel: string, dst: string, weight: number, from: number, conf: number, ev: [string, number][], lessons?: string[][] }} Want */
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

    for (const id of kept) {
      const a = /** @type {Agg} */ (agg.get(id));
      for (const [session, b] of a.by) {
        want.push({ src: id, rel: "mentioned_in", dst: "session:" + session, weight: b.n, from: sess.get(session)?.started || 0, conf: 0.8, ev: turnsIn(id, session) });
      }
    }
    // Edges derived from other facts carry lessons only when no turn supports them, so a
    // lesson is never shown as the reason for something the transcripts already say.
    const derived = (w) => { const own = lessonsFor(w.src, w.rel, w.dst); w.lessons = own.length ? own : w.ev.length ? [] : lessonsOfEnds(w.src, w.dst); want.push(w); };
    for (const [d, emails] of viaEmail) for (const e of emails) if (kept.has(e) && kept.has(d)) {
      derived({ src: e, rel: "at_domain", dst: d, weight: 1, from: 0, conf: 1, ev: [...agg.get(e).by.keys()].flatMap(s => turnsIn(e, s, 2)).slice(0, T.evidencePerEdge) });
    }
    for (const [o, d] of orgDomain) if (kept.has(o) && kept.has(d)) {
      const ev = together([o], [d, ...(viaEmail.get(d) || [])]);
      const first = [...agg.get(o).by.keys()][0];
      derived({ src: o, rel: "has_domain", dst: d, weight: 1, from: 0, conf: 0.9, ev: ev.length ? ev : first ? turnsIn(o, first, 3) : [] });
    }
    for (const [e, h] of hasEmail) if (kept.has(e) && kept.has(h.person)) {
      const cueEv = cues.filter(c => c.rel === "email_of" && c.a === h.person && c.b === e).map(c => /** @type {[string, number]} */ ([c.session, c.seq]));
      const ev = [...cueEv, ...together([h.person], [e])].filter((v, i, all) => all.findIndex(w => w[0] === v[0] && w[1] === v[1]) === i).slice(0, T.evidencePerEdge);
      derived({ src: h.person, rel: "has_email", dst: e, weight: 1, from: 0, conf: h.conf, ev });
    }
    for (const id of kept) {
      if (kind.get(id) !== "repo") continue;
      const owner = letters(agg.get(id).key.split("/")[0]);
      for (const [o, d] of [...kept].filter(x => kind.get(x) === "org").map(o => [o, orgDomain.get(o)])) {
        if (orgStems(agg.get(o).key).includes(owner) || (d && stemOf(agg.get(d).key) === owner)) {
          const first = [...agg.get(id).by.keys()][0];
          derived({ src: id, rel: "owned_by", dst: o, weight: 1, from: 0, conf: 0.8, ev: together([id], [o]).length ? together([id], [o]) : first ? turnsIn(id, first, 3) : [] });
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
      want.push({ src: c.src.id, rel, dst, weight: 1, from: l.factAt || 0, conf: 0.9, ev: c.dst ? together([c.src.id], [dst]) : [], lessons: lessonsFor(c.src.id, rel, dst) });
    }

    // ---- short forms, measured
    const cluster = id => {
      const out = [id];
      const d = orgDomain.get(id);
      if (d) out.push(d, ...(viaEmail.get(d) || []));
      out.push(...(emailsOf.get(id) || []));
      return out;
    };
    const forms = !recall ? [] : await this.shortForms([...kept].filter(id => ["org", "person"].includes(kind.get(id)) && role.get(id) !== "hub"), agg, cluster, sess);

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
    const worksAt = new Map();   // person -> { org, conf, from, ev }
    for (const p of [...kept].filter(id => kind.get(id) === "person" && role.get(id) !== "hub")) {
      const own = role.get(p) === "own";
      const eligible = new Set(orgs.filter(o => (role.get(o) === "own") === own));
      const votes = new Map();
      // Sessions that put this person clearly at an org: it held most of that session's org
      // mentions, or a phrasing or an address said so. The edge starts at the earliest of these,
      // not at a planning session that merely named them both.
      const strong = new Map();
      const mark = (o, ss) => { if (!strong.has(o)) strong.set(o, new Set()); for (const s of ss) strong.get(o).add(s); };
      const psessions = sessionsOf([p, ...(emailsOf.get(p) || [])]);
      for (const s of psessions) {
        const m = presence.get(s);
        if (!m) continue;
        let total = 0;
        for (const [o, v] of m) if (eligible.has(o)) total += v;
        for (const [o, v] of m) if (eligible.has(o)) {
          votes.set(o, (votes.get(o) || 0) + v / total);
          if (v / total > 0.5) mark(o, [s]);
        }
      }
      const cueSessions = new Map();
      for (const c of cues) if (c.rel === "works_at" && c.a === p && eligible.has(c.b)) { if (!cueSessions.has(c.b)) cueSessions.set(c.b, new Set()); cueSessions.get(c.b).add(c.session); }
      for (const [o, ss] of cueSessions) { votes.set(o, (votes.get(o) || 0) + T.cueVote * ss.size); mark(o, ss); }
      for (const e of emailsOf.get(p) || []) {
        const d = "domain:" + registrable(agg.get(e).key.split("@")[1]);
        for (const o of eligible) if (orgDomain.get(o) === d) { votes.set(o, (votes.get(o) || 0) + T.emailVote); mark(o, agg.get(e).by.keys()); }
      }
      const taughtAt = new Map();
      for (const l of lessons) for (const c of l.claims) if (c.rel === "works_at" && c.src.id === p && c.dst && kept.has(c.dst.id)) {
        votes.set(c.dst.id, (votes.get(c.dst.id) || 0) + T.taughtVote);
        if (l.factAt) taughtAt.set(c.dst.id, Math.min(taughtAt.get(c.dst.id) ?? Infinity, l.factAt));
      }
      const ranked = [...votes].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      const [first, second] = ranked;
      if (!first || first[1] < T.voteMin || (second && first[1] < T.voteLead * second[1])) continue;
      const sum = ranked.reduce((n, r) => n + r[1], 0);
      const o = first[0];
      const cueEv = cues.filter(c => c.rel === "works_at" && c.a === p && c.b === o).map(c => /** @type {[string, number]} */ ([c.session, c.seq]));
      const ev = [...cueEv, ...together([p, ...(emailsOf.get(p) || [])], cluster(o))].filter((v, i, all) => all.findIndex(w => w[0] === v[0] && w[1] === v[1]) === i).slice(0, T.evidencePerEdge);
      const taught = lessonsFor(p, "works_at", o);
      if (!ev.length && !taught.length) continue;
      const clear = ev.filter(([s]) => strong.get(o)?.has(s));
      const times = [...(clear.length ? clear : ev).map(([s, q]) => tsOf(s, q) || sess.get(s)?.started || 0), ...(taughtAt.has(o) ? [taughtAt.get(o)] : [])];
      const from = times.length ? Math.min(...times) : 0;
      worksAt.set(p, { org: o, conf: Number(Math.min(1, first[1] / sum).toFixed(2)), from, weight: Number(first[1].toFixed(3)), ev, lessons: taught });
    }

    return this.write({ agg, kept, kind, role, want, worksAt, forms, together, cluster, emailsOf, lessonsFor, now });
  }

  /**
   * Measure each candidate short form: of the sessions whose text says the form, the share that
   * are about the thing (the thing itself, its domain or its addresses appear). Read from
   * Recall's full-text index, so it counts the word wherever it was said, not only where the
   * extractor noticed it.
   */
  async shortForms(ids, agg, cluster, sess) {
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
    /** Sessions saying each word, asked once per pass however many names start with it. */
    const saidBy = new Map();
    let asked = 0;
    for (const id of ids) {
      const words = agg.get(id).key.split(/\s+/).filter(w => w !== "&");
      if (words.length < 2) continue;
      const form = words[0].toLowerCase();
      if (form.length < 3 || OPENERS.has(form) || HEADINGS.has(form) || TOOL_WORDS.has(form) || ORG_WORDS.has(form)) continue;
      let said = saidBy.get(form);
      if (!said) {
        try { said = [...new Set(q.all(`"${form.replace(/"/g, "")}"`).map(r => sessionOf(Number(r.rowid))).filter(Boolean))]; } catch { said = []; }
        saidBy.set(form, said);
        if (++asked % 50 === 0) await yieldNow();
      }
      if (!said.length) continue;
      const about = new Set();
      for (const c of cluster(id)) for (const s of agg.get(c)?.by.keys() || []) about.add(parentOf(s, sess));
      const saidParents = new Set(said.map(s => parentOf(s, sess)));
      const hit = [...saidParents].filter(s => about.has(s)).length;
      measured.push({ node: id, form, precision: Number((hit / saidParents.size).toFixed(3)), count: saidParents.size, sessions: said, usable: false });
    }
    // Two things can claim one word; only the best claimant may use it, so the weaker reading
    // never dilutes the stronger one.
    const best = new Map();
    for (const m of measured) if (m.precision >= T.shortPrecision && m.count >= T.shortMinSessions) {
      const b = best.get(m.form);
      if (!b || m.precision > b.precision || (m.precision === b.precision && m.count > b.count)) best.set(m.form, m);
    }
    for (const m of best.values()) m.usable = true;
    return measured;
  }

  /** Write the derived graph as a difference against what is stored. */
  write({ agg, kept, kind, role, want, worksAt, forms, together, cluster, emailsOf, lessonsFor, now }) {
    const db = this.db;
    let changed = 0;
    return this.tx(() => {
      // nodes
      const have = new Map(db.prepare("SELECT * FROM memory_nodes").all().map(r => [String(r.id), r]));
      const upNode = db.prepare(`INSERT INTO memory_nodes (id, kind, key, label, role, sessions, mentions, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, key=excluded.key, label=excluded.label,
        role=excluded.role, sessions=excluded.sessions, mentions=excluded.mentions, first_seen=excluded.first_seen, last_seen=excluded.last_seen`);
      for (const id of kept) {
        const a = agg.get(id);
        const row = [id, kind.get(id), a.key, a.key, role.get(id) ?? null, a.parents.size || new Set([...a.by.keys()]).size, a.mentions, a.first || null, a.last || null];
        const h = have.get(id);
        if (!h || h.kind !== row[1] || h.label !== row[3] || (h.role ?? null) !== row[4] || Number(h.sessions) !== row[5] || Number(h.mentions) !== row[6] || (h.first_seen ?? null) !== row[7] || (h.last_seen ?? null) !== row[8]) {
          upNode.run(...row); changed++;
        }
      }
      const delNode = db.prepare("DELETE FROM memory_nodes WHERE id = ?");
      for (const id of have.keys()) if (!kept.has(id)) { delNode.run(id); changed++; }

      // edges, except works_at, which carries history and is handled below
      const edges = db.prepare("SELECT id, src, rel, dst, weight, valid_from, valid_to, confidence FROM memory_edges").all()
        .map(r => ({ id: Number(r.id), src: String(r.src), rel: String(r.rel), dst: String(r.dst), weight: Number(r.weight), from: Number(r.valid_from), to: r.valid_to == null ? null : Number(r.valid_to), conf: Number(r.confidence) }));
      const key = (s, r, d, f) => `${s}\u0000${r}\u0000${d}\u0000${f}`;
      const byKey = new Map(edges.map(e => [key(e.src, e.rel, e.dst, e.from), e]));
      const ins = db.prepare("INSERT INTO memory_edges (src, rel, dst, weight, valid_from, valid_to, observed, confidence) VALUES (?,?,?,?,?,NULL,?,?)");
      const upd = db.prepare("UPDATE memory_edges SET weight = ?, confidence = ?, valid_to = ?, valid_from = ?, observed = ? WHERE id = ?");
      const del = db.prepare("DELETE FROM memory_edges WHERE id = ?");
      /** @type {Map<number, [string, number][]>} */
      const evidence = new Map();
      /** @type {Map<number, string[][]>} */
      const taught = new Map();
      const wanted = new Set();
      for (const w of want) {
        if (!w.ev.length && !w.lessons?.length) continue;
        const k = key(w.src, w.rel, w.dst, w.from);
        let e = byKey.get(k);
        if (!e) {
          const id = Number(ins.run(w.src, w.rel, w.dst, w.weight, w.from, now, w.conf).lastInsertRowid);
          e = { id, src: w.src, rel: w.rel, dst: w.dst, weight: w.weight, from: w.from, to: null, conf: w.conf };
          byKey.set(k, e); changed++;
        } else if (e.weight !== w.weight || e.conf !== w.conf || e.to !== null) {
          upd.run(w.weight, w.conf, null, w.from, now, e.id); changed++;
        }
        wanted.add(e.id);
        evidence.set(e.id, w.ev);
        taught.set(e.id, w.lessons || []);
      }

      // works_at is bi-temporal. When the vote moves a person to another organisation, the old
      // edge is CLOSED at the point the new one starts, never deleted: what was believed in
      // June stays readable in September. A closed edge lives as long as its evidence does.
      const works = edges.filter(e => e.rel === "works_at");
      const people = new Set([...works.map(e => e.src), ...worksAt.keys()]);
      for (const p of people) {
        const mine = works.filter(e => e.src === p);
        const w = worksAt.get(p);
        if (w) {
          const open = mine.find(e => e.to === null && e.dst === w.org);
          for (const e of mine) if (e.to === null && e.dst !== w.org) {
            e.to = Math.max(e.from, w.from);
            upd.run(e.weight, e.conf, e.to, e.from, now, e.id); changed++;
          }
          if (open) {
            if (open.from !== w.from || open.weight !== w.weight || open.conf !== w.conf) {
              const clash = byKey.get(key(p, "works_at", w.org, w.from));
              if (clash && clash.id !== open.id) { del.run(clash.id); changed++; }
              upd.run(w.weight, w.conf, null, w.from, now, open.id); changed++;
              Object.assign(open, { from: w.from, weight: w.weight, conf: w.conf });
            }
            wanted.add(open.id); evidence.set(open.id, w.ev); taught.set(open.id, w.lessons);
          } else {
            const same = byKey.get(key(p, "works_at", w.org, w.from));
            let id;
            if (same) { upd.run(w.weight, w.conf, null, w.from, now, same.id); id = same.id; }
            else id = Number(ins.run(p, "works_at", w.org, w.weight, w.from, now, w.conf).lastInsertRowid);
            changed++;
            wanted.add(id); evidence.set(id, w.ev); taught.set(id, w.lessons);
          }
        }
        // Every other works_at edge of this person stays while the turns or lessons behind it exist.
        for (const e of mine) {
          if (wanted.has(e.id) || !kept.has(e.src) || !kept.has(e.dst)) continue;
          const ev = together([e.src, ...(emailsOf.get(e.src) || [])], cluster(e.dst));
          const ls = lessonsFor(e.src, "works_at", e.dst);
          if (ev.length || ls.length) { wanted.add(e.id); evidence.set(e.id, ev); taught.set(e.id, ls); }
        }
      }
      for (const e of edges) if (!wanted.has(e.id)) { del.run(e.id); changed++; }

      // evidence, as a difference
      const haveEv = new Set(db.prepare("SELECT edge, session, seq FROM memory_evidence").all().map(r => `${r.edge}\u0000${r.session}\u0000${r.seq}`));
      const wantEv = new Set();
      for (const [id, list] of evidence) for (const [s, q] of list) wantEv.add(`${id}\u0000${s}\u0000${q}`);
      const insEv = db.prepare("INSERT INTO memory_evidence (edge, session, seq) VALUES (?,?,?)");
      const delEv = db.prepare("DELETE FROM memory_evidence WHERE edge = ? AND session = ? AND seq = ?");
      for (const k of wantEv) if (!haveEv.has(k)) { const [e, s, q] = k.split("\u0000"); insEv.run(Number(e), s, Number(q)); changed++; }
      for (const k of haveEv) if (!wantEv.has(k)) { const [e, s, q] = k.split("\u0000"); delEv.run(Number(e), s, Number(q)); changed++; }

      // lessons, the same way
      const haveL = new Set(db.prepare("SELECT edge, module, kind, key FROM memory_lessons").all().map(r => [r.edge, r.module, r.kind, r.key].join("\u0000")));
      const wantL = new Set();
      for (const [id, list] of taught) for (const l of list) wantL.add([id, ...l].join("\u0000"));
      const insL = db.prepare("INSERT INTO memory_lessons (edge, module, kind, key) VALUES (?,?,?,?)");
      const delL = db.prepare("DELETE FROM memory_lessons WHERE edge = ? AND module = ? AND kind = ? AND key = ?");
      for (const k of wantL) if (!haveL.has(k)) { const [e, m, kd, ky] = k.split("\u0000"); insL.run(Number(e), m, kd, ky); changed++; }
      for (const k of haveL) if (!wantL.has(k)) { const [e, m, kd, ky] = k.split("\u0000"); delL.run(Number(e), m, kd, ky); changed++; }

      // short forms
      const haveSf = new Map(db.prepare("SELECT node, form, precision, sessions FROM memory_shortforms").all().map(r => [`${r.node}\u0000${r.form}`, r]));
      const upSf = db.prepare("INSERT INTO memory_shortforms (node, form, precision, sessions, at) VALUES (?,?,?,?,?) ON CONFLICT DO UPDATE SET precision = excluded.precision, sessions = excluded.sessions, at = excluded.at");
      const wantSf = new Set();
      for (const f of forms) {
        const k = `${f.node}\u0000${f.form}`;
        wantSf.add(k);
        const h = haveSf.get(k);
        if (!h || Number(h.precision) !== f.precision || Number(h.sessions) !== f.count) { upSf.run(f.node, f.form, f.precision, f.count, now); changed++; }
      }
      const delSf = db.prepare("DELETE FROM memory_shortforms WHERE node = ? AND form = ?");
      for (const [k] of haveSf) if (!wantSf.has(k)) { const [n, f] = k.split("\u0000"); delSf.run(n, f); changed++; }

      if (changed) this.version++;
      return changed;
    });
  }
}
