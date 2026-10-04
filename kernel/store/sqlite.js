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
  CREATE INDEX IF NOT EXISTS kernel_attrs_project ON kernel_attrs (json_extract(attrs, '$.project'), urn);
  CREATE INDEX IF NOT EXISTS kernel_attrs_owner ON kernel_attrs (json_extract(attrs, '$.owner'), urn);
  CREATE TABLE IF NOT EXISTS kernel_flags (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kernel_counts (type TEXT NOT NULL, field TEXT NOT NULL, val TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (type, field, val)) WITHOUT ROWID;
`;
// The full-text index: one row per non-sealed text field of each live record (rowid = record rowid * 1024 + the field's position), holding the field's text lowered by the same JS call
// the reference search uses. Trigram and case-sensitive, so a word of three or more characters is found exactly when the reference's substring test finds it, and a record's score
// (one point per field per word it holds) is a count of matching rows. A sealed field is never in it. Written in the same transaction as the record.
const FTS = "CREATE VIRTUAL TABLE IF NOT EXISTS kernel_ftf USING fts5(doc, tokenize = 'trigram case_sensitive 1')";
const HOT_ROWS = 5000;
const HOT_ATTRS = 5000;
const MAX_INDEXES = 48;
// Index slots belong to a type: a type holds at most PER_TYPE of the indexes the store makes on demand (kidx_, kq_, kg_), the least recently used one is dropped for a new shape, and a type
// builds at most BUILDS_PER_MIN of them a minute (a build scans the type, about 0.7 s at 500,000 records), so one caller cannot push another's hot shapes out or stall the process by
// trying shapes. A shape that finds no slot runs unindexed, which is slower and still exact.
const PER_TYPE = 8, BUILDS_PER_MIN = 6;
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

/** @param {{ db: import("node:sqlite").DatabaseSync, clock?: () => number, hook?: (op: string, args: any[]) => void, hotRows?: number, searchRare?: number }} cfg */
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
  const indexed = new Set(/** @type {any[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'kidx_%' OR name LIKE 'kg_%' OR name LIKE 'kq_%')").all()).map(r => r.name));

  /** @type {Map<string, number>} index name -> tick of last use */ const used = new Map();
  /** @type {Map<string, number[]>} type -> times of recent builds */ const built = new Map();
  let tick = 0;
  /**
   * Is this index there, making it if the type has a slot (evicting its least recently used) and the build budget allows, and only for a caller whose read of the type was allowed.
   * @param {string} type @param {string} name @param {string} sql @param {boolean} [allowed]
   */
  const slot = (type, name, sql, allowed = true) => {
    if (indexed.has(name)) { used.set(name, ++tick); return true; }
    if (!allowed || !TYPE_NAME.test(type)) return false;
    const now = Date.now(), recent = (built.get(type) || []).filter(t => now - t < 60_000);
    if (recent.length >= BUILDS_PER_MIN) return false;
    const mine = [...indexed].filter(n => n.startsWith(`kidx_${type}_`) || n.startsWith(`kq_${type}_`) || n.startsWith(`kg_${type}_`));
    if (mine.length >= PER_TYPE || indexed.size >= MAX_INDEXES) {
      const pool = mine.length >= PER_TYPE ? mine : [...indexed];
      const victim = pool.sort((a, b) => (used.get(a) || 0) - (used.get(b) || 0))[0];
      if (!victim) return false;
      db.exec(`DROP INDEX IF EXISTS ${victim}`); indexed.delete(victim); used.delete(victim);
    }
    db.exec(sql); indexed.add(name); used.set(name, ++tick); recent.push(now); built.set(type, recent);
    return true;
  };

  /** @param {string} type @returns {import("./memory.js").Table} */
  /** @type {Map<string, any>[]} every type's hot rows, for `stats` */ const caches = [];
  const counts = { pushed: 0, fell: 0, agg: 0, fast: 0 };
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
  // ---- counts of a stage field (kernel_counts) ----
  // "Count by stage" is the question a board asks all day. For a type's stage (and select) fields the store keeps a count per value, maintained inside the same transaction as every write
  // (one upsert per write, two when the value changes), so the answer is a read of a few rows instead of a scan of the type. Built from the table the first time it is asked for, and dropped
  // when the type's definition changes (it is built again at the next ask).
  const COUNT_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  /** @type {Set<string>} "type\u0000field" whose counts are built and kept */ const countsReady = new Set();
  for (const r of /** @type {any[]} */ (db.prepare("SELECT name FROM kernel_flags WHERE name LIKE 'counts:%'").all())) { const [, t, f] = String(r.name).split(":"); if (t && f) countsReady.add(`${t}\u0000${f}`); }
  const incCount = db.prepare("INSERT INTO kernel_counts (type, field, val, n) VALUES (?, ?, ?, 1) ON CONFLICT(type, field, val) DO UPDATE SET n = n + 1");
  const decCount = db.prepare("UPDATE kernel_counts SET n = n - 1 WHERE type = ? AND field = ? AND val = ?");
  const countFields = (/** @type {string} */ type) => ((defs.get(type) || {}).fields || []).filter((/** @type {any} */ f) => (f.kind === "stage" || f.kind === "select") && COUNT_FIELD.test(f.name)).map((/** @type {any} */ f) => f.name);
  const valKey = (/** @type {any} */ v) => JSON.stringify(v === undefined ? null : v);
  const countsReset = (/** @type {string} */ type) => {
    db.prepare("DELETE FROM kernel_counts WHERE type = ?").run(type);
    db.prepare("DELETE FROM kernel_flags WHERE name LIKE ?").run(`counts:${type}:%`);
    for (const k of [...countsReady]) if (k.startsWith(`${type}\u0000`)) countsReady.delete(k);
  };
  const countsBuild = (/** @type {string} */ type, /** @type {string} */ field) => {
    db.exec("SAVEPOINT kcounts");
    try {
      db.prepare("DELETE FROM kernel_counts WHERE type = ? AND field = ?").run(type, field);
      db.prepare(`INSERT INTO kernel_counts (type, field, val, n) SELECT ?, ?, json_quote(json_extract(data, '$.${field}')), count(*) FROM kernel_records WHERE type = ? AND deleted_at IS NULL GROUP BY json_quote(json_extract(data, '$.${field}'))`).run(type, field, type);
      setFlag.run(`counts:${type}:${field}`, "1");
      db.exec("RELEASE kcounts");
    } catch (e) { db.exec("ROLLBACK TO kcounts"); db.exec("RELEASE kcounts"); throw e; }
    countsReady.add(`${type}\u0000${field}`);
  };
  /** Keep the built counts of a type right after one change entry (called inside the write's transaction). @param {any} e */
  const countsApply = (e) => {
    for (const f of countFields(e.type)) {
      if (!countsReady.has(`${e.type}\u0000${f}`)) continue;
      const after = e.after ? valKey(e.after[f]) : null, before = e.before ? valKey(e.before[f]) : null;
      if (e.kind === "created" || e.kind === "restored") incCount.run(e.type, f, after);
      else if (e.kind === "removed") decCount.run(e.type, f, after);
      else if (e.kind === "updated" && before !== after) { if (before !== null) decCount.run(e.type, f, before); incCount.run(e.type, f, after); }
    }
  };
  /** The count of each value of a type's stage field, when the question is exactly that; null otherwise. @param {string} type @param {any} spec */
  const countsAnswer = (type, spec) => {
    if (spec.attr_filter !== undefined || (spec.filter !== undefined && spec.filter !== null)) return null;
    if (!Array.isArray(spec.group_by) || spec.group_by.length !== 1 || !Array.isArray(spec.measures) || spec.measures.length !== 1) return null;
    const m = spec.measures[0], f = spec.group_by[0];
    if (!m || m.fn !== "count" || m.field || typeof f !== "string" || !countFields(type).includes(f)) return null;
    // built AND confirmed on disk: a build made inside a transaction that was rolled back leaves this set in memory but its rows and flag gone
    if (!countsReady.has(`${type}\u0000${f}`) || !getFlag.get(`counts:${type}:${f}`)) countsBuild(type, f);
    const rows = /** @type {any[]} */ (db.prepare("SELECT val, n FROM kernel_counts WHERE type = ? AND field = ? AND n > 0").all(type, f));
    return rows.map(r => ({ group: { [f]: JSON.parse(r.val) }, values: { count: Number(r.n) } })).sort((a, b) => (canonical(a.group) < canonical(b.group) ? -1 : 1));
  };
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
  /** word -> the most fields of one record that hold it: an upper bound, computed once from the index and raised by every write that adds more, never lowered (a rolled-back write leaves
   * it too high, which is safe). It lets a search prove what a record that only a common word reaches can score. Emptied when the index is rebuilt. */
  /** @type {Map<string, number>} */ const bounds = new Map();
  const BOUNDS_MAX = 64;
  const RARE = cfg.searchRare ?? 500;
  const boundOf = (/** @type {string} */ w) => {
    let b = bounds.get(w);
    if (b === undefined) {
      b = /** @type {any} */ (db.prepare("SELECT coalesce(max(c), 0) AS m FROM (SELECT count(*) AS c FROM kernel_ftf WHERE kernel_ftf MATCH ? GROUP BY rowid >> 10)").get(`"${w.replace(/"/g, '""')}"`)).m;
      if (bounds.size >= BOUNDS_MAX) bounds.delete(/** @type {string} */ (bounds.keys().next().value));
    } else bounds.delete(w);
    bounds.set(w, b);
    return b;
  };
  const raiseBounds = (/** @type {Map<number, string>} */ want) => {
    for (const [w, b] of bounds) { let c = 0; for (const t of want.values()) if (t.includes(w)) c++; if (c > b) bounds.set(w, c); }
  };
  // (FTS5 scans the whole table for a rowid range, so a record's few field rows are read, replaced and deleted by their own rowids.)
  const ftsWrite = (/** @type {number} */ rid, /** @type {any} */ r) => {
    const def = defs.get(r.type);
    const slots = def ? Math.min(def.fields.length, FIELD_SLOTS) : 0;
    const want = new Map(r.deleted_at ? [] : partsOf(r) || []);
    raiseBounds(want);
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
    ftsBuilt = false; ftsGen++; bounds.clear();
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
    const ensureIndex = (/** @type {string} */ field, /** @type {boolean} */ allowed = true) => slot(type, `kidx_${type}_${field}`, `CREATE INDEX IF NOT EXISTS kidx_${type}_${field} ON kernel_records (json_extract(data, '$.${field}')) WHERE type = '${type}'`, allowed);
    return {
      get(id) { const c = cache.get(id); if (c) return keep(id, c); const r = getRow.get(type, id); return r ? keep(id, parse(r)) : undefined; },
      has(id) { return cache.has(id) || Boolean(hasRow.get(type, id)); },
      set(id, r) { keep(id, r); },
      drop(id) { cache.delete(id); },
      values() { return rows(allRows.iterate(type)); },
      /**
       * One page of a query as ONE indexed statement, when the planner can prove it answers exactly what the reference code would (kernel/store/sqlite-query.js); null otherwise, and
       * the caller streams the rows through the reference code instead.
       */
      pageQuery(spec) {
        const def = defs.get(type);
        const plan = planPage({ type, def, spec, ascii: field => isAscii(type, field) });
        if (!plan && spec.attr_filter !== undefined) throw Object.assign(new Error("this query cannot be answered under an attribute filter here"), { code: "unsupported" });
        if (!plan) { counts.fell++; return null; }
        if ("error" in plan) return plan;
        counts.pushed++;
        if (plan.index) slot(type, plan.index.name, plan.index.sql, spec.build_index !== false);
        const got = /** @type {any[]} */ (db.prepare(plan.sql).all(...plan.args));
        const mine = got.slice(0, plan.limit).map(r => cache.get(r.id) ?? parse(r));
        return { rows: mine, ...(got.length > plan.limit && mine.length ? { next_cursor: encodeCursor(mine[mine.length - 1], spec.sort) } : {}) };
      },
      /** An aggregate as one GROUP BY statement (rows come back grouped; the groups are ordered here as the reference orders them), or null to stream the rows instead. */
      aggregateQuery(spec) {
        const fast = countsAnswer(type, spec);
        if (fast) { counts.pushed++; counts.agg++; return fast; }
        const plan = planAggregate({ type, def: defs.get(type), spec, ascii: field => isAscii(type, field) });
        if (!plan && spec.attr_filter !== undefined) throw Object.assign(new Error("this total cannot be answered under an attribute filter here"), { code: "unsupported" });
        if (!plan) { counts.fell++; return null; }
        counts.pushed++; counts.agg++;
        if (plan.index) slot(type, plan.index.name, plan.index.sql, spec.build_index !== false);
        // Without table statistics SQLite prefers the primary key to the covering index; the index was made for exactly this grouping, so it is named.
        const sql = plan.index && spec.attr_filter === undefined && indexed.has(plan.index.name) ? plan.sql.replace("FROM kernel_records WHERE", `FROM kernel_records INDEXED BY ${plan.index.name} WHERE`) : plan.sql;
        const got = /** @type {any[]} */ (db.prepare(sql).all(...plan.args));
        return got.map(row => ({
          group: Object.fromEntries(plan.groups.map((g, k) => [g.field, row[`g${k}`] === null || row[`g${k}`] === undefined ? null : g.bool ? row[`g${k}`] === 1 : row[`g${k}`]])),
          values: Object.fromEntries(plan.measures.map((m, k) => [m.name, row[`m${k}`] === undefined ? null : row[`m${k}`]])),
        })).sort((a, b) => (canonical(a.group) < canonical(b.group) ? -1 : 1));
      },
      candidates(spec) {
        const eq = equalities(spec && spec.filter).filter(([f]) => ensureIndex(f, spec.build_index !== false));
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
        const fast = this.searchTopFast(words, n, after);
        if (fast) return fast;
        const per = words.map(w => ([...w].length >= 3 ? "SELECT rowid >> 10 AS rid FROM kernel_ftf WHERE kernel_ftf MATCH ?" : "SELECT rowid >> 10 AS rid FROM kernel_ftf WHERE instr(doc, ?) > 0"));
        const args = words.map(w => ([...w].length >= 3 ? `"${w.replace(/"/g, '""')}"` : w));
        return rows(db.prepare(`SELECT k.* FROM (SELECT rid, count(*) AS sc FROM (${per.join(" UNION ALL ")}) GROUP BY rid) h CROSS JOIN kernel_records k ON k.rowid = h.rid WHERE k.type = ? AND k.deleted_at IS NULL${after ? " AND (h.sc < ? OR (h.sc = ? AND k.id > ?))" : ""} ORDER BY h.sc DESC, k.id LIMIT ?`).all(...args, type, ...(after ? [after.score, after.score, after.id] : []), n));
      },
      /**
       * The ranked search when ONE word is common (reaches more than `searchRare` field rows) and the others are rare, which is "Client 4521" in a type full of clients: the common
       * word's postings are never read. A record that only the common word reaches holds it in at most `boundOf(word)` fields, so it scores at most that, and every record scoring more
       * was reached by a rare word: those are few, found by their postings and scored exactly. The rest of the ranking is the records of each score from the bound down, each in id
       * order, found by walking the type's primary key and counting a record's field hits by point reads (it stops as soon as the page is full). Null (the general ranking answers)
       * in every other case, and when the walk would have to pass too many records to find a sparse score.
       */
      searchTopFast(words, /** @type {number} */ n, /** @type {{ score: number, id: string } | undefined} */ after) {
        const def = defs.get(type);
        if (!def || def.fields.length > 24 || new Set(words).size !== words.length || words.some(w => [...w].length < 3)) return null;
        const quoted = (/** @type {string} */ w) => `"${w.replace(/"/g, '""')}"`;
        const capped = db.prepare(`SELECT count(*) AS c FROM (SELECT 1 FROM kernel_ftf WHERE kernel_ftf MATCH ? LIMIT ${RARE + 1})`);
        const rare = [], common = [];
        for (const w of words) (/** @type {any} */ (capped.get(quoted(w))).c > RARE ? common : rare).push(w);
        if (common.length !== 1) return null;
        const top = boundOf(common[0]);
        if (top < 1) return null;
        counts.fast++;
        // Above the bound: only records the rare words reach, scored exactly as the reference scores them (a field holds a word, counted once per field and word).
        /** @type {Set<number>} */ const rids = new Set();
        for (const w of rare) for (const x of /** @type {any[]} */ (db.prepare("SELECT rowid >> 10 AS rid FROM kernel_ftf WHERE kernel_ftf MATCH ?").all(quoted(w)))) rids.add(x.rid);
        const byRid = db.prepare("SELECT * FROM kernel_records WHERE rowid = ?");
        /** @type {{ r: any, sc: number }[]} */ const above = [];
        for (const rid of rids) {
          const r = /** @type {any} */ (byRid.get(rid));
          if (!r || r.type !== type || r.deleted_at !== null) continue;
          let sc = 0;
          for (const [, text] of partsOf(parse(r)) || []) for (const w of words) if (text.includes(w)) sc++;
          if (sc > top) above.push({ r, sc });
        }
        above.sort((a, b) => b.sc - a.sc || (a.r.id < b.r.id ? -1 : 1));
        const out = above.filter(t => !after || t.sc < after.score || (t.sc === after.score && t.r.id > after.id)).slice(0, n).map(t => t.r);
        const slots = def.fields.length;
        const docs = Array.from({ length: slots }, (_, j) => `SELECT doc FROM kernel_ftf WHERE rowid = k.rowid * ${FIELD_SLOTS} + ${j}`).join(" UNION ALL ");
        const hit = words.map(() => "(instr(d.doc, ?) > 0)").join(" + ");
        const stmt = db.prepare(`SELECT k.* FROM (SELECT rowid, * FROM kernel_records WHERE type = ? AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?) k WHERE (SELECT coalesce(sum(${hit}), 0) FROM (${docs}) d) = ? ORDER BY k.id LIMIT ?`);
        const lastOf = db.prepare("SELECT id FROM kernel_records WHERE type = ? AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT 1 OFFSET ?");
        const CHUNK = 2000;
        let examined = 0;
        for (let level = top; level >= 1 && out.length < n; level--) {
          if (after && level > after.score) continue;
          let from = after && level === after.score ? after.id : "";
          for (;;) {
            for (const g of /** @type {any[]} */ (stmt.all(type, from, CHUNK, ...words, level, n - out.length))) out.push(g);
            if (out.length >= n) break;
            // the whole chunk was examined and held too few of this score: the next one starts after its last record
            const last = /** @type {any} */ (lastOf.get(type, from, CHUNK - 1));
            if (!last) break;
            from = last.id;
            // too sparse a score for a walk: the general ranking answers
            if ((examined += CHUNK) >= 5 * CHUNK) { counts.fast--; return null; }
          }
        }
        return rows(out);
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
    pop() { changeCount--; },
    slice(/** @type {number} */ from, /** @type {number} */ to) { return /** @type {any[]} */ (changeRange.all(from, to)).map(r => JSON.parse(r.entry)); },
  };

  let pending = null;
  /** @type {any} */ let persistRef = null;
  const store = createMemoryStore({
    clock: cfg.clock, hook: cfg.hook, initial: { types, records: [], changes: [] }, backing: { table, changes },
    persist: (persistRef = {
      type: (name, def) => { if (def) { const had = defs.get(name); putType.run(name, JSON.stringify(def)); defs.set(name, def); if (had && canonical(had) !== canonical(def)) countsReset(name); if (had && canonical(had) !== canonical(def)) ftsRestart(); } else { delType.run(name); defs.delete(name); countsReset(name); } for (const k of [...asciiOf.keys()]) if (k.startsWith(`${name}.`)) asciiOf.delete(k); },
      /**
       * A field was sealed in place: the values it held must not survive in the change log (before and after of every entry of the type), nor in the file's free pages or the write-ahead log
       * (`secure_delete` zeroes what an UPDATE frees, a VACUUM rewrites the file, and the log is truncated), nor in the full-text index (rebuilt without the field).
       * @param {string} type @param {readonly string[]} fields
       */
      scrub: (type, fields) => {
        if (!fields.length) return;
        const was = /** @type {any} */ (db.prepare("PRAGMA secure_delete").get());
        db.exec("PRAGMA secure_delete = ON");
        try {
          const upd = db.prepare("UPDATE kernel_changes SET entry = ? WHERE seq = ?");
          let from = 0;
          for (;;) {
            const rows = /** @type {any[]} */ (db.prepare("SELECT seq, entry FROM kernel_changes WHERE seq > ? ORDER BY seq LIMIT 500").all(from));
            if (!rows.length) break;
            db.exec("BEGIN");
            try {
              for (const r of rows) {
                from = r.seq;
                const e = JSON.parse(r.entry);
                if (e.type !== type) continue;
                let hit = false;
                for (const f of fields) for (const side of ["before", "after"]) if (e[side] && typeof e[side] === "object" && Object.hasOwn(e[side], f)) { delete e[side][f]; hit = true; }
                if (hit) upd.run(JSON.stringify(e), r.seq);
              }
              db.exec("COMMIT");
            } catch (err) { db.exec("ROLLBACK"); throw err; }
          }
          ftsRestart();
          // The plain values were also in the record rows the sealing rewrote and in pages freed before this call (secure_delete only zeroes what is freed from now on): a VACUUM writes the
          // database out afresh, so nothing of what was deleted survives in the file. A sealing in place is rare, and this is the price of "forgotten".
          try { db.exec("VACUUM"); } catch { /* inside a transaction of the caller's: the freed pages stay until the next vacuum */ }
        } finally {
          db.exec(`PRAGMA secure_delete = ${was && was.secure_delete ? was.secure_delete : 0}`);
          try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* not in WAL mode, or the checkpoint is blocked by a reader: the next one does it */ }
        }
      },
      // The record and its change entry are one transaction: the memory store calls them back to back.
      record: r => { pending = r; },
      change: e => {
        // A savepoint, not BEGIN: standing alone it is a transaction of its own (one commit), and inside the gateway's unit of work (the record and its event, kernel/boot.js `createUnit`) it joins that one.
        db.exec("SAVEPOINT kchange");
        try {
          const r = /** @type {any} */ (pending);
          noteWrite(r);
          putRec.run(r.type, r.id, r.version, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted_at ?? null);
          ftsSync(r);
          putChange.run(Number(e.cursor.slice(1)), JSON.stringify(e));
          countsApply(e);
          db.exec("RELEASE kchange");
        } catch (err) { db.exec("ROLLBACK TO kchange"); db.exec("RELEASE kchange"); throw err; }
        pending = null;
      },
    }),
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
  // The memory store of this tree may not carry `scrub` (it arrives with records' merge); the store the gateway calls always does, and it forgets in memory and on disk.
  const scrub = /** @type {any} */ (store).scrub || (async (/** @type {string} */ type, /** @type {readonly string[]} */ fields) => { /** @type {any} */ (persistRef).scrub(type, fields); });
  return { ...store, scrub, meta, features: () => ({ ...store.features(), attr_filter: true }), /** What is held in memory: for the bound's tests and the load measurements. */ get ftsReady() { return ftsReady; }, stats: () => ({ fts_built: ftsBuilt, aggregate_pushed: counts.agg, query_pushed: counts.pushed, query_streamed: counts.fell, search_fast: counts.fast, hot_rows: caches.reduce((n, c) => n + c.size, 0), hot_attrs: attrCache.size, changes_in_memory: 0 }), async version() { return { store: "sqlite", version: "1", conformance: (await store.version()).conformance }; } };
}
