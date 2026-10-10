// @ts-check
// watch: a live tail of one session's transcript, as session.turn events.
//
// For Chat's terminal mirror and the Capsule's side view: while a surface shows a session, each
// completed turn arrives as an event the moment Claude Code writes it, with no pass to wait for.
//
// Light by default. One fs.watch per watched file, shared by every watcher of it; nothing runs
// while nobody watches. Each change reads only the bytes appended since the last read, and a
// half-written last line waits for the next one. A sweep every `sweepMs` (60 s) does the rest:
// a stat for platforms where fs.watch misses appends, and the end of watches nobody renewed
// (`ttlMs`, 3 min: HTTP callers have no connection to close, so a surface renews by calling
// recall.watch again with its watch id, every 60 s while the view is shown) or whose session went
// quiet (`idleMs`, 30 min with no new turn).

import fs from "node:fs";
import { follow, followState, settle, eachLine } from "../transcripts/index.js";
import { newPrefixedId } from "../../lib/id.js";

/** Replaying from an old turn sends at most this many, the newest. */
export const REPLAY_MAX = 500;
/** A burst of appends is read once, this long after the first. */
const CATCH_UP_MS = 300;
const DEBOUNCE_MS = 25;

/**
 * @typedef {{ id: string, file: string }} Found
 * @typedef {{ file: string, session: string, offset: number, line: number, st: import("../transcripts/index.js").FollowState,
 *   busy: boolean, fsw: fs.FSWatcher|null, watchers: Set<string>, active: number, soon: ReturnType<typeof setTimeout>|null }} Entry
 * @typedef {{ id: string, session: string, file: string, renewed: number, started: number }} Watch
 */

export class Watches {
  /**
   * @param {{ emit: (type: string, payload: any, where: any) => void, resolve: (session: string) => Found|null,
   *   log?: (s: string) => void, ttlMs?: number, idleMs?: number, sweepMs?: number, now?: () => number }} o
   */
  constructor(o) {
    this.emit = o.emit;
    this.resolve = o.resolve;
    this.log = o.log || (() => {});
    this.ttlMs = o.ttlMs ?? 180_000;
    this.idleMs = o.idleMs ?? 1_800_000;
    this.sweepMs = o.sweepMs ?? 60_000;
    this.now = o.now || Date.now;
    /** @type {Map<string, Entry>} by file */
    this.files = new Map();
    /** @type {Map<string, Watch>} by watch id */
    this.watches = new Map();
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
  }

  /**
   * Start watching a session, or renew a watch by its id.
   * @param {{ session: string, from?: string, watch?: string }} input
   */
  watch({ session, from, watch }) {
    const now = this.now();
    const had = watch ? this.watches.get(watch) : undefined;
    if (had) {
      had.renewed = now;
      const e = this.files.get(had.file);
      return { watch: had.id, session: had.session, from: null, busy: e ? e.busy : false, renewed: true };
    }
    const found = this.resolve(session);
    if (!found) throw Object.assign(new Error(`no session ${session} (recall.sessions lists them)`), { code: "not_found" });
    let entry = this.files.get(found.file);
    /** @type {import("../transcripts/index.js").LiveTurn[]} */
    let before = [];
    const wantFrom = from !== undefined && from !== null && from !== "";
    if (!entry) {
      const r = this.scan(found.file, undefined, wantFrom);
      entry = { file: found.file, session: found.id, offset: r.offset, line: r.line, st: r.st, busy: r.st.busy,
        fsw: null, watchers: new Set(), active: now, soon: null };
      this.listen(entry);
      this.files.set(found.file, entry);
      before = r.turns;
    } else if (wantFrom) {
      // Another watcher already follows this file: replay reads only up to where it has got.
      before = this.scan(found.file, entry.offset, true).turns;
    }
    const id = newPrefixedId("w");
    this.watches.set(id, { id, session: entry.session, file: found.file, renewed: now, started: now });
    entry.watchers.add(id);
    this.arm();
    let replayed = null;
    if (wantFrom) {
      const at = before.findIndex(t => t.id === String(from));
      if (at >= 0) {
        replayed = String(from);
        for (const t of before.slice(at + 1).slice(-REPLAY_MAX)) this.send(entry.session, t, id);
      }
    }
    return { watch: id, session: entry.session, from: replayed, busy: entry.busy };
  }

  /** @param {{ watch: string }} input */
  unwatch({ watch }) {
    const w = this.watches.get(watch);
    if (!w) throw Object.assign(new Error(`no watch ${watch} (it may have ended already; start a new watch)`), { code: "not_found" });
    this.end(w, "unwatched");
    return { watch, ended: true };
  }

  /**
   * Read a transcript from the top, up to `until` bytes, into the state at that point and (if
   * asked) every turn in it.
   * @param {string} file @param {number|undefined} until @param {boolean} keep
   */
  scan(file, until, keep) {
    const st = followState();
    /** @type {import("../transcripts/index.js").LiveTurn[]} */
    const turns = [];
    let buf;
    try { buf = fs.readFileSync(file); } catch { buf = Buffer.alloc(0); }
    if (until !== undefined) buf = buf.subarray(0, until);
    const r = eachLine(buf, 0, (o, line) => {
      const ts = follow(o, line, st);
      if (keep) for (const t of ts) turns.push(t);
    });
    settle(st);
    return { st, turns, offset: r.bytes, line: r.line };
  }

  /** @param {Entry} e */
  listen(e) {
    try {
      e.fsw = fs.watch(e.file, { persistent: false }, () => this.soon(e));
      e.fsw.on("error", () => { e.fsw?.close(); e.fsw = null; });
      // macOS starts delivering events a moment after fs.watch returns: a line appended in that
      // gap is never announced, and would wait for the 60 s sweep. One catch-up read closes it.
      const late = setTimeout(() => this.read(e), CATCH_UP_MS);
      late.unref?.();
    } catch { e.fsw = null; }
  }

  /** @param {Entry} e */
  soon(e) {
    if (e.soon) return;
    e.soon = setTimeout(() => { e.soon = null; this.read(e); }, DEBOUNCE_MS);
  }

  /**
   * Read what was appended since the last read and send its turns.
   * @param {Entry} e
   */
  read(e) {
    if (!this.files.has(e.file)) return;
    let size;
    try { size = fs.statSync(e.file).size; } catch { return; }
    if (size < e.offset) {
      // Rewritten (compaction, a fork): start over from the top, quietly, at its new end.
      const r = this.scan(e.file, undefined, false);
      Object.assign(e, { offset: r.offset, line: r.line, st: r.st });
      this.state(e);
      return;
    }
    if (size === e.offset) return;
    const buf = Buffer.alloc(size - e.offset);
    let fd;
    try { fd = fs.openSync(e.file, "r"); fs.readSync(fd, buf, 0, buf.length, e.offset); }
    catch { return; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    let sent = 0;
    const r = eachLine(buf, e.line, (o, line) => {
      for (const t of follow(o, line, e.st)) { this.send(e.session, t); sent++; }
    });
    e.offset += r.bytes;
    e.line = r.line;
    if (sent) e.active = this.now();
    settle(e.st);
    this.state(e);
  }

  /** Claude Code said the turn ended (its Stop hook): nobody is waiting any more. @param {string} session */
  stopped(session) {
    for (const e of this.files.values()) {
      if (e.session !== session) continue;
      this.read(e);
      e.st.busy = false;
      this.state(e);
    }
  }

  /** @param {Entry} e */
  state(e) {
    if (e.st.busy === e.busy) return;
    e.busy = e.st.busy;
    this.safeEmit("session.state", { session: e.session, busy: e.busy }, e.session);
  }

  /** @param {string} session @param {import("../transcripts/index.js").LiveTurn} t @param {string} [replay] */
  send(session, t, replay) {
    this.safeEmit("session.turn", { session, ...t, ...(replay ? { replay } : {}) }, session);
  }

  /** @param {string} type @param {any} payload @param {string} session */
  safeEmit(type, payload, session) {
    try { this.emit(type, payload, { thread: session }); }
    catch (err) { this.log(`${type} for ${session} not sent: ${/** @type {Error} */ (err).message}`); }
  }

  /** The sweep runs only while someone watches. */
  arm() {
    if (this.timer || !this.watches.size) return;
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref?.();
  }

  sweep() {
    for (const e of this.files.values()) this.read(e);
    const now = this.now();
    for (const w of [...this.watches.values()]) {
      const e = this.files.get(w.file);
      if (now - w.renewed > this.ttlMs) this.end(w, "expired");
      else if (e && now - Math.max(w.started, e.active) > this.idleMs) this.end(w, "idle");
    }
  }

  /** @param {Watch} w @param {string} why */
  end(w, why) {
    this.watches.delete(w.id);
    const e = this.files.get(w.file);
    if (e) {
      e.watchers.delete(w.id);
      if (!e.watchers.size) {
        e.fsw?.close();
        if (e.soon) clearTimeout(e.soon);
        this.files.delete(w.file);
      }
    }
    if (!this.watches.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    this.log(`watch ${w.id} on ${w.session} ended (${why})`);
  }

  stats() {
    return { files: this.files.size, watches: this.watches.size, watching: [...this.files.values()].filter(e => e.fsw).length };
  }

  close() {
    for (const w of [...this.watches.values()]) this.end(w, "stopped");
  }
}
