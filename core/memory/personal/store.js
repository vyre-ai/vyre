// @ts-check
// personal/store: personal facts over memory's store (docs/work/memory-iq.md).
//
// Two layers, like the graph. Claims are what one turn said, kept per (session, seq), so a new
// turn costs one extraction and a rewritten transcript costs dropping one session's rows.
// Entities, aliases, facts and evidence are derived from every claim on each derive, so they can
// never drift from what was said. derive() writes only when the result differs.

import { extractPersonal, SINGULAR, SINGLE_VALUED, TIME_VARYING, relOfRole } from "./extract.js";
import { MIGRATIONS } from "../schema.js";
import { migrate } from "../../store/index.js";

/** Evidence kept per fact: enough to show where it came from. */
const EVIDENCE_PER_FACT = 20;
/** Relations that are bookkeeping for derive, never facts. */
const INTERNAL = new Set(["called", "ended:owns"]);
const KIN_WORD = { spouse: "spouse", partner: "partner", mother: "mother", father: "father", sister: "sister", brother: "brother", son: "son", daughter: "daughter", child: "child", dog: "dog", cat: "cat" };

const round = x => Math.round(x * 1000) / 1000;
const combine = cs => 1 - cs.reduce((p, c) => p * (1 - c), 1);
const isLit = r => r.startsWith("lit:");
const kindOf = ref => {
  if (ref === "me") return "me";
  const [k, v] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  if (k === "kin") return v === "dog" || v === "cat" ? "pet" : "person";
  if (k === "name") return "person";
  return k;
};
const keyOf = ref => ref.slice(ref.indexOf(":") + 1);

/**
 * @typedef {{ id: string, subj: string, subject: string, rel: string, obj: string, object: string, confidence: number,
 *   current: boolean, first_seen: number|null, last_seen: number|null, mentions: number, sessions: number }} Fact
 * @typedef {{ id: string, kind: string, label: string, first_seen: number|null, last_seen: number|null }} Entity
 */

export class Personal {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ log?: (m: string) => void, now?: () => number }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
    migrate(db, "memory", MIGRATIONS);
    /** Claims changed since the last derive. A new process derives once, which is cheap. */
    this.dirty = true;
    /** recall_turns (rowid, seq) per session, as far as rowid hw: the scan pass() reuses. */
    this.idx = new Map();
    this.hw = 0;
  }

  hasRecall() {
    return Number(this.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('recall_sessions', 'recall_turns')").get()?.n) === 2;
  }

  tx(fn) {
    this.db.exec("SAVEPOINT memory_me_tx");
    try { const r = fn(); this.db.exec("RELEASE memory_me_tx"); return r; }
    catch (e) { this.db.exec("ROLLBACK TO memory_me_tx"); this.db.exec("RELEASE memory_me_tx"); throw e; }
  }

  /** Forget what was read from one session (its transcript was rewritten, or is gone). */
  reset(session) {
    this.tx(() => { for (const t of ["memory_me_claims", "memory_me_cues", "memory_me_cursor"]) this.db.prepare(`DELETE FROM ${t} WHERE session = ?`).run(session); });
    // A rewritten transcript can reuse rowids: the cached scan is no longer to be trusted.
    this.idx.clear(); this.hw = 0;
    this.dirty = true;
  }

  /**
   * Read unread turns, oldest first per session, at most `limit` of them.
   * @param {{ limit?: number, stopped?: () => boolean, full?: boolean }} [opts]  full: read every turn again
   * @returns {Promise<{ turns: number, claims: number, more: boolean }>}
   */
  async pass({ limit = 2000, stopped = () => false, full = false } = {}) {
    if (!this.hasRecall()) return { turns: 0, claims: 0, more: false };
    const db = this.db;
    if (full) {
      // Claims a model added stay: they are keyed to turns that did not change.
      this.tx(() => db.exec("DELETE FROM memory_me_claims WHERE method != 'model'; DELETE FROM memory_me_cues; DELETE FROM memory_me_cursor;"));
      this.dirty = true;
    }
    const recall = new Map(db.prepare("SELECT id, turns FROM recall_sessions ORDER BY started, id").all().map(r => [String(r.id), Number(r.turns)]));
    const cursor = new Map(db.prepare("SELECT session, upto, focus FROM memory_me_cursor").all().map(r => [String(r.session), { upto: Number(r.upto), focus: r.focus ? String(r.focus) : null }]));
    // Gone from Recall, or shrunk (rewritten, seq restarted): read again from the start.
    for (const [s, c] of cursor) if (!recall.has(s) || /** @type {number} */ (recall.get(s)) < c.upto) { this.reset(s); cursor.delete(s); }
    /** @type {Map<string, number>} */
    const need = new Map();
    for (const [s, n] of recall) if (n > (cursor.get(s)?.upto || 0)) need.set(s, cursor.get(s)?.upto || 0);
    if (!need.size) return { turns: 0, claims: 0, more: false };

    const rows = this.pending(need, recall);
    const text = db.prepare("SELECT ts, text, role FROM recall_turns WHERE rowid = ?");
    const addClaim = db.prepare(`INSERT INTO memory_me_claims (session, seq, ts, subj, rel, obj, conf, method) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT DO UPDATE SET ts = excluded.ts, conf = max(conf, excluded.conf), method = excluded.method`);
    const addCue = db.prepare("INSERT OR IGNORE INTO memory_me_cues (session, seq, ts, text) VALUES (?,?,?,?)");
    const done = db.prepare("INSERT INTO memory_me_cursor (session, upto, at, focus) VALUES (?,?,?,?) ON CONFLICT DO UPDATE SET upto = excluded.upto, at = excluded.at, focus = excluded.focus");
    let turns = 0, claims = 0, more = false;
    // One transaction per batch, not per session: a commit per session was most of a first
    // pass's time.
    this.tx(() => {
      for (const [session, from] of need) {
        if (stopped() || turns >= limit) { more = true; break; }
        const list = (rows.get(session) || []).filter(r => r.seq >= from);
        const take = list.slice(0, limit - turns);
        const all = take.length === list.length;
        let focus = cursor.get(session)?.focus ? safeJson(cursor.get(session)?.focus) : null;
        for (const { rowid, seq } of take) {
          const t = text.get(rowid);
          if (!t) continue;       // deleted since the scan: gone, not an error
          const ts = Number(t.ts) || 0;
          const r = extractPersonal(String(t.text), { role: String(t.role), prev: focus });
          focus = r.focus;
          for (const c of r.claims) { addClaim.run(session, seq, ts, c.subj, c.rel, c.obj, c.conf, c.method); claims++; }
          for (const q of r.cues) addCue.run(session, seq, ts, q);
        }
        const upto = all ? /** @type {number} */ (recall.get(session)) : take[take.length - 1].seq + 1;
        done.run(session, upto, this.now(), focus ? JSON.stringify(focus) : null);
        turns += take.length;
        if (!all) more = true;
      }
    });
    if (claims) this.dirty = true;
    return { turns, claims, more };
  }

  /**
   * The turns to read per session, seq order. Keeps the (rowid, seq) scan between passes and adds
   * only rows past the last rowid seen; scans everything again only when that is incomplete.
   * @param {Map<string, number>} need
   * @param {Map<string, number>} recall
   */
  pending(need, recall) {
    const db = this.db;
    const add = list => {
      for (const r of list) {
        const s = String(r.session), rowid = Number(r.rowid);
        if (rowid > this.hw) this.hw = rowid;
        if (!this.idx.has(s)) this.idx.set(s, []);
        this.idx.get(s).push({ rowid, seq: Number(r.seq) });
      }
    };
    const complete = () => [...need].every(([s, from]) => {
      const l = this.idx.get(s) || [];
      let n = 0; for (const r of l) if (r.seq >= from) n++;
      return n === /** @type {number} */ (recall.get(s)) - from;
    });
    if (this.hw > 0) add(db.prepare("SELECT rowid, session, seq FROM recall_turns WHERE rowid > ?").all(this.hw));
    if (this.hw === 0 || !complete()) {
      this.idx.clear(); this.hw = 0;
      add(db.prepare("SELECT rowid, session, seq FROM recall_turns").all());
    }
    for (const l of this.idx.values()) l.sort((a, b) => a.seq - b.seq);
    return this.idx;
  }

  /**
   * Claims from outside the rules: T3's model pass. method defaults to "model".
   * @param {string} session @param {number} seq @param {number} ts
   * @param {{ subj: string, rel: string, obj: string, conf?: number, method?: string }[]} claims
   */
  addClaims(session, seq, ts, claims) {
    const ins = this.db.prepare(`INSERT INTO memory_me_claims (session, seq, ts, subj, rel, obj, conf, method) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT DO UPDATE SET conf = max(conf, excluded.conf), method = excluded.method, ts = excluded.ts`);
    let n = 0;
    this.tx(() => {
      for (const c of claims || []) {
        if (!c || !c.subj || !c.rel || !c.obj) continue;
        ins.run(String(session), Number(seq), Number(ts) || 0, String(c.subj), String(c.rel), String(c.obj), Math.max(0, Math.min(1, Number(c.conf ?? 0.75))), String(c.method || "model"));
        n++;
      }
    });
    if (n) this.dirty = true;
    return n;
  }

  /**
   * Rebuild entities, aliases, facts and evidence from every claim. Does nothing unless claims
   * changed; writes nothing unless the result differs. Returns whether anything was written.
   * @param {{ force?: boolean }} [opts]
   */
  derive({ force = false } = {}) {
    if (!this.dirty && !force) return { changed: false };
    this.dirty = false;
    const db = this.db;
    const claims = db.prepare("SELECT session, seq, ts, subj, rel, obj, conf, method FROM memory_me_claims").all()
      .map(r => ({ session: String(r.session), seq: Number(r.seq), ts: Number(r.ts) || 0, subj: String(r.subj), rel: String(r.rel), obj: String(r.obj), conf: Number(r.conf) }));
    const parent = new Map(this.hasRecall() ? db.prepare("SELECT id, parent FROM recall_sessions").all().map(r => [String(r.id), r.parent ? String(r.parent) : null]) : []);
    const top = s => parent.get(s) || (s.includes("/") ? s.split("/")[0] : s);

    // ---- entity resolution: union-find over references.
    const up = new Map();
    const find = x => { let r = x; while (up.has(r)) r = up.get(r); while (up.has(x)) { const n = up.get(x); up.set(x, r); x = n; } return r; };
    const rank = x => (x === "me" ? 3 : x.startsWith("kin:") ? 2 : 1);
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra === rb) return;
      if (rank(rb) > rank(ra)) up.set(ra, rb); else up.set(rb, ra);
    };
    // Spellings that differ only in case are one thing ("neovim", "Neovim").
    const byLower = new Map();
    for (const c of claims) for (const r of [c.subj, c.obj]) {
      if (r === "me" || isLit(r) || r.startsWith("kin:")) continue;
      const k = r.toLowerCase();
      if (byLower.has(k)) union(byLower.get(k), r); else byLower.set(k, r);
    }
    // Names: a singular role's winning name is that relative; a plural role with one name is too.
    const named = new Map();   // subj -> Map(name -> { cs, last })
    for (const c of claims) if (c.rel === "name" && isLit(c.obj) && (c.subj === "me" || c.subj.startsWith("kin:"))) {
      if (!named.has(c.subj)) named.set(c.subj, new Map());
      const m = named.get(c.subj), n = keyOf(c.obj);
      const v = m.get(n) || { cs: [], last: 0 };
      v.cs.push(c.conf); v.last = Math.max(v.last, c.ts); m.set(n, v);
    }
    const nameWinner = m => [...m].map(([n, v]) => ({ n, raw: combine(v.cs), last: v.last })).sort((a, b) => b.raw - a.raw || b.last - a.last)[0]?.n;
    /** kin roles whose names are separate people ("my kids Sam and Juno"). */
    const split = new Set();
    for (const [subj, m] of named) {
      const role = subj === "me" ? null : keyOf(subj);
      if (subj === "me" || SINGULAR.has(/** @type {string} */ (role)) || m.size === 1) union(subj, `name:${nameWinner(m)}`);
      else split.add(subj);
    }
    // A make said alone is the one model of that make, when only one was ever said.
    const models = new Map();
    for (const c of claims) for (const r of [c.subj, c.obj]) if (r.startsWith("vehicle:") && keyOf(r).includes(" ")) {
      const make = keyOf(r).split(" ")[0].toLowerCase();
      if (!models.has(make)) models.set(make, new Set());
      models.get(make).add(find(r));
    }
    for (const c of claims) for (const r of [c.subj, c.obj]) if (r.startsWith("vehicle:") && !keyOf(r).includes(" ")) {
      const s = models.get(keyOf(r).toLowerCase());
      if (s && s.size === 1) union([...s][0], r);   // the model's name leads
    }
    const canon = r => (isLit(r) ? r : find(r));

    // ---- claims in canonical form. A plural role's names become their own people, each with
    // the role's relation to me.
    const rows = [];
    for (const c of claims) {
      if (c.rel === "name" && split.has(c.subj)) {
        const person = canon(`name:${keyOf(c.obj)}`);
        rows.push({ ...c, subj: "me", rel: relOfRole(keyOf(c.subj)), obj: person });
        rows.push({ ...c, subj: person });
        continue;
      }
      rows.push({ ...c, subj: canon(c.subj), obj: canon(c.obj) });
    }

    // A plural role whose names became people keeps its bare "my kids" only if something is
    // said about the role itself.
    for (const k of split) {
      if (rows.some(r => r.subj === k && r.rel !== "called")) continue;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].obj === k || rows[i].subj === k) rows.splice(i, 1);
    }

    // ---- what is connected to me: facts about anyone else are someone else's.
    const out = new Map();
    for (const r of rows) if (!isLit(r.obj) && !INTERNAL.has(r.rel)) { if (!out.has(r.subj)) out.set(r.subj, new Set()); out.get(r.subj).add(r.obj); }
    const mine = new Set(["me"]);
    const queue = ["me"];
    while (queue.length) for (const n of out.get(/** @type {string} */ (queue.shift())) || []) if (!mine.has(n)) { mine.add(n); queue.push(n); }

    // ---- entities
    const ents = new Map();
    const touch = (id, ts) => {
      const e = ents.get(id) || { id, kind: kindOf(id), first: ts, last: ts, called: new Map() };
      e.first = Math.min(e.first, ts); e.last = Math.max(e.last, ts);
      ents.set(id, e);
      return e;
    };
    for (const r of rows) {
      if (!mine.has(r.subj)) continue;
      const e = touch(r.subj, r.ts);
      if (r.rel === "called") e.called.set(keyOf(r.obj), (e.called.get(keyOf(r.obj)) || 0) + 1);
      if (!isLit(r.obj) && mine.has(r.obj)) touch(r.obj, r.ts);
    }
    if (!ents.has("me") && rows.length) touch("me", 0);

    // ---- facts
    const groups = new Map();
    const ended = new Map();
    for (const r of rows) {
      if (!mine.has(r.subj)) continue;
      if (r.rel === "ended:owns") { const k = `${r.subj}|${r.obj}`; ended.set(k, Math.max(ended.get(k) || 0, r.ts)); continue; }
      if (INTERNAL.has(r.rel)) continue;
      const id = `${r.subj}|${r.rel}|${r.obj}`;
      const g = groups.get(id) || { id, subj: r.subj, rel: r.rel, obj: r.obj, turns: new Map(), sessions: new Set(), first: r.ts, last: r.ts };
      const tk = `${r.session}\u0000${r.seq}`;
      const had = g.turns.get(tk);
      if (!had || had.conf < r.conf) g.turns.set(tk, { conf: r.conf, session: r.session, seq: r.seq, ts: r.ts });
      g.sessions.add(top(r.session));
      g.first = Math.min(g.first, r.ts); g.last = Math.max(g.last, r.ts);
      groups.set(id, g);
    }
    const facts = [...groups.values()].map(g => ({ ...g, raw: combine([...g.turns.values()].map(t => t.conf)), confidence: 0, current: 1 }));
    // Single-valued relations: rival values share the belief; the newest is favoured where a
    // value changes over a life (where the user lives), and breaks ties everywhere else.
    const bySlot = new Map();
    for (const f of facts) if (SINGLE_VALUED.has(f.rel)) { const k = `${f.subj}|${f.rel}`; if (!bySlot.has(k)) bySlot.set(k, []); bySlot.get(k).push(f); }
    for (const f of facts) if (!SINGLE_VALUED.has(f.rel)) f.confidence = f.raw;
    for (const list of bySlot.values()) {
      const newest = [...list].sort((a, b) => b.last - a.last || b.raw - a.raw)[0];
      const w = list.map(f => f.raw * (TIME_VARYING.has(f.rel) && f !== newest ? 0.5 : 1));
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      list.forEach((f, i) => { f.confidence = f.raw * w[i] / sum; });
      const win = [...list].sort((a, b) => b.confidence - a.confidence || b.last - a.last)[0];
      for (const f of list) f.current = f === win ? 1 : 0;
    }
    // Sold: owning (and driving) it stopped, unless it was said again after.
    for (const f of facts) if ((f.rel === "owns" || f.rel === "drives") && (ended.get(`${f.subj}|${f.obj}`) || -1) >= f.last) f.current = 0;

    // ---- labels and aliases
    const nameOf = new Map();
    for (const f of facts) if (f.rel === "name" && f.current) nameOf.set(f.subj, keyOf(f.obj));
    const label = id => {
      if (nameOf.has(id)) return /** @type {string} */ (nameOf.get(id));
      if (id === "me") return "me";
      const e = ents.get(id);
      if (id.startsWith("kin:")) { const w = e && [...e.called].sort((a, b) => b[1] - a[1])[0]; return w ? w[0] : KIN_WORD[keyOf(id)] || keyOf(id); }
      return keyOf(id);
    };
    const entities = [...ents.values()].map(e => ({ id: e.id, kind: e.kind, label: label(e.id), first_seen: e.first || null, last_seen: e.last || null }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const aliases = new Set();
    const alias = (a, id) => { const x = String(a || "").toLowerCase().trim(); if (x) aliases.add(`${x}\u0000${id}`); };
    for (const e of entities) {
      alias(e.id, e.id);
      if (e.id === "me") { for (const a of ["me", "myself", "i"]) alias(a, "me"); }
      if (e.label !== "me") { alias(e.label, e.id); if (e.kind === "person" || e.kind === "pet") alias(e.label.split(" ")[0], e.id); }
      for (const w of ents.get(e.id)?.called.keys() || []) { alias(w, e.id); alias(`my ${w}`, e.id); }
      if (e.id.startsWith("kin:")) { const r = keyOf(e.id); alias(r, e.id); alias(`my ${r}`, e.id); }
      if (e.kind === "vehicle") { const k = keyOf(e.id); alias(k, e.id); alias(k.split(" ")[0], e.id); if (k.includes(" ")) alias(k.split(" ").slice(1).join(" "), e.id); }
    }
    for (const f of facts) if (f.subj === "me" && !isLit(f.obj)) {
      if (["spouse", "partner", "mother", "father", "sister", "brother", "son", "daughter", "child", "pet"].includes(f.rel)) { alias(f.rel, f.obj); alias(`my ${f.rel}`, f.obj); }
      if (f.rel === "owns" && f.current && f.obj.startsWith("vehicle:")) { alias("car", f.obj); alias("my car", f.obj); }
    }
    for (const f of facts) if (f.rel === "name" && f.subj !== "me") alias(keyOf(f.obj), f.subj);

    const factRows = facts.map(f => ({ id: f.id, subj: f.subj, rel: f.rel, obj: f.obj, obj_label: isLit(f.obj) ? keyOf(f.obj) : label(f.obj),
      confidence: round(f.confidence), first_seen: f.first || null, last_seen: f.last || null, mentions: f.turns.size, sessions: f.sessions.size, current: f.current }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const evidence = [];
    for (const f of facts) {
      const ts = [...f.turns.values()].sort((a, b) => b.ts - a.ts || (a.session < b.session ? -1 : 1) || a.seq - b.seq).slice(0, EVIDENCE_PER_FACT);
      for (const t of ts) evidence.push({ fact: f.id, session: t.session, seq: t.seq });
    }
    evidence.sort((a, b) => (a.fact < b.fact ? -1 : a.fact > b.fact ? 1 : a.session < b.session ? -1 : a.session > b.session ? 1 : a.seq - b.seq));
    const aliasRows = [...aliases].sort().map(x => { const [a, e] = x.split("\u0000"); return { alias: a, entity: e }; });

    // ---- write only what changed
    const was = {
      e: db.prepare("SELECT id, kind, label, first_seen, last_seen FROM memory_me_entities ORDER BY id").all(),
      a: db.prepare("SELECT alias, entity FROM memory_me_aliases ORDER BY alias, entity").all(),
      f: db.prepare("SELECT id, subj, rel, obj, obj_label, confidence, first_seen, last_seen, mentions, sessions, current FROM memory_me_facts ORDER BY id").all(),
      v: db.prepare("SELECT fact, session, seq FROM memory_me_evidence ORDER BY fact, session, seq").all(),
    };
    const same = (x, y) => JSON.stringify(x.map(r => ({ ...r }))) === JSON.stringify(y);
    if (same(was.e, entities) && same(was.a, aliasRows) && same(was.f, factRows) && same(was.v, evidence)) return { changed: false };
    this.tx(() => {
      db.exec("DELETE FROM memory_me_entities; DELETE FROM memory_me_aliases; DELETE FROM memory_me_facts; DELETE FROM memory_me_evidence;");
      const ie = db.prepare("INSERT INTO memory_me_entities (id, kind, label, first_seen, last_seen) VALUES (?,?,?,?,?)");
      for (const e of entities) ie.run(e.id, e.kind, e.label, e.first_seen, e.last_seen);
      const ia = db.prepare("INSERT INTO memory_me_aliases (alias, entity) VALUES (?,?)");
      for (const a of aliasRows) ia.run(a.alias, a.entity);
      const iff = db.prepare("INSERT INTO memory_me_facts (id, subj, rel, obj, obj_label, confidence, first_seen, last_seen, mentions, sessions, current) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      for (const f of factRows) iff.run(f.id, f.subj, f.rel, f.obj, f.obj_label, f.confidence, f.first_seen, f.last_seen, f.mentions, f.sessions, f.current);
      const iv = db.prepare("INSERT INTO memory_me_evidence (fact, session, seq) VALUES (?,?,?)");
      for (const v of evidence) iv.run(v.fact, v.session, v.seq);
    });
    return { changed: true };
  }

  // ------------------------------------------------------------------ reads

  /** @returns {Fact} */
  row(r) {
    const subject = this.db.prepare("SELECT label FROM memory_me_entities WHERE id = ?").get(r.subj);
    return { id: String(r.id), subj: String(r.subj), subject: subject ? String(subject.label) : String(r.subj), rel: String(r.rel), obj: String(r.obj),
      object: String(r.obj_label), confidence: Number(r.confidence), current: Boolean(r.current), first_seen: r.first_seen == null ? null : Number(r.first_seen),
      last_seen: r.last_seen == null ? null : Number(r.last_seen), mentions: Number(r.mentions), sessions: Number(r.sessions) };
  }

  /**
   * The entity an alias names ("my wife", "wife", "jordan", "kin:spouse"), or null. When several
   * share an alias, the one said about most.
   * @param {string} alias
   * @returns {Entity|null}
   */
  entity(alias) {
    const a = String(alias || "").toLowerCase().trim().replace(/^the\s+/, "");
    if (!a) return null;
    const r = this.db.prepare(`SELECT e.id, e.kind, e.label, e.first_seen, e.last_seen,
        (SELECT coalesce(sum(f.mentions), 0) FROM memory_me_facts f WHERE f.subj = e.id OR f.obj = e.id) n
      FROM memory_me_entities e WHERE e.id = ? OR e.id IN (SELECT entity FROM memory_me_aliases WHERE alias = ?)
      ORDER BY (e.id = ?) DESC, n DESC, e.id LIMIT 1`).get(alias, a, alias);
    return r ? { id: String(r.id), kind: String(r.kind), label: String(r.label), first_seen: r.first_seen == null ? null : Number(r.first_seen), last_seen: r.last_seen == null ? null : Number(r.last_seen) } : null;
  }

  /**
   * Facts with this subject (an entity id or an alias), and this relation when given. Current
   * values first, then by confidence.
   * @param {{ subj: string, rel?: string }} q
   * @returns {Fact[]}
   */
  lookup({ subj, rel }) {
    const e = this.entity(subj);
    if (!e) return [];
    return this.db.prepare(`SELECT * FROM memory_me_facts WHERE subj = ? AND (? IS NULL OR rel = ?) ORDER BY current DESC, confidence DESC, last_seen DESC`)
      .all(e.id, rel ?? null, rel ?? null).map(r => this.row(r));
  }

  /**
   * One entity: what it is, what names it, what is known about it (facts) and how it relates to
   * others (links: facts where it is the object, such as me -> spouse -> it).
   * @param {string} id  an entity id or an alias
   */
  about(id) {
    const e = this.entity(id);
    if (!e) return null;
    const aliases = this.db.prepare("SELECT alias FROM memory_me_aliases WHERE entity = ? ORDER BY alias").all(e.id).map(r => String(r.alias));
    const facts = this.db.prepare("SELECT * FROM memory_me_facts WHERE subj = ? ORDER BY current DESC, confidence DESC, rel").all(e.id).map(r => this.row(r));
    const links = this.db.prepare("SELECT * FROM memory_me_facts WHERE obj = ? ORDER BY current DESC, confidence DESC, rel").all(e.id).map(r => this.row(r));
    return { entity: e, aliases, facts, links };
  }

  /**
   * Every fact, current ones first, then by confidence and how many conversations said it.
   * @param {{ limit?: number }} [opts]
   * @returns {Fact[]}
   */
  facts({ limit = 50 } = {}) {
    return this.db.prepare("SELECT * FROM memory_me_facts ORDER BY current DESC, confidence DESC, sessions DESC, id LIMIT ?").all(Math.max(1, Math.min(1000, limit))).map(r => this.row(r));
  }

  /** The turns behind a fact, newest first. */
  evidence(factId, limit = EVIDENCE_PER_FACT) {
    return this.db.prepare(`SELECT v.session, v.seq, c.ts FROM memory_me_evidence v
      LEFT JOIN (SELECT session, seq, max(ts) ts FROM memory_me_claims GROUP BY session, seq) c ON c.session = v.session AND c.seq = v.seq
      WHERE v.fact = ? ORDER BY c.ts DESC LIMIT ?`).all(String(factId), limit).map(r => ({ session: String(r.session), seq: Number(r.seq), ts: r.ts == null ? null : Number(r.ts) }));
  }

  stats() {
    const one = sql => Number(this.db.prepare(sql).get()?.n || 0);
    return {
      claims: one("SELECT COUNT(*) n FROM memory_me_claims"),
      cues: one("SELECT COUNT(*) n FROM memory_me_cues"),
      sessions: one("SELECT COUNT(*) n FROM memory_me_cursor"),
      turns: one("SELECT coalesce(sum(upto), 0) n FROM memory_me_cursor"),
      entities: one("SELECT COUNT(*) n FROM memory_me_entities"),
      facts: one("SELECT COUNT(*) n FROM memory_me_facts"),
      current: one("SELECT COUNT(*) n FROM memory_me_facts WHERE current = 1"),
    };
  }
}

function safeJson(s) { try { return JSON.parse(String(s)); } catch { return null; } }
