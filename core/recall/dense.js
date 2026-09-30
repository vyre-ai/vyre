// @ts-check
// dense — every stored vector in memory, so search can find a turn by meaning alone.
//
// Re-ranking keyword candidates can never surface a turn that shares no word with the question:
// "making it easier for blind visitors" does not contain "accessibility". Measured on a real
// 100k-turn corpus, dense retrieval beat full-text plus re-ranking (MRR 0.195 against 0.142), so
// meaning is also a way IN to the candidate pool, not only a way to reorder it.
//
// Brute force, on purpose. One Float32Array of every chunk vector and a dot product per chunk:
// 25,000 chunks is about 10 million multiply-adds, a few milliseconds, and there is no
// approximate index to build, tune or let drift. It costs 1.5KB of memory a chunk.
//
// It is built once, then each newly embedded turn is appended in place (add()). It rebuilds
// itself only when the indexer's generation has moved, which happens when a rewrite deleted
// turns: then a (session, seq) it holds may now be different text, and its score would be
// attached to words it was never computed from. New turns only ever add.

import { DIM } from "./embed.js";

const breathe = () => new Promise(r => setImmediate(r));

/**
 * Chunk vectors cost ~1.5KB each (DIM*4 bytes plus four Int32 columns and a role byte); with no
 * cap a large corpus grows this in-memory index without bound, which is the one thing "Light by
 * default" (docs/SPEC.md section 2, principle 8) does not allow a cache to do. 50,000 chunks is
 * about 78MB — comfortably inside vyred's 150MB idle budget alongside everything else it holds —
 * and far past what a normal corpus reaches today (37,000 chunks measured at ~57MB). Past the
 * cap, the oldest sessions drop out of the dense index first; full-text search still covers them,
 * same as it already covers any turn whose vector has not been computed yet.
 */
export const DEFAULT_MAX_CHUNKS = 50_000;

/**
 * @typedef {{ rid: number, session: string, seq: number, score: number, off: number }} DenseHit
 */

export class Dense {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ maxChunks?: number }} [opts]
   */
  constructor(db, { maxChunks = DEFAULT_MAX_CHUNKS } = {}) {
    this.db = db;
    this.maxChunks = maxChunks > 0 ? maxChunks : Infinity;
    /** @type {Promise<any> | null} */
    this.building = null;
    /** @type {null | { n: number, vecs: Float32Array, rid: Int32Array, off: Int32Array, sess: Int32Array, seq: Int32Array, role: Uint8Array,
     *   sessions: string[], cwds: (string|null)[], sid: Map<string, number>, has: Set<number>, ms: number, bytes: number, gen: string, capped: boolean }} */
    this.index = null;
    /** Vectors that arrived while a build was reading, applied when it finishes. */
    /** @type {any[]} */
    this.queued = [];
    /** How many full builds have run: appends must not add to it. */
    this.builds = 0;
  }

  invalidate() { this.index = null; }

  /** The indexer's generation: it changes whenever turns are deleted, which a snapshot cannot survive. */
  generation() {
    const r = /** @type {any} */ (this.db.prepare("SELECT v FROM recall_meta WHERE k = 'generation'").get());
    return r ? String(r.v) : "0";
  }

  /**
   * Read every vector once, in pages, yielding between them: 37,000 chunks took 3.2s to read, and
   * vyred must keep answering meanwhile. Two searches that arrive during a build share it.
   */
  build() {
    if (!this.building) {
      this.building = this.read().then(x => {
        const q = this.queued; this.queued = [];
        for (const item of q) this.add(item);
        return this.index || x;
      }).finally(() => { this.building = null; });
    }
    return this.building;
  }

  /**
   * Add one newly embedded turn in place, instead of rebuilding.
   *
   * The dense index was dropped and rebuilt after every pass that wrote anything. An active
   * session grows on every pass, so that was a whole read of every vector, one to six seconds,
   * every few minutes, to add a handful of turns. New vectors only ever ADD to the index; what
   * would make it wrong is turns being deleted, and that moves the generation, which still
   * forces a rebuild. Arrays grow by doubling, so appends are amortised constant time.
   * @param {{ rid: number, session: string, seq: number, role: string, chunks: { off: number, v: ArrayLike<number> }[] }} item
   */
  add(item) {
    if (this.building) { this.queued.push(item); return; }
    const x = this.index;
    if (!x) return;                                         // nothing built yet; a build reads it
    if (x.gen !== this.generation()) { this.index = null; return; }
    if (x.has.has(item.rid)) return;
    const chunks = item.chunks.filter(c => c.v && c.v.length === DIM);
    // Past the chunk cap, appending would grow memory without bound: drop the index instead, and
    // the next search rebuilds it under the cap with the oldest sessions left out.
    if (x.n + chunks.length > this.maxChunks) { this.index = null; return; }
    if (!chunks.length) return;
    if (x.n + chunks.length > x.rid.length) grow(x, Math.max(x.rid.length * 2, x.n + chunks.length, 64));
    let si = x.sid.get(item.session);
    if (si === undefined) {
      const row = /** @type {any} */ (this.db.prepare("SELECT cwd FROM recall_sessions WHERE id = ?").get(item.session));
      si = x.sessions.length; x.sid.set(item.session, si); x.sessions.push(item.session); x.cwds.push(row?.cwd ?? null);
    }
    for (const c of chunks) {
      x.vecs.set(c.v, x.n * DIM);
      x.rid[x.n] = item.rid; x.off[x.n] = c.off; x.sess[x.n] = si; x.seq[x.n] = item.seq;
      x.role[x.n] = item.role === "user" ? 1 : 2;
      x.n++;
    }
    x.has.add(item.rid);
    x.bytes = x.n * (DIM * 4 + 4 * 4 + 1);
  }

  async read() {
    const t0 = Date.now();
    const db = this.db;
    const gen = this.generation();
    const PAGE = 4096;
    /** @type {Map<string, number>} session\0seq -> rowid */
    const rowids = new Map();
    /** @type {Map<string, number>} */
    const roles = new Map();
    const turns = db.prepare("SELECT rowid AS rid, session, seq, role FROM recall_turns WHERE rowid > ? ORDER BY rowid LIMIT ?");
    for (let after = 0; ;) {
      const page = /** @type {any[]} */ (turns.all(after, PAGE));
      for (const r of page) {
        const k = r.session + "\0" + r.seq;
        rowids.set(k, Number(r.rid));
        roles.set(k, r.role === "user" ? 1 : 2);
      }
      if (page.length < PAGE) break;
      after = Number(page[page.length - 1].rid);
      await breathe();
    }
    /** @type {string[]} */ const sessions = [];
    /** @type {(string|null)[]} */ const cwds = [];
    /** @type {Map<string, number>} */ const sid = new Map();
    for (const s of /** @type {any[]} */ (db.prepare("SELECT id, cwd FROM recall_sessions").all())) {
      sid.set(s.id, sessions.length); sessions.push(s.id); cwds.push(s.cwd ?? null);
    }
    const raw = Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) n FROM recall_vectors WHERE length(v) = ?").get(DIM * 4)).n);
    // Past the cap, keep whole sessions rather than an arbitrary prefix of rows, and keep the
    // most recently ended ones: a session's chunks are looked up together (best chunk per turn),
    // and recency is the same rule the indexer already uses to prioritize embedding itself.
    /** @type {Set<string> | null} */
    let allowed = null;
    let total = raw;
    if (raw > this.maxChunks) {
      const bySession = /** @type {any[]} */ (db.prepare(`
        SELECT v.session AS session, COUNT(*) AS n FROM recall_vectors v
        JOIN recall_sessions s ON s.id = v.session
        WHERE length(v.v) = ? GROUP BY v.session ORDER BY s.ended DESC`).all(DIM * 4));
      allowed = new Set();
      let kept = 0;
      for (const r of bySession) {
        const n = Number(r.n);
        if (kept > 0 && kept + n > this.maxChunks) continue;
        allowed.add(String(r.session));
        kept += n;
        if (kept >= this.maxChunks) break;
      }
      total = Math.min(kept, this.maxChunks);
    }
    const vecs = new Float32Array(total * DIM);
    const rid = new Int32Array(total), off = new Int32Array(total), sess = new Int32Array(total), seq = new Int32Array(total);
    const role = new Uint8Array(total);
    // Keyset pages over the primary key, so chunks of one turn stay together and a write that
    // lands between pages cannot shift what the next page returns.
    const first = db.prepare("SELECT session, seq, chunk, off, v FROM recall_vectors ORDER BY session, seq, chunk LIMIT ?");
    const next = db.prepare(`SELECT session, seq, chunk, off, v FROM recall_vectors
      WHERE (session, seq, chunk) > (?, ?, ?) ORDER BY session, seq, chunk LIMIT ?`);
    let n = 0;
    /** @type {any[]} */
    let page = first.all(PAGE);
    while (page.length && n < total) {
      for (const r of page) {
        if (n >= total) break;
        const b = /** @type {Uint8Array} */ (r.v);
        if (!b || b.length !== DIM * 4) continue;               // a turn with nothing to embed
        if (allowed && !allowed.has(String(r.session))) continue; // evicted: past the chunk cap
        const k = r.session + "\0" + r.seq;
        const id = rowids.get(k), si = sid.get(r.session);
        if (id === undefined || si === undefined) continue;     // a vector whose turn is gone
        // Stored little-endian, which is every machine Vyre runs on; copied so alignment is ours.
        vecs.set(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + DIM * 4)), n * DIM);
        rid[n] = id; off[n] = Number(r.off); sess[n] = si; seq[n] = Number(r.seq); role[n] = roles.get(k) || 0;
        n++;
      }
      if (page.length < PAGE) break;
      const last = page[page.length - 1];
      await breathe();
      page = next.all(last.session, last.seq, last.chunk, PAGE);
    }
    const bytes = n * (DIM * 4 + 4 * 4 + 1);
    const has = new Set();
    for (let i = 0; i < n; i++) has.add(rid[i]);
    this.builds++;
    this.index = { n, vecs, rid, off, sess, seq, role, sessions, cwds, sid, has, ms: Date.now() - t0, bytes, gen, capped: allowed !== null };
    return this.index;
  }

  /** How many chunk vectors the index holds, building it if needed. */
  async size() {
    const x = this.index && this.index.gen === this.generation() ? this.index : await this.build();
    return x.n;
  }

  /** Size and build time, for recall.status. capped: true means the oldest sessions were left out. */
  stats() {
    return this.index ? { chunks: this.index.n, bytes: this.index.bytes, ms: this.index.ms, capped: this.index.capped } : null;
  }

  /**
   * The turns closest to a query vector, best chunk per turn, best first.
   *
   * `floor` is an absolute cutoff, same as before. `z`, when given, adds a PER-QUERY cutoff on
   * top of it: mean + z * stddev of this query's own dot products across the scanned corpus,
   * so nonsense is judged against how spread out ITS scores are, not a constant fitted once at
   * one corpus size. A real question usually has one or a few outlier turns pulling its top
   * score well past its own noise floor; nonsense has no such outlier, so its top score sits
   * close to its own mean. See floorFor's doc comment and docs/work/recall.md for the numbers
   * this was tuned against. The stats are attached to the returned array (non-enumerable, so it
   * still serializes and iterates as a plain hit list) for callers that want to inspect them.
   *
   * `userWeight` scales a user-role turn's score before ranking (1 = no change). It is a soft
   * de-emphasis, not an exclusion: the vector is still in the index and can still win if nothing
   * else is close, which a hard "assistant only" index (tried and reverted, docs/work/recall.md)
   * could not do without also losing the case where the ONLY near turn is what someone asked in
   * their own words. Real-corpus user turns are disproportionately short commands and pasted
   * errors that add noise to the meaning pool without being answers themselves; down-weighting
   * them recovered most of dense retrieval's real-corpus quality that exclusion did, without the
   * fictional set's regression (see docs/work/recall.md for both numbers).
   * @param {Float32Array} qv  unit length
   * @param {{ k?: number, floor?: number, z?: number, role?: string, keep?: (cwd: string|null, session: string) => boolean, userWeight?: number }} [opts]
   * @returns {Promise<DenseHit[] & { stats?: { mean: number, std: number, n: number, effectiveFloor: number } }>}
   */
  async search(qv, { k = 200, floor = 0, z, role, keep, userWeight = 1 } = {}) {
    const x = this.index && this.index.gen === this.generation() ? this.index : await this.build();
    const want = role === "user" ? 1 : role === "assistant" ? 2 : 0;
    /** @type {Map<number, boolean>} */
    const allowed = new Map();
    /** @type {Map<number, DenseHit>} */
    const best = new Map();
    const v = x.vecs;
    let sum = 0, sumSq = 0, n = 0;
    for (let i = 0; i < x.n; i++) {
      if (want && x.role[i] !== want) continue;
      if (keep) {
        let ok = allowed.get(x.sess[i]);
        if (ok === undefined) { ok = keep(x.cwds[x.sess[i]], x.sessions[x.sess[i]]); allowed.set(x.sess[i], ok); }
        if (!ok) continue;
      }
      let dot = 0;
      const base = i * DIM;
      for (let d = 0; d < DIM; d++) dot += v[base + d] * qv[d];
      if (userWeight !== 1 && x.role[i] === 1) dot *= userWeight;
      sum += dot; sumSq += dot * dot; n++;
      const prev = best.get(x.rid[i]);
      if (!prev || dot > prev.score) best.set(x.rid[i], { rid: x.rid[i], session: x.sessions[x.sess[i]], seq: x.seq[i], score: dot, off: x.off[i] });
    }
    const mean = n ? sum / n : 0;
    const variance = n ? Math.max(sumSq / n - mean * mean, 0) : 0;
    const std = Math.sqrt(variance);
    const effectiveFloor = z !== undefined ? Math.max(floor, mean + z * std) : floor;
    const out = /** @type {DenseHit[] & { stats?: any }} */ (
      [...best.values()].filter(h => h.score >= effectiveFloor).sort((a, b) => b.score - a.score).slice(0, k));
    Object.defineProperty(out, "stats", { value: { mean, std, n, effectiveFloor }, enumerable: false });
    return out;
  }
}

/** Move an index into arrays that hold `cap` chunks. */
function grow(/** @type {any} */ x, /** @type {number} */ cap) {
  const more = (/** @type {any} */ a, /** @type {number} */ size) => { const b = new a.constructor(size); b.set(a); return b; };
  x.vecs = more(x.vecs, cap * DIM);
  for (const k of ["rid", "off", "sess", "seq", "role"]) x[k] = more(x[k], cap);
}
