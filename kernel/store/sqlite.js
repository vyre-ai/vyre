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
import { planPage, planAggregate, fieldInfo } from "./sqlite-query.js";
import { canonical } from "../core/canonical.js";
import { encodeCursor, fieldOf } from "./query.js";

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS kernel_types (name TEXT PRIMARY KEY, def TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kernel_records (type TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY (type, id));
  CREATE TABLE IF NOT EXISTS kernel_changes (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kernel_attrs (urn TEXT PRIMARY KEY, attrs TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kernel_flags (name TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
// The full-text index: one row per non-sealed text field of each live record (rowid = record rowid * 1024 + the field's position), holding the field's text lowered by the same JS call
// the reference search uses. Trigram and case-sensitive, so a word of three or more characters is found exactly when the reference's substring test finds it, and a record's score
// (one point per field per word it holds) is a count of matching rows. A sealed field is never in it. Written in the same transaction as the record.
const FTS = "CREATE VIRTUAL TABLE IF NOT EXISTS kernel_ftf USING fts5(doc, tokenize = 'trigram case_sensitive 1')";
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
  let ftsOk = true;
  try { db.exec("DROP TABLE IF EXISTS kernel_fts"); db.exec(FTS); } catch { ftsOk = false; } // a SQLite built without FTS5 keeps the LIKE narrowing
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
  const counts = { pushed: 0, fell: 0, agg: 0 };
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
  // ---- full-text index (kernel_fts) ----
  const getRowid = db.prepare("SELECT rowid AS r FROM kernel_records WHERE type = ? AND id = ?");
  const getFlag = db.prepare("SELECT value FROM kernel_flags WHERE name = ?");
  const setFlag = db.prepare("INSERT INTO kernel_flags (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value");
  const FIELD_SLOTS = 1024;
  /** The text a record is searched by: one lowered string per non-sealed text field, with the field's position. A type with more fields than slots is not indexed (searched by scan). */
  const partsOf = (/** @type {any} */ r) => {
    const def = defs.get(r.type);
    if (!def || def.fields.length > FIELD_SLOTS) return null;
    /** @type {[number, string][]} */ const parts = [];
    def.fields.forEach((/** @type {any} */ f, /** @type {number} */ i) => {
      if (f.kind === "sealed") return;
      const v = fieldOf(r, f.name);
      const text = typeof v === "string" ? v : Array.isArray(v) && v.every(x => typeof x === "string") ? v.join(" ") : "";
      if (text) parts.push([i, text.toLowerCase()]);
    });
    return parts;
  };
  const ftsDel = ftsOk ? db.prepare("DELETE FROM kernel_ftf WHERE rowid >= ? AND rowid < ?") : null;
  const ftsPut = ftsOk ? db.prepare("INSERT INTO kernel_ftf (rowid, doc) VALUES (?, ?)") : null;
  const ftsGet = ftsOk ? db.prepare("SELECT doc FROM kernel_ftf WHERE rowid = ?") : null;
  const ftsDelOne = ftsOk ? db.prepare("DELETE FROM kernel_ftf WHERE rowid = ?") : null;
  // (FTS5 scans the whole table for a rowid range, so a record's few field rows are read, replaced and deleted by their own rowids.)
  const ftsWrite = (/** @type {number} */ rid, /** @type {any} */ r) => {
    const def = defs.get(r.type);
    const slots = def ? Math.min(def.fields.length, FIELD_SLOTS) : 0;
    const want = new Map(r.deleted_at ? [] : partsOf(r) || []);
    for (let i = 0; i < slots; i++) {
      const row = /** @type {any} */ (/** @type {any} */ (ftsGet).get(rid * FIELD_SLOTS + i));
      const text = want.get(i);
      // An edit that leaves a field's searched text as it was (most do) leaves its row alone.
      if (row ? row.doc === text : text === undefined) continue;
      if (row) /** @type {any} */ (ftsDelOne).run(rid * FIELD_SLOTS + i);
      if (text !== undefined) /** @type {any} */ (ftsPut).run(rid * FIELD_SLOTS + i, text);
    }
  };
  /** Bring one record's entries in step with the record. Called inside the write's transaction. */
  const ftsSync = (/** @type {any} */ r) => {
    if (!ftsOk) return;
    const row = /** @type {any} */ (getRowid.get(r.type, r.id));
    if (row) ftsWrite(row.r, r);
  };
  let ftsBuilt = false, ftsGen = 0;
  /** Index every record, in slices (the loop is never held). Run when the index is new to a database that has records, and again when a type's definition changes (a field's position or kind may have). */
  const ftsBuild = async () => {
    if (!ftsOk) return;
    const walk = db.prepare("SELECT rowid AS rid, * FROM kernel_records WHERE rowid > ? ORDER BY rowid LIMIT 400");
    const gen = ftsGen;
    let after = 0;
    for (;;) {
      if (gen !== ftsGen) return; // a newer build owns the index now
      const chunk = /** @type {any[]} */ (walk.all(after));
      if (!chunk.length) break;
      db.exec("BEGIN");
      try {
        for (const r of chunk) ftsWrite(r.rid, { type: r.type, id: r.id, data: JSON.parse(r.data), version: r.version, created_at: r.created_at, updated_at: r.updated_at, deleted_at: r.deleted_at });
        db.exec("COMMIT");
      } catch (err) { db.exec("ROLLBACK"); throw err; }
      after = chunk[chunk.length - 1].rid;
      await new Promise(res => setImmediate(res));
    }
    if (gen !== ftsGen) return;
    setFlag.run("ftf_built", "1");
    ftsBuilt = true;
  };
  /** Resolves when the index covers every record. */
  let ftsReady = (async () => { if (ftsOk && getFlag.get("ftf_built")) { ftsBuilt = true; return; } await ftsBuild(); })();
  /** A type's definition changed: rows written under the old one may sit in positions the new one does not use, so the index is emptied and built again (searches scan meanwhile). */
  const ftsRestart = () => {
    if (!ftsOk) return;
    ftsBuilt = false; ftsGen++;
    db.exec("DELETE FROM kernel_flags WHERE name = 'ftf_built'");
    db.exec("DELETE FROM kernel_ftf");
    ftsReady = ftsReady.then(() => ftsBuild());
    ftsReady.catch(() => {});
  };
  ftsReady.catch(() => {});

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
      /** An aggregate as one GROUP BY statement (rows come back grouped; the groups are ordered here as the reference orders them), or null to stream the rows instead. */
      aggregateQuery(spec) {
        const plan = planAggregate({ type, def: defs.get(type), spec, ascii: field => isAscii(type, field) });
        if (!plan) { counts.fell++; return null; }
        counts.pushed++; counts.agg++;
        const got = /** @type {any[]} */ (db.prepare(plan.sql).all(...plan.args));
        return got.map(row => ({
          group: Object.fromEntries(plan.groups.map((g, k) => [g.field, row[`g${k}`] === null || row[`g${k}`] === undefined ? null : g.bool ? row[`g${k}`] === 1 : row[`g${k}`]])),
          values: Object.fromEntries(plan.measures.map((m, k) => [m.name, row[`m${k}`] === undefined ? null : row[`m${k}`]])),
        })).sort((a, b) => (canonical(a.group) < canonical(b.group) ? -1 : 1));
      },
      candidates(spec) {
        const eq = equalities(spec && spec.filter).filter(([f]) => ensureIndex(f));
        if (!eq.length || !TYPE_NAME.test(type)) return this.values();
        const where = eq.map(([f]) => `json_extract(data, '$.${f}') = ?`).join(" AND ");
        return rows(db.prepare(`SELECT * FROM kernel_records WHERE type = '${type}' AND ${where}`).iterate(...eq.map(([, v]) => v)));
      },
      /**
       * The best `n` records for these words by the reference ranking (score, then id), ranked in SQL: a record's score is the number of matching field rows, counted per word and
       * summed, so no record is read but the winners. A word of three or more characters is found by the index, a shorter one by a scan of the field texts. Null when the index cannot
       * answer (still being built, a type too wide to index): the caller takes `searchCandidates`.
       */
      searchTop(words, /** @type {number} */ n, /** @type {{ score: number, id: string } | undefined} */ after) {
        if (!(ftsOk && ftsBuilt && words.length && (defs.get(type)?.fields.length ?? FIELD_SLOTS + 1) <= FIELD_SLOTS)) return null;
        const per = words.map(w => ([...w].length >= 3 ? "SELECT rowid >> 10 AS rid FROM kernel_ftf WHERE kernel_ftf MATCH ?" : "SELECT rowid >> 10 AS rid FROM kernel_ftf WHERE instr(doc, ?) > 0"));
        const args = words.map(w => ([...w].length >= 3 ? `"${w.replace(/"/g, '""')}"` : w));
        return rows(db.prepare(`SELECT k.* FROM (SELECT rid, count(*) AS sc FROM (${per.join(" UNION ALL ")}) GROUP BY rid) h CROSS JOIN kernel_records k ON k.rowid = h.rid WHERE k.type = ? AND k.deleted_at IS NULL${after ? " AND (h.sc < ? OR (h.sc = ? AND k.id > ?))" : ""} ORDER BY h.sc DESC, k.id LIMIT ?`).all(...args, type, ...(after ? [after.score, after.score, after.id] : []), n));
      },
      searchCandidates(words) {
        if (!words.length) return this.values();
        // Words of three or more characters: the full-text index finds every record whose text holds one of them as a substring (the same test the exact code applies next, so this
        // narrows and never drops a match). A shorter word, or an index still being built, takes the scan.
        if (ftsOk && ftsBuilt && words.every(w => [...w].length >= 3) && (defs.get(type)?.fields.length ?? FIELD_SLOTS + 1) <= FIELD_SLOTS) {
          const match = words.map(w => `"${w.replace(/"/g, '""')}"`).join(" OR ");
          return rows(db.prepare("SELECT k.* FROM kernel_records k WHERE k.type = ? AND k.deleted_at IS NULL AND k.rowid IN (SELECT rowid >> 10 FROM kernel_ftf WHERE kernel_ftf MATCH ?)").iterate(type, match));
        }
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
      type: (name, def) => { if (def) { const had = defs.get(name); putType.run(name, JSON.stringify(def)); defs.set(name, def); if (had && canonical(had) !== canonical(def)) ftsRestart(); } else { delType.run(name); defs.delete(name); } for (const k of [...asciiOf.keys()]) if (k.startsWith(`${name}.`)) asciiOf.delete(k); },
      // The record and its change entry are one transaction: the memory store calls them back to back.
      record: r => { pending = r; },
      change: e => {
        db.exec("BEGIN");
        try {
          const r = /** @type {any} */ (pending);
          noteWrite(r);
          putRec.run(r.type, r.id, r.version, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted_at ?? null);
          ftsSync(r);
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
    /** Does any record under this urn prefix have this attribute value? (a scan of that type's attribute rows) */
    anyWith(/** @type {string} */ prefix, /** @type {string} */ key, /** @type {string} */ value) { return Boolean(db.prepare("SELECT 1 FROM kernel_attrs WHERE urn >= ? AND urn < ? AND json_extract(attrs, ?) = ? LIMIT 1").get(prefix, `${prefix.slice(0, -1)}0`, `$.${key}`, value)); },
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
  return { ...store, meta, /** What is held in memory: for the bound's tests and the load measurements. */ get ftsReady() { return ftsReady; }, stats: () => ({ fts_built: ftsBuilt, aggregate_pushed: counts.agg, query_pushed: counts.pushed, query_streamed: counts.fell, hot_rows: caches.reduce((n, c) => n + c.size, 0), hot_attrs: attrCache.size, changes_in_memory: 0 }), async version() { return { store: "sqlite", version: "1", conformance: (await store.version()).conformance }; } };
}
