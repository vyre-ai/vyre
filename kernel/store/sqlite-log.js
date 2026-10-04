// kernel/store/sqlite-log.js: the hash-chained event log made durable on the home (K5; the grants store, the limits and the audit rebuild from it). The
// reference log (kernel/core/events.js) written through to the home's SQLite database: one row per event, its salt beside it (erased with the data), and
// each consumer's cursor. An event is written before it counts as appended, so a crash leaves a log that is a prefix of what was acknowledged, never a
// gap; `verify` recomputes the chain from what was read back, so a row edited on disk is found by the same check as one edited in memory.
//
// BOUNDED IN MEMORY. Only a recent window of events is held (`window`, by count and by bytes); the log is read back from these tables when an older event is asked for
// or a scan walks it. The columns `type`, `subject`, `corr`, `actor` and `ref` are generated from the event so the database can filter by index (a by-type read is an index
// scan, not a parse of every row). Opening reads the last window and two counters, never the whole log: a million events open as fast as a thousand.
import { createEventLog } from "../core/events.js";

// The filter columns are GENERATED from the event JSON (virtual, indexed), so they cannot disagree with the event a reader is handed: there is nothing to write and nothing a
// database edit can change without changing the event itself (which the chain then catches). `ref` is the id a message event's data names, the one thing looked up by value.
const GENERATED = {
  type: "json_extract(event, '$.type')",
  subject: "json_extract(event, '$.subject')",
  corr: "json_extract(event, '$.corr')",
  actor: "json_extract(event, '$.actor')",
  ref: "CASE WHEN json_extract(event, '$.type') LIKE 'message.%' AND json_type(event, '$.data.id') = 'text' THEN substr(json_extract(event, '$.data.id'), 1, 120) END",
};
const gen = (/** @type {string} */ c) => `${c} TEXT GENERATED ALWAYS AS (${GENERATED[/** @type {keyof typeof GENERATED} */ (c)]}) VIRTUAL`;
const MIGRATION = `
  CREATE TABLE IF NOT EXISTS kernel_events (seq INTEGER PRIMARY KEY, space TEXT NOT NULL, event TEXT NOT NULL, salt TEXT, ${Object.keys(GENERATED).map(gen).join(", ")});
  CREATE TABLE IF NOT EXISTS kernel_cursors (name TEXT PRIMARY KEY, seq INTEGER NOT NULL);
`;
const like = (/** @type {string} */ s) => s.replace(/[\\%_]/g, "\\$&");

/** @param {{ db: import("node:sqlite").DatabaseSync, space: string, clock?: () => number, rand?: (n: number) => Uint8Array, window?: { events?: number, bytes?: number } }} cfg */
export function createSqliteEventLog(cfg) {
  const { db } = cfg;
  db.exec(MIGRATION);
  // A database made with plain filter columns (copies of the event that nothing tied to it) has them replaced by generated ones; a database whose column is not generated
  // for any other reason is refused rather than read.
  const info = /** @type {any[]} */ (db.prepare("PRAGMA table_xinfo(kernel_events)").all());
  const plain = Object.keys(GENERATED).filter(c => info.some(i => i.name === c && i.hidden === 0));
  if (plain.length) {
    db.exec("DROP INDEX IF EXISTS kernel_events_ref; DROP INDEX IF EXISTS kernel_events_type; DROP INDEX IF EXISTS kernel_events_subject; DROP INDEX IF EXISTS kernel_events_corr;");
    for (const c of plain) db.exec(`ALTER TABLE kernel_events DROP COLUMN ${c}`);
  }
  for (const c of Object.keys(GENERATED)) if (!info.some(i => i.name === c && i.hidden !== 0) ) db.exec(`ALTER TABLE kernel_events ADD COLUMN ${gen(c)}`);
  const after = /** @type {any[]} */ (db.prepare("PRAGMA table_xinfo(kernel_events)").all());
  for (const c of Object.keys(GENERATED)) if (!after.some(i => i.name === c && i.hidden !== 0)) throw new Error(`the event log's ${c} column is not generated from the event`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS kernel_events_ref ON kernel_events (space, ref) WHERE ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS kernel_events_type ON kernel_events (space, type, seq);
    CREATE INDEX IF NOT EXISTS kernel_events_subject ON kernel_events (space, subject, seq);
    CREATE INDEX IF NOT EXISTS kernel_events_corr ON kernel_events (space, corr, seq) WHERE corr IS NOT NULL;
  `);
  const win = cfg.window?.events ?? 2000;
  const last = /** @type {any[]} */ (db.prepare("SELECT seq, event, salt FROM kernel_events WHERE space = ? ORDER BY seq DESC LIMIT ?").all(cfg.space, win)).reverse();
  const window = last.map(r => JSON.parse(r.event));
  const salts = last.filter(r => r.salt !== null).map(r => /** @type {[number, string]} */ ([r.seq, r.salt]));
  const cursors = db.prepare("SELECT name, seq FROM kernel_cursors").all().map((/** @type {any} */ r) => /** @type {[string, number]} */ ([r.name, r.seq]));
  const ins = db.prepare("INSERT INTO kernel_events (seq, space, event, salt) VALUES (?, ?, ?, ?)");
  const era = db.prepare("UPDATE kernel_events SET event = ?, salt = NULL WHERE seq = ? AND space = ?");
  const cur = db.prepare("INSERT INTO kernel_cursors (name, seq) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET seq = excluded.seq");
  const latestStmt = db.prepare("SELECT event FROM kernel_events WHERE space = ? AND subject = ? AND seq < ? AND json_extract(event, '$.data.version_hash') IS NOT NULL ORDER BY seq DESC LIMIT 1");
  const one = db.prepare("SELECT event, salt FROM kernel_events WHERE seq = ? AND space = ?");
  return createEventLog({
    space: cfg.space, clock: cfg.clock, rand: cfg.rand, window: cfg.window,
    initial: { count: window.length ? window[window.length - 1].seq : 0, head: window.length ? window[window.length - 1].hash : undefined, window, salts, cursors },
    persist: {
      append: (e, salt) => { const text = JSON.stringify(e); ins.run(e.seq, cfg.space, text, salt); return text.length; },
      erase: (seq, e) => { era.run(JSON.stringify(e), seq, cfg.space); },
      cursor: (name, seq) => { cur.run(name, seq); },
      get: seq => { const r = /** @type {any} */ (one.get(seq, cfg.space)); return r ? { event: JSON.parse(r.event), salt: r.salt } : null; },
      /** The newest event before `before` about a subject whose data carries a version hash. @param {string} subject @param {number} before */
      latest: (subject, before) => { const r = /** @type {any} */ (latestStmt.get(cfg.space, subject, before)); return r ? JSON.parse(r.event) : null; },
      /** Events after `after` and before `before`, oldest first, the filter done by the database. @param {{ after: number, before?: number, filter?: any, limit: number }} q */
      range: q => {
        const f = q.filter || {};
        const where = ["space = ?", "seq > ?"], args = /** @type {any[]} */ ([cfg.space, q.after]);
        if (q.before !== undefined) { where.push("seq < ?"); args.push(q.before); }
        const t = f.type;
        if (t && t !== "*") { if (t.endsWith(".*")) { where.push("type LIKE ? ESCAPE '\\'"); args.push(like(t.slice(0, -1)) + "%"); } else { where.push("type = ?"); args.push(t); } }
        if (f.subject_prefix) { const p = f.subject_prefix.replace(/\/$/, ""); where.push("(subject = ? OR (subject >= ? AND subject < ?))"); args.push(f.subject_prefix, p + "/", p + "0"); }
        if (f.corr) { where.push("corr = ?"); args.push(f.corr); }
        if (f.actor) { where.push("actor = ?"); args.push(f.actor); }
        if (f.ref) { where.push("ref = ?"); args.push(f.ref); }
        const rows = /** @type {any[]} */ (db.prepare(`SELECT event FROM kernel_events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`).all(...args, q.limit));
        return rows.map(r => JSON.parse(r.event));
      },
    },
  });
}
