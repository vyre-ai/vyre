// kernel/store/sqlite-query.js: the built-in SQLite store's query planner. It turns a query (filter, sort, keyset cursor, limit) into ONE indexed SQL statement when it can
// prove the statement answers exactly what the reference code (kernel/store/query.js) would, and says so (null) when it cannot, so the caller falls back to streaming the rows
// through that code. "Exactly" is the whole point: the same rows, in the same order, with the same cursor, for every value the type allows. What it will not push down:
//   - a field that is not a top-level scalar field of the type (dotted paths, arrays, sealed fields) in a filter or sort (objects are sorted by whether they are null, as the
//     reference does, because two objects always compare equal there);
//   - a text comparison or sort (not equality) on a field that may hold a character outside ASCII: the reference compares UTF-16 code units, SQLite UTF-8 bytes, and they
//     differ for some characters, so `ascii(type, field)` must say the field is ASCII-only;
//   - a value whose type does not match the field's kind (the reference's JavaScript coercions are not SQL's).
// Every leaf is wrapped so a missing field is false, not NULL, which keeps `not` and `ne` two-valued exactly as the reference is.
import { createHash } from "node:crypto";

const TYPE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COLUMNS = new Set(["id", "version", "created_at", "updated_at"]);
const STRING_KINDS = new Set(["text", "rich_text", "date", "datetime", "choice", "stage", "url"]);
const NUMBER_KINDS = new Set(["number", "rating"]);
const OBJECT_KINDS = new Set(["money", "link", "actor", "file", "address"]);
const ARRAY_KINDS = new Set(["multi_choice", "phones", "emails", "urls"]);

class NotPushable extends Error {}
const no = () => { throw new NotPushable(); };
const isAscii = (/** @type {string} */ s) => /^[\x20-\x7e]*$/.test(s);

/**
 * What a field is for the planner: how to read it in SQL and what values it holds.
 * @param {any} def the type's definition @param {string} name
 * @returns {{ col?: string, expr: string, cls: "string" | "number" | "boolean" | "object" | "array" | "int", name: string } | null}
 */
export function fieldInfo(def, name) {
  if (name === "id") return { col: "id", expr: "id", cls: "string", name };
  if (name === "version" || name === "created_at" || name === "updated_at") return { col: name, expr: name, cls: "int", name };
  if (!FIELD.test(name)) return null;
  const f = def && def.fields && def.fields.find((/** @type {any} */ x) => x.name === name);
  if (!f) return null;
  const expr = `json_extract(data, '$.${name}')`;
  if (STRING_KINDS.has(f.kind)) return { expr, cls: "string", name };
  if (NUMBER_KINDS.has(f.kind)) return { expr, cls: "number", name };
  if (f.kind === "boolean") return { expr, cls: "boolean", name };
  if (OBJECT_KINDS.has(f.kind)) return { expr, cls: "object", name };
  if (ARRAY_KINDS.has(f.kind)) return { expr, cls: "array", name };
  return null; // sealed and anything unknown
}

/** A value as SQL binds it for a field of that class, or throws NotPushable. @param {any} info @param {any} v */
function bindFor(info, v) {
  if (info.cls === "string") { if (typeof v !== "string") no(); return v; }
  if (info.cls === "number" || info.cls === "int") { if (typeof v !== "number" || !Number.isFinite(v)) no(); return v; }
  if (info.cls === "boolean") { if (typeof v !== "boolean") no(); return v ? 1 : 0; }
  return no();
}

/**
 * @param {any} f the filter @param {any} def @param {(field: string) => boolean} ascii whether a text field is known to hold ASCII only
 * @param {any[]} args collects the bound values, in order @returns {string}
 */
function filterSql(f, def, ascii, args) {
  if (!f) return "1";
  if (f.and) return f.and.length ? `(${f.and.map((/** @type {any} */ x) => filterSql(x, def, ascii, args)).join(" AND ")})` : "1";
  if (f.or) return f.or.length ? `(${f.or.map((/** @type {any} */ x) => filterSql(x, def, ascii, args)).join(" OR ")})` : "0";
  if (f.not) return `(NOT ${filterSql(f.not, def, ascii, args)})`;
  const info = typeof f.field === "string" ? fieldInfo(def, f.field) : null;
  if (!info) no();
  const textOrd = info.cls === "string" && !info.col; // ordered comparison of text needs the ASCII guarantee
  const needAscii = () => { if (info.cls === "string" && !(info.col === "id" || ascii(info.name))) no(); };
  const eqOf = (/** @type {any} */ v) => {
    if (v === null || v === undefined) { if (info.cls === "array") no(); return `(${info.expr} IS NULL)`; }
    if (info.cls === "object" || info.cls === "array") no();
    // a value of another kind is never equal to what the field holds
    const ok = (info.cls === "string" && typeof v === "string") || ((info.cls === "number" || info.cls === "int") && typeof v === "number") || (info.cls === "boolean" && typeof v === "boolean");
    if (!ok) { if (typeof v === "object") no(); return "0"; }
    args.push(bindFor(info, v));
    return `COALESCE(${info.expr} = ?, 0)`;
  };
  switch (f.op) {
    case "eq": return eqOf(f.value);
    case "ne": return `(NOT ${eqOf(f.value)})`;
    case "is_null": if (info.cls === "array") no(); return `(${info.expr} IS NULL)`;
    case "lt": case "lte": case "gt": case "gte": {
      if (info.cls === "object" || info.cls === "array") no();
      if (f.value === null || f.value === undefined) return f.op === "gt" || f.op === "gte" ? `(${info.expr} IS NOT NULL)` : "0";
      needAscii();
      args.push(bindFor(info, f.value));
      return `COALESCE(${info.expr} ${{ lt: "<", lte: "<=", gt: ">", gte: ">=" }[/** @type {"lt"} */ (f.op)]} ?, 0)`;
    }
    case "in": {
      if (!Array.isArray(f.value)) return "0";
      if (info.cls === "object" || info.cls === "array") no();
      const vals = [];
      let withNull = false;
      for (const x of f.value) {
        if (x === null || x === undefined) { withNull = true; continue; }
        if (typeof x === "object") no();
        const ok = (info.cls === "string" && typeof x === "string") || ((info.cls === "number" || info.cls === "int") && typeof x === "number") || (info.cls === "boolean" && typeof x === "boolean");
        if (ok) vals.push(bindFor(info, x));
      }
      const parts = [];
      if (vals.length) { parts.push(`${info.expr} IN (${vals.map(() => "?").join(", ")})`); args.push(...vals); }
      if (withNull) parts.push(`${info.expr} IS NULL`);
      return parts.length ? `COALESCE(${parts.join(" OR ")}, 0)` : "0";
    }
    case "contains": {
      if (info.cls === "array") { if (typeof f.value !== "string") no(); args.push(f.value); return `EXISTS (SELECT 1 FROM json_each(data, '$.${info.name}') WHERE json_each.value = ?)`; }
      if (info.cls !== "string") return "0"; // the reference: a non-text, non-list value never contains anything
      if (typeof f.value !== "string" || f.value === "" || !isAscii(f.value) || !(info.col === "id" || ascii(info.name))) no();
      args.push(f.value.toLowerCase());
      return `COALESCE(instr(lower(${info.expr}), ?) > 0, 0)`;
    }
    default: void textOrd; return "0"; // an unknown operator matches nothing, as in the reference
  }
}

/**
 * Plan one page of a query. Returns { sql, args, limit, index } or null when it cannot be pushed down exactly.
 * @param {{ type: string, def: any, spec: any, ascii: (field: string) => boolean }} q
 */
export function planPage(q) {
  const { type, def, spec } = q;
  if (!TYPE_NAME.test(type) || !def) return null;
  try {
    const sort = Array.isArray(spec.sort) ? spec.sort : [];
    const keys = [...sort, { field: "id", dir: "asc" }];
    /** @type {any[]} */ const args = [];
    const where = [`type = '${type}'`];
    if (!spec.include_deleted) where.push("deleted_at IS NULL");
    where.push(filterSql(spec.filter, def, q.ascii, args));
    // order: per key, how SQL reads it
    const order = keys.map((/** @type {any} */ k) => {
      const info = typeof k.field === "string" ? fieldInfo(def, k.field) : null;
      if (!info || info.cls === "array") no();
      if (info.cls === "string" && !(info.col === "id" || q.ascii(info.name))) no();
      const dir = k.dir === "desc" ? "DESC" : "ASC";
      const expr = info.cls === "object" ? `(${info.expr} IS NOT NULL)` : info.expr;
      return { info, dir, expr, desc: k.dir === "desc" };
    });
    // the keyset cursor: rows strictly after it in the total order
    if (spec.page && spec.page.cursor) {
      let key;
      try { key = JSON.parse(Buffer.from(spec.page.cursor, "base64url").toString()); } catch { key = null; }
      if (!Array.isArray(key) || key.length !== keys.length) return { error: "invalid cursor" };
      /** The key's equality and its "strictly after", each with its own bound values, so a disjunct can repeat the equalities of the keys before it. */
      const pieces = order.map((o, i) => {
        const c = key[i];
        if (o.info.cls === "object") {
          const nonNull = c !== null && c !== undefined;
          return { eq: { sql: `((${o.info.expr} IS NOT NULL) = ${nonNull ? 1 : 0})`, args: [] }, after: { sql: o.desc ? (nonNull ? `(${o.info.expr} IS NULL)` : "0") : (nonNull ? "0" : `(${o.info.expr} IS NOT NULL)`), args: [] } };
        }
        if (c === null || c === undefined) return { eq: { sql: `(${o.expr} IS NULL)`, args: [] }, after: { sql: o.desc ? "0" : `(${o.expr} IS NOT NULL)`, args: [] } };
        const v = bindFor(o.info, c);
        return { eq: { sql: `(${o.expr} IS ?)`, args: [v] }, after: { sql: o.desc ? `(${o.expr} IS NULL OR ${o.expr} < ?)` : `COALESCE(${o.expr} > ?, 0)`, args: [v] } };
      });
      const disj = order.map((_, i) => {
        const parts = [...pieces.slice(0, i).map(p => p.eq), pieces[i].after];
        return { sql: `(${parts.map(p => p.sql).join(" AND ")})`, args: parts.flatMap(p => p.args) };
      });
      where.push(`(${disj.map(d => d.sql).join(" OR ")})`);
      args.push(...disj.flatMap(d => d.args));
    }
    const limit = Math.max(1, Math.min(spec.page.limit, 500));
    const sql = `SELECT * FROM kernel_records WHERE ${where.join(" AND ")} ORDER BY ${order.map(o => `${o.expr} ${o.dir}`).join(", ")} LIMIT ${limit + 1}`;
    return { sql, args, limit, index: indexFor(type, def, spec, order) };
  } catch (e) {
    if (e instanceof NotPushable) return null;
    throw e;
  }
}

/** The index this query wants: its equality fields, then its sort keys in order and direction, then id (partial on the type). */
function indexFor(/** @type {string} */ type, /** @type {any} */ def, /** @type {any} */ spec, /** @type {any[]} */ order) {
  /** @type {string[]} */ const eqCols = [];
  const walk = (/** @type {any} */ f) => { if (!f) return; if (Array.isArray(f.and)) f.and.forEach(walk); else if (f.op === "eq" && typeof f.field === "string") { const i = fieldInfo(def, f.field); if (i && !i.col && i.cls !== "object" && i.cls !== "array" && !eqCols.includes(i.expr)) eqCols.push(i.expr); } };
  walk(spec.filter);
  const cols = [...eqCols, ...order.filter(o => o.info.col !== "id").map(o => `${o.expr} ${o.dir}`), "id"];
  if (cols.length === 1 && eqCols.length === 0) return null;
  const name = `kq_${type}_${createHash("sha1").update(cols.join("|")).digest("hex").slice(0, 10)}`;
  return { name, sql: `CREATE INDEX IF NOT EXISTS ${name} ON kernel_records (${cols.join(", ")}) WHERE type = '${type}'` };
}

/**
 * Plan an aggregate as one GROUP BY statement, or null when it cannot be pushed down exactly. Group fields are top-level scalar fields (or the row's own columns); a measure
 * is a count (of rows, or of a field's non-null values) or sum, min, max or avg over a number field (any other `fn` is an average, as in the reference). The groups come back
 * unsorted: the reference orders them by their canonical text, and the caller does the same.
 * @param {{ type: string, def: any, spec: any, ascii: (field: string) => boolean }} q
 * @returns {{ sql: string, args: any[], groups: { field: string, bool: boolean }[], measures: { name: string, fn: string, field?: string }[] } | null}
 */
export function planAggregate(q) {
  const { type, def, spec } = q;
  if (!TYPE_NAME.test(type) || !def || !Array.isArray(spec.measures)) return null;
  try {
    /** @type {any[]} */ const args = [];
    const where = [`type = '${type}'`, "deleted_at IS NULL", filterSql(spec.filter, def, q.ascii, args)];
    const gInfo = (spec.group_by || []).map((/** @type {any} */ f) => { const i = typeof f === "string" ? fieldInfo(def, f) : null; if (!i || i.cls === "object" || i.cls === "array") no(); return i; });
    const select = [], measures = [];
    gInfo.forEach((/** @type {any} */ i, /** @type {number} */ k) => select.push(`${i.expr} AS g${k}`));
    spec.measures.forEach((/** @type {any} */ m, /** @type {number} */ k) => {
      const name = m.field ? `${m.fn}:${m.field}` : m.fn;
      if (m.fn === "count") {
        if (!m.field) select.push(`COUNT(*) AS m${k}`);
        else { const i = typeof m.field === "string" ? fieldInfo(def, m.field) : null; if (!i) no(); select.push(`COUNT(${i.expr}) AS m${k}`); }
      } else {
        const i = typeof m.field === "string" ? fieldInfo(def, m.field) : null;
        if (!i || (i.cls !== "number" && i.cls !== "int")) no();
        const fn = m.fn === "sum" ? "SUM" : m.fn === "min" ? "MIN" : m.fn === "max" ? "MAX" : "AVG";
        select.push(`${fn}(${i.expr}) AS m${k}`);
      }
      measures.push({ name, fn: m.fn, field: m.field });
    });
    if (!select.length) no();
    const sql = `SELECT ${select.join(", ")} FROM kernel_records WHERE ${where.join(" AND ")}${gInfo.length ? ` GROUP BY ${gInfo.map((/** @type {any} */ i) => i.expr).join(", ")}` : ""}`;
    return { sql, args, groups: gInfo.map((/** @type {any} */ i, /** @type {number} */ k) => ({ field: spec.group_by[k], bool: i.cls === "boolean" })), measures };
  } catch (e) {
    if (e instanceof NotPushable) return null;
    throw e;
  }
}

export { NotPushable, fieldInfo as _fieldInfo };
