// kernel/store/sqlite-log.js: the hash-chained event log made durable on the home (K5; the grants store, the limits and the audit rebuild from it). The
// reference log (kernel/core/events.js) written through to the home's SQLite database: one row per event, its salt beside it (erased with the data), and
// each consumer's cursor. An event is written before it counts as appended, so a crash leaves a log that is a prefix of what was acknowledged, never a
// gap; `verify` recomputes the chain from what was read back, so a row edited on disk is found by the same check as one edited in memory.
import { createEventLog } from "../core/events.js";

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS kernel_events (seq INTEGER PRIMARY KEY, space TEXT NOT NULL, event TEXT NOT NULL, salt TEXT);
  CREATE TABLE IF NOT EXISTS kernel_cursors (name TEXT PRIMARY KEY, seq INTEGER NOT NULL);
`;

/** @param {{ db: import("node:sqlite").DatabaseSync, space: string, clock?: () => number, rand?: (n: number) => Uint8Array }} cfg */
export function createSqliteEventLog(cfg) {
  const { db } = cfg;
  db.exec(MIGRATION);
  const rows = db.prepare("SELECT seq, event, salt FROM kernel_events WHERE space = ? ORDER BY seq").all(cfg.space);
  const events = rows.map((/** @type {any} */ r) => JSON.parse(r.event));
  const salts = rows.filter((/** @type {any} */ r) => r.salt !== null).map((/** @type {any} */ r) => /** @type {[number, string]} */ ([r.seq, r.salt]));
  const cursors = db.prepare("SELECT name, seq FROM kernel_cursors").all().map((/** @type {any} */ r) => /** @type {[string, number]} */ ([r.name, r.seq]));
  const ins = db.prepare("INSERT INTO kernel_events (seq, space, event, salt) VALUES (?, ?, ?, ?)");
  const era = db.prepare("UPDATE kernel_events SET event = ?, salt = NULL WHERE seq = ? AND space = ?");
  const cur = db.prepare("INSERT INTO kernel_cursors (name, seq) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET seq = excluded.seq");
  return createEventLog({
    space: cfg.space, clock: cfg.clock, rand: cfg.rand,
    initial: { events, salts, cursors },
    persist: {
      append: (e, salt) => { ins.run(e.seq, cfg.space, JSON.stringify(e), salt); },
      erase: (seq, e) => { era.run(JSON.stringify(e), seq, cfg.space); },
      cursor: (name, seq) => { cur.run(name, seq); },
    },
  });
}
