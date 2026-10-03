// kernel/store/sqlite.js: the durable store on the home (hot data, the kernel's own records: grants, tasks, anything the Space keeps before a Twenty
// store is added). It is the reference store made durable: the same behaviour, so the same conformance suite is the definition of it, with every
// change written through to the home's SQLite database (core/store) in the same turn. Rows live in the kernel's own `kernel_*` tables, never a module's.
// A change is one transaction (the record and its change-feed entry), so a crash leaves either both or neither.
//
// BOUNDED IN MEMORY. Nothing is loaded at open but the type definitions. A record is read from its row when it is asked for and kept in a small LRU of hot rows; the change
// feed (the before and after of every write) lives on disk only and is read by cursor; a query on a field with an equality filter is narrowed by the database (with an index on
// that field made the first time it is used) before the same page and aggregate code applies the exact rules, and a search is narrowed by its words. So memory follows the
// working set, not the history and not the number of records.
import { createMemoryStore } from "./memory.js";
import { planPage, fieldInfo } from "./sqlite-query.js";
import { encodeCursor } from "./query.js";

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS kernel_types (name TEXT PRIMARY KEY, def TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kernel_records (type TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY (type, id));
  CREATE TABLE IF NOT EXISTS kernel_changes (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kernel_attrs (urn TEXT PRIMARY KEY, attrs TEXT NOT NULL);
`;
const HOT_ROWS = 5000;
const HOT_ATTRS = 5000;
const MAX_INDEXES = 24;
const TYPE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(["id", "version", "type", "created_at", "updated_at"]);
const likeEsc = (/** @type {string} */ s) => s.replace(/[\\%_]/g, "\\$&");

/** The equality conditions a filter requires (a single `eq`, or every `eq` under `and`), as `[field, value]`; others are left to the exact code. @param {any} f @returns {[string, string | number][]} */
function equalities(f) {
  if (!f || typeof f !== "object") return [];
  if (Array.isArray(f.and)) return f.and.flatMap((/** @type {any} */ x) => equalities(x));
  // `id`, `version`, `type` and the two times are the row's own columns, not fields of its data: the exact code reads them from the row, so they are not pushed down.
  if (f.op === "eq" && typeof f.field === "string" && FIELD.test(f.field) && !RESERVED.has(f.field) && (typeof f.value === "string" || (typeof f.value === "number" && Number.isFinite(f.value)))) return [[f.field, f.value]];
  return [];
}

/** @param {{ db: import("node:sqlite").DatabaseSync, clock?: () => number, hook?: (op: string, args: any[]) => void, hotRows?: number }} cfg */
export function createSqliteStore(cfg) {
  const { db } = cfg;
  db.exec(MIGRATION);
  const hot = cfg.hotRows ?? HOT_ROWS;
  const types = db.prepare("SELECT def FROM kernel_types").all().map((/** @type {any} */ r) => JSON.parse(r.def));
  /** @type {Map<string, any>} the type definitions, for the query planner */ const defs = new Map(types.map((/** @type {any} */ t) => [t.name, t]));
  /** @type {Map<string, boolean>} `type.field` -> whether every value it holds is printable ASCII (so SQLite's byte order is the reference's order); a write of anything else clears it */ const asciiOf = new Map();
  const putType = db.prepare("INSERT INTO kernel_types (name, def) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET def = excluded.def");
  const delType = db.prepare("DELETE FROM kernel_types WHERE name = ?");
  const putRec = db.prepare("INSERT INTO kernel_records (type, id, version, data, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET version = excluded.version, data = excluded.data, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at");
  const putChange = db.prepare("INSERT INTO kernel_changes (seq, entry) VALUES (?, ?)");
  const getRow = db.prepare("SELECT * FROM kernel_records WHERE type = ? AND id = ?");
  const hasRow = db.prepare("SELECT 1 AS x FROM kernel_records WHERE type = ? AND id = ?");
  const allRows = db.prepare("SELECT * FROM kernel_records WHERE type = ?");
  const changeRange = db.prepare("SELECT entry FROM kernel_changes WHERE seq > ? AND seq <= ? ORDER BY seq");
  const getAttrs = db.prepare("SELECT attrs FROM kernel_attrs WHERE urn = ?");
  const putAttrs = db.prepare("INSERT INTO kernel_attrs (urn, attrs) VALUES (?, ?) ON CONFLICT(urn) DO UPDATE SET attrs = excluded.attrs");
  const parse = (/** @type {any} */ r) => ({ type: r.type, id: r.id, version: r.version, data: JSON.parse(r.data), created_at: r.created_at, updated_at: r.updated_at, ...(r.deleted_at !== null && r.deleted_at !== undefined ? { deleted_at: r.deleted_at } : {}) });
  let changeCount = /** @type {any} */ (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM kernel_changes").get()).n;
  const indexed = new Set(/** @type {any[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'kidx_%'").all()).map(r => r.name));

  /** @param {string} type @returns {import("./memory.js").Table} */
  /** @type {Map<string, any>[]} every type's hot rows, for `stats` */ const caches = [];
  const counts = { pushed: 0, fell: 0 };
  /** Is every value of this text field printable ASCII? Asked once per field, by a scan; kept true only while every write agrees. */
  const isAscii = (/** @type {string} */ type, /** @type {string} */ field) => {
    const key = `${type}.${field}`;
    if (asciiOf.has(key)) return /** @type {boolean} */ (asciiOf.get(key));
    const info = fieldInfo(defs.get(type), field);
    let ok = false;
    if (info && info.cls === "string" && TYPE_NAME.test(type) && FIELD.test(field)) ok = !db.prepare(`SELECT 1 FROM kernel_records WHERE type = '${type}' AND ${info.expr} GLOB '*[^ -~]*' LIMIT 1`).get();
    asciiOf.set(key, ok);
    return ok;
  };
  const noteWrite = (/** @type {any} */ r) => {
    for (const [key, ok] of asciiOf) {
      if (!ok || !key.startsWith(`${r.type}.`)) continue;
      const v = r.data && r.data[key.slice(r.type.length + 1)];
      if (typeof v === "string" && /[^\x20-\x7e]/.test(v)) asciiOf.set(key, false);
    }
  };
  const table = type => {
    /** @type {Map<string, any>} the hot rows, least recently used first */ const cache = new Map();
    caches.push(cache);
    const keep = (/** @type {string} */ id, /** @type {any} */ r) => { cache.delete(id); cache.set(id, r); if (cache.size > hot) cache.delete(/** @type {string} */ (cache.keys().next().value)); return r; };
    /** The rows of a statement as they are read, one at a time (the hot copy where there is one): a scan holds one row, never the type. */
    const rows = function* (/** @type {Iterable<any>} */ list) { for (const r of list) yield cache.get(r.id) ?? parse(r); };
    /** Make an index on a field the first time an equality filter names it: a partial expression index, used by exactly this expression. */
    const ensureIndex = (/** @type {string} */ field) => {
      const name = `kidx_${type}_${field}`;
      if (indexed.has(name)) return true;
      if (indexed.size >= MAX_INDEXES || !TYPE_NAME.test(type)) return false;
      db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON kernel_records (json_extract(data, '$.${field}')) WHERE type = '${type}'`);
      indexed.add(name);
      return true;
    };
    return {
      get(id) { const c = cache.get(id); if (c) return keep(id, c); const r = getRow.get(type, id); return r ? keep(id, parse(r)) : undefined; },
      has(id) { return cache.has(id) || Boolean(hasRow.get(type, id)); },
      set(id, r) { keep(id, r); },
      values() { return rows(allRows.iterate(type)); },
      /**
       * One page of a query as ONE indexed statement, when the planner can prove it answers exactly what the reference code would (kernel/store/sqlite-query.js); null otherwise, and
       * the caller streams the rows through the reference code instead.
       */
      pageQuery(spec) {
        const def = defs.get(type);
        const plan = planPage({ type, def, spec, ascii: field => isAscii(type, field) });
        if (!plan) { counts.fell++; return null; }
        if ("error" in plan) return plan;
        counts.pushed++;
        if (plan.index && !indexed.has(plan.index.name) && indexed.size < MAX_INDEXES) { db.exec(plan.index.sql); indexed.add(plan.index.name); }
        const got = /** @type {any[]} */ (db.prepare(plan.sql).all(...plan.args));
        const mine = got.slice(0, plan.limit).map(r => cache.get(r.id) ?? parse(r));
        return { rows: mine, ...(got.length > plan.limit && mine.length ? { next_cursor: encodeCursor(mine[mine.length - 1], spec.sort) } : {}) };
      },
      candidates(spec) {
        const eq = equalities(spec && spec.filter).filter(([f]) => ensureIndex(f));
        if (!eq.length || !TYPE_NAME.test(type)) return this.values();
        const where = eq.map(([f]) => `json_extract(data, '$.${f}') = ?`).join(" AND ");
        return rows(db.prepare(`SELECT * FROM kernel_records WHERE type = '${type}' AND ${where}`).iterate(...eq.map(([, v]) => v)));
      },
      searchCandidates(words) {
        if (!words.length) return this.values();
        const any = words.map(() => "data LIKE ? ESCAPE '\\'").join(" OR ");
        return rows(db.prepare(`SELECT * FROM kernel_records WHERE type = ? AND deleted_at IS NULL AND (${any})`).iterate(type, ...words.map(w => `%${likeEsc(w)}%`)));
      },
    };
  };
  const changes = {
    get length() { return changeCount; },
    push() { changeCount++; },
    slice(/** @type {number} */ from, /** @type {number} */ to) { return /** @type {any[]} */ (changeRange.all(from, to)).map(r => JSON.parse(r.entry)); },
  };

  let pending = null;
  const store = createMemoryStore({
    clock: cfg.clock, hook: cfg.hook, initial: { types, records: [], changes: [] }, backing: { table, changes },
    persist: {
      type: (name, def) => { if (def) { putType.run(name, JSON.stringify(def)); defs.set(name, def); } else { delType.run(name); defs.delete(name); } for (const k of [...asciiOf.keys()]) if (k.startsWith(`${name}.`)) asciiOf.delete(k); },
      // The record and its change entry are one transaction: the memory store calls them back to back.
      record: r => { pending = r; },
      change: e => {
        db.exec("BEGIN");
        try {
          const r = /** @type {any} */ (pending);
          noteWrite(r);
          putRec.run(r.type, r.id, r.version, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted_at ?? null);
          putChange.run(Number(e.cursor.slice(1)), JSON.stringify(e));
          db.exec("COMMIT");
        } catch (err) { db.exec("ROLLBACK"); throw err; }
        pending = null;
      },
    },
  });
  /** @type {Map<string, any>} the kernel attributes of recently written records, in front of the table that keeps them all */ const attrCache = new Map();
  /** The gateway's kernel attributes per record (owner, created_by, project, sensitivity): on disk, a small LRU in front. */
  const meta = {
    get(/** @type {string} */ u) {
      if (attrCache.has(u)) { const v = attrCache.get(u); attrCache.delete(u); attrCache.set(u, v); return v; }
      const r = /** @type {any} */ (getAttrs.get(u));
      if (!r) return undefined;
      const v = JSON.parse(r.attrs);
      attrCache.set(u, v); if (attrCache.size > HOT_ATTRS) attrCache.delete(/** @type {string} */ (attrCache.keys().next().value));
      return v;
    },
    set(/** @type {string} */ u, /** @type {any} */ v) { putAttrs.run(u, JSON.stringify(v)); attrCache.set(u, v); if (attrCache.size > HOT_ATTRS) attrCache.delete(/** @type {string} */ (attrCache.keys().next().value)); },
  };
  return { ...store, meta, /** What is held in memory: for the bound's tests and the load measurements. */ stats: () => ({ query_pushed: counts.pushed, query_streamed: counts.fell, hot_rows: caches.reduce((n, c) => n + c.size, 0), hot_attrs: attrCache.size, changes_in_memory: 0 }), async version() { return { store: "sqlite", version: "1", conformance: (await store.version()).conformance }; } };
}
