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
const LOOKS_SECRET = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:password|secret|token|api_?key)"\s*:\s*"[^"]{6,}")/i;

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
    `]);
    /** @type {Map<string, Set<(e: any) => void>>} */
    this.listeners = new Map();
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
    for (const key of [type, type.split(".")[0] + ".*", "*"]) {
      for (const fn of this.listeners.get(key) || []) {
        // A listener that throws must not stop the others or the emitter.
        try { fn(event); } catch {}
      }
    }
    return event;
  }

  /** Listen for "watcher.fired", "watcher.*" or "*". Returns a function that stops listening. */
  on(pattern, fn) {
    if (!this.listeners.has(pattern)) this.listeners.set(pattern, new Set());
    this.listeners.get(pattern).add(fn);
    return () => this.listeners.get(pattern)?.delete(fn);
  }

  /** The newest event's id, or 0 on an empty log. */
  latestId() {
    return Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get().id);
  }

  /** Events after a cursor, oldest first. How a surface catches up after being away. */
  since(id = 0, { type = null, project = null, limit = 200 } = {}) {
    const rows = this.db.prepare(`SELECT * FROM events WHERE id > ?
      ${type ? "AND type = ?" : ""} ${project ? "AND project = ?" : ""} ORDER BY id LIMIT ?`)
      .all(...[id, ...(type ? [type] : []), ...(project ? [project] : []), limit]);
    return rows.map(r => ({ ...r, payload: JSON.parse(String(r.payload)) }));
  }
}
