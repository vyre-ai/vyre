// @ts-check
// log: one session's append-only frame log (ADR 0052).
//
// The cursor is gapless from 1. The newest frames live in memory, bounded by count and by bytes;
// with a store (core/store) every frame is also written, in batches off the hot path, so a
// restart or a long-away client can still be served. Live subscribers hear each frame
// synchronously inside append(), unmerged: nothing the log does to its history ever delays them.
//
// Coalescing (stored history only): adjacent text-delta frames of one message block, and adjacent
// term-chunk frames of contiguous bytes, are merged in the ring so a long reply is a few frames,
// not thousands. A merged frame keeps the cursor of its last piece and records `span` and
// `data.parts` (protocol.js) so a client holding the first piece trims exactly.

import { migrate } from "../store/index.js";
import { frame, kindOf, startOf, KINDS, EPHEMERAL } from "./protocol.js";
import { assertAskerCanRead } from "./viewer.js";

export const DEFAULTS = Object.freeze({ maxFrames: 4000, maxBytes: 8 * 1024 * 1024, maxStored: 50000, merge: 16 * 1024, flushMs: 100 });

/** @param {any} f */
const sizeOf = f => JSON.stringify(f).length + 16;

/**
 * @typedef {{ maxFrames?: number, maxBytes?: number, maxStored?: number, mergeChars?: number, coalesce?: boolean, flushMs?: number,
 *   db?: import("node:sqlite").DatabaseSync, now?: () => number }} LogOptions
 */

export class SessionLog {
  /** @param {string} session @param {LogOptions} [opts] */
  constructor(session, opts = {}) {
    this.session = session;
    this.maxFrames = opts.maxFrames ?? DEFAULTS.maxFrames;
    this.maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
    this.maxStored = opts.maxStored ?? DEFAULTS.maxStored;
    this.mergeChars = opts.mergeChars ?? DEFAULTS.merge;
    this.coalesce = opts.coalesce !== false;
    this.now = opts.now || Date.now;
    /** @type {any[]} */ this.ring = [];
    this.bytes = 0;
    /** The cursor of the newest frame; 0 for an empty log. */
    this.head = 0;
    /** @type {Set<(f: any) => void>} */ this.subs = new Set();
    this.closed = false;
    /** @type {any} */ this.db = opts.db || null;
    /** @type {Map<number, any>} merged or new frames not yet written */ this.dirty = new Map();
    /** @type {number[]} rows a merge made obsolete */ this.stale = [];
    this.flushMs = opts.flushMs ?? DEFAULTS.flushMs;
    /** @type {any} */ this.timer = null;
    if (this.db) this.load();
  }

  // ---- store -------------------------------------------------------------------------------
  load() {
    migrate(this.db, "stream", [`
      CREATE TABLE stream_frames (
        session TEXT NOT NULL, cur INTEGER NOT NULL, first INTEGER NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (session, cur)
      );`]);
    const rows = this.db.prepare("SELECT json FROM stream_frames WHERE session = ? ORDER BY cur DESC LIMIT ?").all(this.session, this.maxFrames);
    for (const r of rows.reverse()) { const f = JSON.parse(r.json); this.ring.push(f); this.bytes += sizeOf(f); }
    const m = this.db.prepare("SELECT MAX(cur) AS m FROM stream_frames WHERE session = ?").get(this.session);
    this.head = m && m.m ? Number(m.m) : 0;
    this.trim();
  }

  /** The cursor before the oldest frame this log can still serve: a client at or past it can resume. */
  get floor() {
    if (this.db) {
      const r = this.db.prepare("SELECT MIN(first) AS m FROM stream_frames WHERE session = ?").get(this.session);
      const stored = r && r.m ? Number(r.m) - 1 : null;
      const mem = this.ring.length ? startOf(this.ring[0]) - 1 : this.head;
      return Math.min(stored ?? mem, mem);
    }
    return this.ring.length ? startOf(this.ring[0]) - 1 : this.head;
  }

  /** Write pending frames now (a transaction), and drop what the store no longer keeps. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.db || (!this.dirty.size && !this.stale.length)) return;
    const put = this.db.prepare("INSERT OR REPLACE INTO stream_frames (session, cur, first, json) VALUES (?,?,?,?)");
    const del = this.db.prepare("DELETE FROM stream_frames WHERE session = ? AND cur = ?");
    this.db.exec("BEGIN");
    try {
      for (const c of this.stale) del.run(this.session, c);
      for (const f of this.dirty.values()) put.run(this.session, f.cur, startOf(f), JSON.stringify(f));
      if (this.head > this.maxStored) this.db.prepare("DELETE FROM stream_frames WHERE session = ? AND cur <= ?").run(this.session, this.head - this.maxStored);
      this.db.exec("COMMIT");
    } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; }
    this.dirty.clear(); this.stale = [];
  }

  /** @param {any} f */
  persist(f) {
    if (!this.db) return;
    this.dirty.set(f.cur, f);
    if (!this.timer && !this.closed) { this.timer = setTimeout(() => { this.timer = null; try { this.flush(); } catch {} }, this.flushMs); this.timer.unref?.(); }
  }

  close() { this.closed = true; this.flush(); this.subs.clear(); }

  // ---- append ------------------------------------------------------------------------------

  /**
   * Add a frame. Returns it, with its cursor. Live subscribers hear it before this returns.
   * `author`, `acts_for` and `message` ride on the frame (protocol.js). `asker` (a viewer, viewer.js) is the
   * person an assistant acts for: a reply is refused (throws) when it holds a field the asker cannot read.
   * @param {string} kind @param {any} data @param {{ turn?: string|null, time?: number, id?: string, author?: string, acts_for?: string, message?: string, asker?: any }} [ctx]
   */
  append(kind, data, ctx = {}) {
    if (this.closed) throw new Error("the log is closed");
    if (!KINDS.includes(kind)) throw new Error(`${kind} is not a logged frame kind`);
    if (ctx.asker) assertAskerCanRead({ data }, ctx.asker);
    const f = frame(kind, data, { session: this.session, turn: ctx.turn ?? null, time: ctx.time ?? this.now(), id: ctx.id, cur: this.head + 1, author: ctx.author, acts_for: ctx.acts_for, message: ctx.message });
    this.head = f.cur;
    this.store(f);
    for (const fn of [...this.subs]) { try { fn(f); } catch {} }
    return f;
  }

  /**
   * Deliver an ephemeral frame (presence, read-marker) to every live subscriber: no cursor, never stored,
   * never replayed. Returns it.
   * @param {string} kind @param {any} data @param {{ time?: number, author?: string }} [ctx]
   */
  emit(kind, data, ctx = {}) {
    if (this.closed) throw new Error("the log is closed");
    if (!EPHEMERAL.includes(kind)) throw new Error(`${kind} is not an ephemeral frame kind`);
    const f = frame(kind, data, { session: this.session, time: ctx.time ?? this.now(), cur: 0, author: ctx.author });
    for (const fn of [...this.subs]) { try { fn(f); } catch {} }
    return f;
  }

  /** Put f in the ring, merged into its neighbour when that is exact. @param {any} f */
  store(f) {
    const last = this.ring[this.ring.length - 1];
    const m = this.coalesce && last ? this.merged(last, f) : null;
    if (m) {
      this.bytes += sizeOf(m) - sizeOf(last);
      this.ring[this.ring.length - 1] = m;
      this.dirty.delete(last.cur);
      this.stale.push(last.cur);
      this.persist(m);
    } else {
      this.ring.push(f);
      this.bytes += sizeOf(f);
      this.persist(f);
      this.trim();
    }
  }

  /** The frame `a` and `b` make together, or null. A new object: a live subscriber may hold `a`. @param {any} a @param {any} b */
  merged(a, b) {
    const k = kindOf(b);
    if (kindOf(a) !== k || a.turn !== b.turn) return null;
    // Two assistants streaming at once: only the SAME message from the SAME author merges.
    if (a.author !== b.author || a.acts_for !== b.acts_for || a.message !== b.message) return null;
    const A = a.data, B = b.data;
    if (k === "text-delta") {
      if (A.message !== B.message || A.index !== B.index || A.parent !== B.parent || !!A.reasoning !== !!B.reasoning) return null;
      const text = A.text + B.text;
      if (text.length > this.mergeChars) return null;
      const parts = (a.span ? A.parts : [A.text.length]).concat([B.text.length]);
      return { ...a, cur: b.cur, id: b.id, time: b.time, span: parts.length, data: { ...A, text, parts } };
    }
    if (k === "term-chunk") {
      if (A.term !== B.term) return null;
      const ab = Buffer.from(A.b64, "base64"), bb = Buffer.from(B.b64, "base64");
      if (A.offset + ab.length !== B.offset || ab.length + bb.length > this.mergeChars * 4) return null;
      const parts = (a.span ? A.parts : [ab.length]).concat([bb.length]);
      return { ...a, cur: b.cur, id: b.id, time: b.time, span: parts.length, data: { ...A, b64: Buffer.concat([ab, bb]).toString("base64"), parts } };
    }
    return null;
  }

  trim() {
    // Always keep the newest frame, even if it alone is over the byte bound.
    while (this.ring.length > 1 && (this.ring.length > this.maxFrames || this.bytes > this.maxBytes)) this.bytes -= sizeOf(this.ring.shift());
  }

  // ---- read --------------------------------------------------------------------------------

  /** Hear every frame appended from now on, synchronously. Returns the unsubscribe. @param {(f: any) => void} fn */
  subscribe(fn) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }

  /**
   * Frames after cursor `from` (those whose last cursor is greater), oldest first, at most `limit`.
   * A first frame may start at or before `from + 1` when history was merged: the client trims.
   * @param {number} from @param {number} [limit]
   */
  read(from, limit = Infinity) {
    const out = [];
    if (from >= this.head) return out;
    const memFirst = this.ring.length ? startOf(this.ring[0]) : this.head + 1;
    if (this.db && from + 1 < memFirst) {
      this.flush();
      const before = this.ring.length ? this.ring[0].cur : this.head + 1;
      const rows = this.db.prepare("SELECT json FROM stream_frames WHERE session = ? AND cur > ? AND cur < ? ORDER BY cur LIMIT ?")
        .all(this.session, from, before, Number.isFinite(limit) ? limit : 1_000_000);
      for (const r of rows) out.push(JSON.parse(r.json));
    }
    // Binary search: the ring is ordered by cur.
    let lo = 0, hi = this.ring.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.ring[mid].cur > from) hi = mid; else lo = mid + 1; }
    for (let i = lo; i < this.ring.length && out.length < limit; i++) out.push(this.ring[i]);
    return out.length > limit ? out.slice(0, limit) : out;
  }

  /**
   * What a client holding cursor `cur` needs: `{ reset: true, head }` when the log no longer holds
   * the frames after it (or the client is ahead of the log, as after a server that lost it), else
   * `{ frames, head }` ready to replay in order.
   * @param {number} cur
   * @returns {{ reset: true, head: number } | { reset?: false, frames: any[], head: number }}
   */
  since(cur) {
    if (!Number.isInteger(cur) || cur < 0) return { reset: true, head: this.head };
    if (cur > this.head) return { reset: true, head: this.head };
    if (cur < this.floor) return { reset: true, head: this.head };
    return { frames: this.read(cur), head: this.head };
  }
}

/** A registry: one log per session, opened on first use, all sharing options. */
export class Logs {
  /** @param {LogOptions} [opts] */
  constructor(opts = {}) { this.opts = opts; /** @type {Map<string, SessionLog>} */ this.logs = new Map(); }
  /** @param {string} session */
  get(session) {
    let l = this.logs.get(session);
    if (!l) { l = new SessionLog(session, this.opts); this.logs.set(session, l); }
    return l;
  }
  /** @param {string} session */
  has(session) { return this.logs.has(session); }
  /** Does this session have a log here, in memory or stored? Creates nothing. @param {string} session */
  known(session) {
    if (this.logs.has(session)) return true;
    const db = this.opts.db;
    if (!db) return false;
    try { return Boolean(db.prepare("SELECT 1 AS x FROM stream_frames WHERE session = ? LIMIT 1").get(session)); } catch { return false; }
  }
  /** @param {string} session */
  drop(session) { const l = this.logs.get(session); if (l) { l.close(); this.logs.delete(session); } }
  close() { for (const l of this.logs.values()) l.close(); this.logs.clear(); }
}
