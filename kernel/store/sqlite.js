// kernel/store/sqlite.js: the durable store on the home (hot data, the kernel's own records: grants, tasks, anything the Space keeps before a Twenty
// store is added). It is the reference store made durable: the same behaviour, so the same conformance suite is the definition of it, with every
// change written through to the home's SQLite database (core/store) in the same turn. The state is loaded once at open; rows live in the kernel's own
// `kernel_*` tables, never a module's. A change is one transaction (the record and its change-feed entry), so a crash leaves either both or neither.
import { createMemoryStore } from "./memory.js";

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS kernel_types (name TEXT PRIMARY KEY, def TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kernel_records (type TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY (type, id));
  CREATE TABLE IF NOT EXISTS kernel_changes (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL);
`;

/** @param {{ db: import("node:sqlite").DatabaseSync, clock?: () => number, hook?: (op: string, args: any[]) => void }} cfg */
export function createSqliteStore(cfg) {
  const { db } = cfg;
  db.exec(MIGRATION);
  const types = db.prepare("SELECT def FROM kernel_types").all().map((/** @type {any} */ r) => JSON.parse(r.def));
  const records = db.prepare("SELECT * FROM kernel_records").all().map((/** @type {any} */ r) => ({ type: r.type, id: r.id, version: r.version, data: JSON.parse(r.data), created_at: r.created_at, updated_at: r.updated_at, ...(r.deleted_at !== null ? { deleted_at: r.deleted_at } : {}) }));
  const changes = db.prepare("SELECT entry FROM kernel_changes ORDER BY seq").all().map((/** @type {any} */ r) => JSON.parse(r.entry));
  const putType = db.prepare("INSERT INTO kernel_types (name, def) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET def = excluded.def");
  const delType = db.prepare("DELETE FROM kernel_types WHERE name = ?");
  const putRec = db.prepare("INSERT INTO kernel_records (type, id, version, data, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET version = excluded.version, data = excluded.data, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at");
  const putChange = db.prepare("INSERT INTO kernel_changes (seq, entry) VALUES (?, ?)");
  let pending = null;
  const store = createMemoryStore({
    clock: cfg.clock, hook: cfg.hook, initial: { types, records, changes },
    persist: {
      type: (name, def) => { if (def) putType.run(name, JSON.stringify(def)); else delType.run(name); },
      // The record and its change entry are one transaction: the memory store calls them back to back.
      record: r => { pending = r; },
      change: e => {
        db.exec("BEGIN");
        try {
          const r = /** @type {any} */ (pending);
          putRec.run(r.type, r.id, r.version, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted_at ?? null);
          putChange.run(Number(e.cursor.slice(1)), JSON.stringify(e));
          db.exec("COMMIT");
        } catch (err) { db.exec("ROLLBACK"); throw err; }
        pending = null;
      },
    },
  });
  return { ...store, async version() { return { store: "sqlite", version: "1", conformance: (await store.version()).conformance }; } };
}
