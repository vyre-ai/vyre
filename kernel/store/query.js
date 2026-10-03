// kernel/store/query.js: filter, sort, keyset paging and aggregation over plain rows. Shared by the in-memory reference
// store and by the gateway (which aggregates only rows it has authorized, because a store is never trusted to hide rows).
import { canonical } from "../core/canonical.js";

const eq = (/** @type {any} */ a, /** @type {any} */ b) => (a === b || (typeof a === "object" && a !== null && canonical(a) === canonical(b)));
const cmp = (/** @type {any} */ a, /** @type {any} */ b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Read a (possibly dotted) field from a stored record: `id`, `version`, `created_at`, `updated_at` or a data field. */
export function fieldOf(/** @type {any} */ r, /** @type {string} */ f) {
  if (f === "id" || f === "version" || f === "created_at" || f === "updated_at" || f === "type") return r[f];
  const [head, ...rest] = f.split(".");
  let v = r.data[head];
  for (const k of rest) v = v && typeof v === "object" ? v[k] : undefined;
  return v === undefined ? null : v;
}

/** @param {any} f @param {any} r */
export function matches(f, r) {
  if (!f) return true;
  if (f.and) return f.and.every((/** @type {any} */ x) => matches(x, r));
  if (f.or) return f.or.some((/** @type {any} */ x) => matches(x, r));
  if (f.not) return !matches(f.not, r);
  const v = fieldOf(r, f.field);
  switch (f.op) {
    case "eq": return eq(v, f.value ?? null);
    case "ne": return !eq(v, f.value ?? null);
    case "lt": return v !== null && cmp(v, f.value) < 0;
    case "lte": return v !== null && cmp(v, f.value) <= 0;
    case "gt": return v !== null && cmp(v, f.value) > 0;
    case "gte": return v !== null && cmp(v, f.value) >= 0;
    case "in": return Array.isArray(f.value) && f.value.some((/** @type {any} */ x) => eq(v, x));
    case "contains": return Array.isArray(v) ? v.some(x => eq(x, f.value)) : typeof v === "string" && typeof f.value === "string" && v.toLowerCase().includes(f.value.toLowerCase());
    case "is_null": return v === null || v === undefined;
    default: return false;
  }
}

/** Sort by the requested fields, then by id so the order is total and a cursor is stable. */
export function sorted(/** @type {any[]} */ rows, /** @type {any[] | undefined} */ sort) {
  const keys = [...(sort || []), { field: "id", dir: "asc" }];
  return [...rows].sort((a, b) => {
    for (const k of keys) { const c = cmp(fieldOf(a, k.field), fieldOf(b, k.field)); if (c) return k.dir === "desc" ? -c : c; }
    return 0;
  });
}

const keyOf = (/** @type {any} */ r, /** @type {any[] | undefined} */ sort) => [...(sort || []).map(k => fieldOf(r, k.field)), r.id];
export const encodeCursor = (/** @type {any} */ r, /** @type {any} */ sort) => Buffer.from(JSON.stringify(keyOf(r, sort))).toString("base64url");

/** Keyset page: rows strictly after the cursor's position in the total order. Inserts and removals between pages never repeat or skip a row. */
export function page(/** @type {any[]} */ all, /** @type {any} */ spec) {
  const sort = spec.sort;
  const rows = sorted(all.filter(r => matches(spec.filter, r)), sort);
  let start = 0;
  if (spec.page.cursor) {
    let key;
    try { key = JSON.parse(Buffer.from(spec.page.cursor, "base64url").toString()); } catch { key = null; }
    if (!Array.isArray(key) || key.length !== (sort || []).length + 1) return { error: "invalid cursor" };
    const keys = [...(sort || []), { field: "id", dir: "asc" }];
    start = rows.findIndex(r => {
      const rk = keyOf(r, sort);
      for (let i = 0; i < keys.length; i++) { const c = cmp(rk[i], key[i]); if (c) return keys[i].dir === "desc" ? c < 0 : c > 0; }
      return false;
    });
    if (start === -1) start = rows.length;
  }
  const limit = Math.max(1, Math.min(spec.page.limit, 500));
  const slice = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  return { rows: slice, ...(more && slice.length ? { next_cursor: encodeCursor(slice[slice.length - 1], sort) } : {}) };
}

/** Group and measure. Group keys keep their JSON shape; `avg` and `sum` skip nulls; an empty measure is null. */
export function aggregate(/** @type {any[]} */ all, /** @type {any} */ spec) {
  const groups = new Map();
  for (const r of all.filter(r => matches(spec.filter, r))) {
    const g = Object.fromEntries((spec.group_by || []).map((/** @type {string} */ f) => [f, fieldOf(r, f)]));
    const k = canonical(g);
    if (!groups.has(k)) groups.set(k, { group: g, rows: [] });
    groups.get(k).rows.push(r);
  }
  if (!groups.size && !(spec.group_by || []).length) groups.set("{}", { group: {}, rows: [] });
  return [...groups.values()].sort((a, b) => (canonical(a.group) < canonical(b.group) ? -1 : 1)).map(({ group, rows }) => ({
    group,
    values: Object.fromEntries(spec.measures.map((/** @type {any} */ m) => {
      const name = m.field ? `${m.fn}:${m.field}` : m.fn;
      if (m.fn === "count") return [name, m.field ? rows.filter(r => fieldOf(r, m.field) !== null).length : rows.length];
      const nums = rows.map(r => fieldOf(r, m.field)).filter(v => typeof v === "number");
      if (!nums.length) return [name, null];
      return [name, m.fn === "sum" ? nums.reduce((a, b) => a + b, 0) : m.fn === "min" ? Math.min(...nums) : m.fn === "max" ? Math.max(...nums) : nums.reduce((a, b) => a + b, 0) / nums.length];
    })),
  }));
}
