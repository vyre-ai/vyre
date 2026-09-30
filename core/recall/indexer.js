// @ts-check
// indexer — transcripts into Recall's tables (core/recall/schema.js), and vectors beside them.
//
// APPEND-ONLY. A transcript only ever grows, so a changed one is almost always the old turns
// plus new ones, and only the new ones are written. The prototype deleted and re-inserted every
// turn of a changed session, which threw away its vectors and every pointer to its turns on
// each pass, for exactly the sessions in use: the busiest session, a third of the corpus, never
// kept a vector at all. A transcript that was REWRITTEN (compaction, a fork, a restored copy),
// detected because the turns already indexed no longer match, is indexed again from scratch.
//
// A file whose size and mtime have not moved is not read. The check is inequality, not "newer",
// because a restored copy or clock skew can move an mtime backwards.

import fs from "node:fs";
import path from "node:path";
import * as transcripts from "../transcripts/index.js";
import { chunks, encode } from "./embed.js";

/** Let the event loop breathe between files, so vyred keeps answering while it indexes. */
const breathe = () => new Promise(r => setImmediate(r));

/** How long a threads.origin answer is kept: a session's record changes rarely, and a pass asks once per file. */
const ORIGIN_TTL_MS = 30_000;

/**
 * The folder holding the per-account homes (VYRE_ACCOUNTS_HOME, else /home/acct where it exists), or null on
 * a machine with none. A transcript under it was written by a process running as an account, so its own
 * words about who started it prove nothing.
 * @returns {string|null}
 */
function defaultAccountsHome() {
  if (process.env.VYRE_ACCOUNTS_HOME) return path.resolve(process.env.VYRE_ACCOUNTS_HOME);
  try { return fs.statSync("/home/acct").isDirectory() ? "/home/acct" : null; } catch { return null; }
}

/**
 * @typedef {import("node:sqlite").DatabaseSync} DB
 * @typedef {{ sessions: number, added: number, appended: number, reindexed: number, skipped: number, failed: number, turns: number, ms: number }} Stats
 */

/**
 * Text that must never sit in the index, where a later memory_ask could quote it. Each rule is a
 * bearer credential or invitation: a Tailscale sign-in link (network.tailscale.login hands it to the
 * person's own session). Add a rule here and every transcript turn is cleaned before it is indexed.
 * @type {{ name: string, re: RegExp, to: string }[]}
 */
export const REDACTIONS = [
  { name: "tailscale-link", re: /https?:\/\/login\.tailscale\.com\/\S*/gi, to: "[tailscale sign-in link removed]" },
];

/** @param {string} text */
export const redact = text => REDACTIONS.reduce((t, r) => t.replace(r.re, r.to), String(text));

/** Kept for the callers that named it first. @param {string} text */
export const redactLinks = redact;

export class Indexer {
  /**
   * @param {DB} db
   * @param {{ emit?: (type: string, payload: object, where?: object) => void, log?: (m: string) => void,
   *           onVector?: (item: { rid: number, session: string, seq: number, role: string, chunks: { off: number, v: Float32Array }[] }) => void,
   *           origin?: (session: string) => Promise<{ known?: boolean, human?: boolean } | null | undefined>,
   *           accountsHome?: string | null }} [hooks]
   *   origin: the Switchboard's own record of a session (threads.origin). For a transcript under an
   *   account folder, whether it is a person's comes only from this, never from the transcript: no
   *   answer, or known false, is not human.
   */
  constructor(db, hooks = {}) {
    this.db = db;
    this.emit = hooks.emit || (() => {});
    this.log = hooks.log || (() => {});
    this.onVector = hooks.onVector || (() => {});
    this.origin = hooks.origin || null;
    this.accountsHome = hooks.accountsHome === undefined ? defaultAccountsHome() : hooks.accountsHome;
    /** @type {Map<string, { at: number, human: boolean }>} */
    this.origins = new Map();
    this.q = {
      get: db.prepare("SELECT file, bytes, mtime, turns, name, human FROM recall_sessions WHERE id = ?"),
      moved: db.prepare("UPDATE recall_sessions SET file = ? WHERE id = ?"),
      // Two stored turns, found in one pass. session is UNINDEXED in the FTS table, so any
      // lookup by it reads the whole table; this runs only for sessions that changed.
      ends: db.prepare("SELECT seq, role, text FROM recall_turns WHERE session = ? AND seq IN (?, ?)"),
      delTurns: db.prepare("DELETE FROM recall_turns WHERE session = ?"),
      delVectors: db.prepare("DELETE FROM recall_vectors WHERE session = ?"),
      addTurn: db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)"),
      put: db.prepare(`INSERT INTO recall_sessions (id, file, cwd, name, title, started, ended, turns, human, parent, bytes, mtime)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET file=excluded.file, cwd=COALESCE(excluded.cwd, cwd),
          name=COALESCE(excluded.name, name), title=excluded.title, started=excluded.started,
          ended=excluded.ended, turns=excluded.turns, human=excluded.human, parent=excluded.parent,
          bytes=excluded.bytes, mtime=excluded.mtime`),
      meta: db.prepare("INSERT INTO recall_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
      // Bumped whenever turns are deleted. Anything holding a copy of turns (the dense index)
      // compares it and rebuilds; appends only make a copy incomplete, never wrong.
      generation: db.prepare("INSERT INTO recall_meta (k, v) VALUES ('generation', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1"),
    };
  }

  /**
   * One pass over every transcript under the folders.
   * @param {string[]} folders
   * `pace` is awaited after each file with how long it took (pace.js), so a first pass over a
   * whole history trickles; `onProgress` hears (done, total) after each file.
   * @param {{ stopped?: () => boolean, pace?: (spentMs: number) => Promise<void>, onProgress?: (done: number, total: number) => void }} [opts]
   * @returns {Promise<Stats>}
   */
  async run(folders, { stopped = () => false, pace, onProgress } = {}) {
    const t0 = Date.now();
    /** @type {Stats} */
    const s = { sessions: 0, added: 0, appended: 0, reindexed: 0, skipped: 0, failed: 0, turns: 0, ms: 0 };
    const all = [...transcripts.list(folders)];
    for (const entry of all) {
      if (stopped()) break;
      s.sessions++;
      const t = Date.now();
      try { this.one(entry, s, await this.humanOf(entry)); }
      catch (e) { s.failed++; this.log(`could not index ${entry.id}: ${/** @type {Error} */ (e).message}`); }
      onProgress?.(s.sessions, all.length);
      // An unchanged file costs a stat; only real work is paced.
      const spent = Date.now() - t;
      if (pace && spent > 2) await pace(spent); else await breathe();
    }
    s.ms = Date.now() - t0;
    this.q.meta.run("last_index", JSON.stringify({ at: Date.now(), ...s }));
    return s;
  }

  /**
   * Index one session now, for a turn that just completed: its transcript copies only, and no
   * last_index mark, since this is not a pass over everything.
   * @param {string[]} folders @param {string} id
   * @returns {Promise<Stats>}
   */
  async session(folders, id) {
    const t0 = Date.now();
    /** @type {Stats} */
    const s = { sessions: 0, added: 0, appended: 0, reindexed: 0, skipped: 0, failed: 0, turns: 0, ms: 0 };
    for (const entry of transcripts.list(folders)) {
      if (entry.id !== id) continue;
      s.sessions++;
      try { this.one(entry, s, await this.humanOf(entry)); }
      catch (e) { s.failed++; this.log(`could not index ${entry.id}: ${/** @type {Error} */ (e).message}`); }
    }
    s.ms = Date.now() - t0;
    return s;
  }

  /** Whether a transcript file sits under an account's home. @param {string} file */
  underAccounts(file) {
    if (!this.accountsHome) return false;
    const rel = path.relative(this.accountsHome, path.resolve(file));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /**
   * For a transcript under an account folder: the Switchboard's word on whether a person started it
   * (null for any other folder, where the transcript's own reading stands). Fails closed: no origin
   * hook, an error, or no matching thread is false.
   * @param {transcripts.Entry} entry @returns {Promise<boolean|null>}
   */
  async humanOf(entry) {
    if (!this.underAccounts(entry.file)) return null;
    const hit = this.origins.get(entry.id);
    if (hit && Date.now() - hit.at < ORIGIN_TTL_MS) return hit.human;
    let human = false;
    try {
      const r = this.origin ? await this.origin(entry.id) : null;
      human = Boolean(r && r.known === true && r.human === true);
    } catch { human = false; }
    this.origins.set(entry.id, { at: Date.now(), human });
    return human;
  }

  /**
   * @param {transcripts.Entry} entry
   * @param {Stats} s
   * @param {boolean|null} [human] the Switchboard's answer for an account-folder transcript; null otherwise
   */
  one(entry, s, human = null) {
    const prev = /** @type {any} */ (this.q.get.get(entry.id));
    if (prev && prev.bytes === entry.size && prev.mtime === entry.mtime && !(human === true && Number(prev.human) === 0)) {
      // Same bytes somewhere else (an archived folder): note where it lives now, read nothing.
      if (prev.file !== entry.file) this.q.moved.run(entry.file, entry.id);
      s.skipped++;
      return;
    }
    const t = transcripts.read(entry.file, { id: entry.id, parent: entry.parent });
    if (!t) { s.failed++; return; }
    for (const turn of t.turns) turn.text = redact(turn.text);

    const have = prev ? Number(prev.turns) : 0;
    let from = 0, rewritten = false;
    if (have > 0) {
      const ends = /** @type {any[]} */ (this.q.ends.all(entry.id, 0, have - 1));
      const same = (/** @type {number} */ seq) => {
        const r = ends.find(e => Number(e.seq) === seq), n = t.turns[seq];
        return Boolean(r && n && r.role === n.role && r.text === n.text);
      };
      if (have <= t.turns.length && same(0) && same(have - 1)) from = have;
      else rewritten = true;
    }

    this.db.exec("BEGIN");
    try {
      if (rewritten) {
        // Vectors first: they key on (session, seq), and the new turns reuse those seqs.
        this.q.delVectors.run(entry.id);
        this.q.delTurns.run(entry.id);
        this.q.generation.run();
      }
      for (const turn of t.turns.slice(from)) this.q.addTurn.run(entry.id, turn.seq, turn.role, turn.ts, turn.text);
      this.q.put.run(entry.id, entry.file, t.cwd, t.name, t.title, t.started || null, t.ended || null,
        t.turns.length, human === null ? t.human : (human && t.human ? 1 : 0), t.parent, entry.size, entry.mtime);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }

    const wrote = t.turns.length - from;
    s.turns += wrote;
    if (!prev) s.added++; else if (rewritten) s.reindexed++; else s.appended++;
    // from and to are both inclusive seqs. A rewrite with no turns left still says so, because
    // whatever pointed at the old turns has to let go of them.
    if (wrote > 0 || rewritten) {
      this.emit("session.indexed", { session: entry.id, from, to: t.turns.length - 1, rewritten }, { thread: entry.id });
    }
  }

  /**
   * Turns that have no vector yet, most recent sessions first: that is what gets searched.
   *
   * Tried and rejected: embedding assistant turns only (docs/SPEC.md 7.3 measured dense search
   * over assistant turns). It raised real-corpus hybrid MRR from 0.544 to 0.61, but it regressed
   * the fixture/fictional labelled set (0.845 to 0.667): its "blind visitors" case is answered by
   * a USER turn (the audit request itself), and a role-only cut throws that kind of case away
   * along with the short, noisy real-corpus user turns that were actually the problem. See
   * docs/work/recall.md for the numbers and the dense_weight retune that replaced this.
   */
  pending() {
    return /** @type {{ rid: number }[]} */ (this.db.prepare(`
      SELECT t.rowid AS rid FROM recall_turns t JOIN recall_sessions s ON s.id = t.session
      WHERE NOT EXISTS (SELECT 1 FROM recall_vectors v WHERE v.session = t.session AND v.seq = t.seq)
      ORDER BY s.ended DESC, t.seq`).all()).map(r => Number(r.rid));
  }

  /**
   * Embed every turn that has no vector yet, one text at a time (see embed.js for why).
   *
   * Incremental by construction: the work list is "turns with no vector", so a later pass does
   * only what arrived since. A turn with nothing to embed still gets an empty row, or it would
   * be found as unfinished work on every pass forever.
   * @param {import("./embed.js").Embedder} embedder
   * `pace` is awaited after each turn with how long its embedding took (pace.js).
   * @param {{ limit?: number, stopped?: () => boolean, onProgress?: (done: number, total: number) => void, pace?: (spentMs: number) => Promise<void> }} [opts]
   */
  /**
   * Forget sessions outright: their turns, vectors and rows (a revoked device's synced sessions).
   * @param {string[]} ids @returns {number} how many sessions were there
   */
  forget(ids) {
    const del = this.db.prepare("DELETE FROM recall_sessions WHERE id = ?");
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const id of ids) { this.q.delVectors.run(id); this.q.delTurns.run(id); n += Number(del.run(id).changes); }
      if (n) this.q.generation.run();
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return n;
  }

  async vectorize(embedder, { limit = 0, stopped = () => false, onProgress, pace } = {}) {
    const t0 = Date.now();
    let rids = this.pending();
    if (limit) rids = rids.slice(0, limit);
    const text = this.db.prepare("SELECT session, seq, role, text FROM recall_turns WHERE rowid = ?");
    const add = this.db.prepare("INSERT OR REPLACE INTO recall_vectors (session, seq, chunk, off, v) VALUES (?,?,?,?,?)");
    let turns = 0, made = 0, gone = 0;
    for (const rid of rids) {
      if (stopped()) break;
      const row = /** @type {any} */ (text.get(rid));
      if (!row) { gone++; continue; }
      const cs = chunks(String(row.text));
      const vs = [];
      const t = Date.now();
      for (const c of cs) vs.push(await embedder.embed(c.text));
      if (pace) await pace(Date.now() - t);
      // The turn may have gone while it was being embedded: a re-index deleted its session and
      // reused the rowid, or the seq, for different text. Writing anyway attaches a vector to
      // text it was never made from, a wrong answer that looks exactly like a right one; 13,667
      // such vectors once piled up. So the turn must still be there, word for word.
      const now = /** @type {any} */ (text.get(rid));
      if (!now || now.session !== row.session || now.seq !== row.seq || now.text !== row.text) { gone++; continue; }
      this.db.exec("BEGIN");
      try {
        if (!cs.length) add.run(row.session, row.seq, 0, 0, Buffer.alloc(0));
        cs.forEach((c, i) => add.run(row.session, row.seq, i, c.off, encode(vs[i])));
        this.db.exec("COMMIT");
      } catch (e) { this.db.exec("ROLLBACK"); throw e; }
      turns++; made += cs.length;
      this.onVector({ rid, session: String(row.session), seq: Number(row.seq), role: String(row.role), chunks: cs.map((c, i) => ({ off: c.off, v: vs[i] })) });
      if (onProgress && (turns % 20 === 0 || turns === rids.length)) onProgress(turns, rids.length);
    }
    return { turns, chunks: made, gone, ms: Date.now() - t0 };
  }
}
