// @ts-check
// events — an append-only log of what happened, and a bus to hear it as it happens.
//
// Events are facts about the past, named "<noun>.<past-verb>": watcher.fired, thread.started,
// gate.held. They are how modules built separately learn about each other without importing
// each other. A payload never carries a secret: the log is readable by every module and shown
// in the Deck, so anything that looks like a credential is refused at the door.

import { migrate } from "../store/index.js";

const NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

// A deliberately blunt check. It refuses the obvious shapes (key=value secrets, long tokens with
// known prefixes); the vault's own redactor is stricter and is what the vault module uses.
// A token prefix counts only at the start of a token (not inside a longer word or a random id, where "sk-" or "AKIA" turn up by chance: FL-1), and the prefixes are case-sensitive as the providers issue them.
const SECRET_PREFIX = /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/;
const SECRET_SHAPE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:password|secret|token|api_?key)"\s*:\s*"[^"]{6,}"/i;
const LOOKS_SECRET = { test: (/** @type {string} */ json) => SECRET_PREFIX.test(json) || SECRET_SHAPE.test(json) };

/** Events one drain delivers before it stops (a loop of listeners emitting each other). */
export const DRAIN_CAP = 10_000;

export class Events {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
    migrate(db, "events", [`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        project TEXT,
        thread TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX events_type ON events(type, id);
      CREATE INDEX events_project ON events(project, id);
    `,
    // AUTOINCREMENT: an id is a surface's cursor, so it must never be handed out twice, even when
    // the newest rows are pruned or the table is emptied (docs/adr/0029-resilience.md, R1).
    `
      CREATE TABLE events_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        project TEXT,
        thread TEXT,
        payload TEXT NOT NULL
      );
      INSERT INTO events_v2 (id, at, type, source, project, thread, payload) SELECT id, at, type, source, project, thread, payload FROM events;
      DROP TABLE events;
      ALTER TABLE events_v2 RENAME TO events;
      CREATE INDEX events_type ON events(type, id);
      CREATE INDEX events_project ON events(project, id);
    `]);
    /** @type {Map<string, Set<(e: any) => void>>} */
    this.listeners = new Map();
    /** Events stored and not yet delivered to the listeners, and whether a delivery is running. @type {any[]} */
    this.queue = [];
    /** Where a dropped drain is said; the daemon sets it to its log. @type {(msg: string) => void} */
    this.log = () => {};
    this.delivering = false;
    this.insert = db.prepare("INSERT INTO events (at, type, source, project, thread, payload) VALUES (?,?,?,?,?,?)");
  }

  /**
   * Record an event and tell whoever is listening. Returns the stored event.
   * @param {string} source the module emitting it
   * @param {string} type   "<noun>.<past-verb>"
   * @param {object} payload
   * @param {{ project?: string, thread?: string, at?: number }} [where]
   */
  emit(source, type, payload = {}, where = {}) {
    if (!NAME.test(type)) throw new Error(`event type "${type}" must look like noun.past-verb`);
    const json = JSON.stringify(payload);
    if (LOOKS_SECRET.test(json)) throw new Error(`event ${type} from ${source} carries something that looks like a secret; events are readable by every module`);
    const at = where.at || Date.now();
    const r = this.insert.run(at, type, source, where.project || null, where.thread || null, json);
    const event = { id: Number(r.lastInsertRowid), at, type, source, project: where.project || null, thread: where.thread || null, payload };
    // An event a listener emits while another is being delivered waits its turn: every listener hears events in id order, so a stream that
    // follows an id cursor (the SSE one) never meets 13 before 12 and drops the 12 (a model.switched the settings hub answered with its own
    // event was lost to every live Deck this way, #41).
    this.queue.push(event);
    if (this.delivering) return event;
    this.delivering = true;
    try {
      // One drain is bounded: listeners that answer each other (A emits B, B emits A) would otherwise spin the daemon for ever. The rest is dropped
      // from delivery (it stays stored) and the log names the types.
      let n = 0;
      for (let e; (e = this.queue.shift());) {
        if (++n > DRAIN_CAP) {
          const types = [...new Set([e, ...this.queue].map(x => x.type))].slice(0, 8).join(", ");
          this.queue.length = 0;
          this.log(`events: delivery stopped after ${DRAIN_CAP} events in one drain (listeners emitting each other?); dropped from delivery: ${types}`);
          break;
        }
        for (const key of [e.type, e.type.split(".")[0] + ".*", "*"]) {
          for (const fn of this.listeners.get(key) || []) {
            // A listener that throws must not stop the others or the emitter.
            try { fn(e); } catch {}
          }
        }
      }
    } finally { this.delivering = false; }
    return event;
  }

  /** Listen for "watcher.fired", "watcher.*" or "*". Returns a function that stops listening. */
  on(pattern, fn) {
    if (!this.listeners.has(pattern)) this.listeners.set(pattern, new Set());
    this.listeners.get(pattern).add(fn);
    return () => this.listeners.get(pattern)?.delete(fn);
  }

  /**
   * Delete events that another event has made redundant, such as a turn's partial text once its
   * whole text is stored. The log is otherwise append-only; this is the one exception, and it is
   * narrow: one type, at or before one id, optionally one source and thread, optionally only rows
   * whose payload has a given top-level key. Returns how many rows went.
   * @param {{ type: string, before: number, source?: string, thread?: string, has?: string }} o
   */
  prune({ type, before, source, thread, has }) {
    if (!NAME.test(String(type))) throw new Error(`event type "${type}" must look like noun.past-verb`);
    if (!Number.isInteger(before)) throw new Error("prune needs an event id to stop at");
    if (has !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(has)) throw new Error(`"${has}" is not a payload key`);
    const where = ["type = ?", "id <= ?"], args = [type, before];
    if (source !== undefined) { where.push("source = ?"); args.push(source); }
    if (thread !== undefined) { where.push("thread = ?"); args.push(thread); }
    if (has !== undefined) { where.push("json_extract(payload, ?) IS NOT NULL"); args.push("$." + has); }
    return Number(this.db.prepare(`DELETE FROM events WHERE ${where.join(" AND ")}`).run(...args).changes);
  }

  /** The newest id handed out, or 0 on a fresh log. Counts pruned ids too: a cursor never goes back. */
  latestId() {
    const seq = /** @type {any} */ (this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get());
    return Math.max(Number(seq?.seq || 0), Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get().id));
  }

  /**
   * Whether a surface resuming from `cursor` can be caught up by replay. A cursor past the newest
   * id (the box's log was reset, or the surface followed another box) cannot: the surface must
   * reload its state through tools and follow from `from` (ADR 0029, R1).
   * @param {number} cursor @returns {{ ok: true } | { ok: false, from: number }}
   */
  resumable(cursor) {
    const latest = this.latestId();
    return cursor > latest ? { ok: false, from: latest } : { ok: true };
  }

  /** Events after a cursor, oldest first. How a surface catches up after being away. */
  since(id = 0, { type = null, project = null, limit = 200 } = {}) {
    const rows = this.db.prepare(`SELECT * FROM events WHERE id > ?
      ${type ? "AND type = ?" : ""} ${project ? "AND project = ?" : ""} ORDER BY id LIMIT ?`)
      .all(...[id, ...(type ? [type] : []), ...(project ? [project] : []), limit]);
    return rows.map(r => ({ ...r, payload: JSON.parse(String(r.payload)) }));
  }
}
