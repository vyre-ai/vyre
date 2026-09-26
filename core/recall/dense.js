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
// The index is a snapshot. Recall drops it after any pass that wrote turns or vectors, and it is
// rebuilt on the next hybrid search. It also rebuilds itself whenever the indexer's generation
// has moved, which happens when a rewrite deleted turns: then a (session, seq) it holds may now
// be different text, and its score would be attached to words it was never computed from.
// Appends and new vectors only make a snapshot incomplete, and the keyword half covers the gap.

import { DIM } from "./embed.js";

const breathe = () => new Promise(r => setImmediate(r));

/**
 * @typedef {{ rid: number, session: string, seq: number, score: number, off: number }} DenseHit
 */

export class Dense {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
    /** @type {Promise<any> | null} */
    this.building = null;
    /** @type {null | { n: number, vecs: Float32Array, rid: Int32Array, off: Int32Array, sess: Int32Array, seq: Int32Array, role: Uint8Array,
     *   sessions: string[], cwds: (string|null)[], ms: number, bytes: number, gen: string }} */
    this.index = null;
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
    if (!this.building) this.building = this.read().finally(() => { this.building = null; });
    return this.building;
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
    const total = Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) n FROM recall_vectors WHERE length(v) = ?").get(DIM * 4)).n);
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
    this.index = { n, vecs, rid, off, sess, seq, role, sessions, cwds, ms: Date.now() - t0, bytes, gen };
    return this.index;
  }

  /** Size and build time, for recall.status. */
  stats() {
    return this.index ? { chunks: this.index.n, bytes: this.index.bytes, ms: this.index.ms } : null;
  }

  /**
   * The turns closest to a query vector, best chunk per turn, best first.
   * @param {Float32Array} qv  unit length
   * @param {{ k?: number, floor?: number, role?: string, keep?: (cwd: string|null) => boolean }} [opts]
   * @returns {Promise<DenseHit[]>}
   */
  async search(qv, { k = 200, floor = 0, role, keep } = {}) {
    const x = this.index && this.index.gen === this.generation() ? this.index : await this.build();
    const want = role === "user" ? 1 : role === "assistant" ? 2 : 0;
    /** @type {Map<number, boolean>} */
    const allowed = new Map();
    /** @type {Map<number, DenseHit>} */
    const best = new Map();
    const v = x.vecs;
    for (let i = 0; i < x.n; i++) {
      if (want && x.role[i] !== want) continue;
      if (keep) {
        let ok = allowed.get(x.sess[i]);
        if (ok === undefined) { ok = keep(x.cwds[x.sess[i]]); allowed.set(x.sess[i], ok); }
        if (!ok) continue;
      }
      let dot = 0;
      const base = i * DIM;
      for (let d = 0; d < DIM; d++) dot += v[base + d] * qv[d];
      if (dot < floor) continue;
      const prev = best.get(x.rid[i]);
      if (!prev || dot > prev.score) best.set(x.rid[i], { rid: x.rid[i], session: x.sessions[x.sess[i]], seq: x.seq[i], score: dot, off: x.off[i] });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }
}
