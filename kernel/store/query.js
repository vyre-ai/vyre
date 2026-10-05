// kernel/store/query.js: filter, sort, keyset paging and aggregation over plain rows. Shared by the in-memory reference
// store and by the gateway (which aggregates only rows it has authorized, because a store is never trusted to hide rows).
import { canonical } from "../core/canonical.js";
import { toB64u, fromB64u, utf8, text } from "../../lib/databox.js";

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
export const encodeCursor = (/** @type {any} */ r, /** @type {any} */ sort) => toB64u(utf8(JSON.stringify(keyOf(r, sort))));

/**
 * Keyset page: rows strictly after the cursor's position in the total order. Inserts and removals between pages never repeat or skip a row. It takes any iterable of rows and
 * keeps only the page it is building (at most `limit` rows, found by insertion into a small sorted list), so a type of any size is paged in constant memory.
 */
export function page(/** @type {Iterable<any>} */ all, /** @type {any} */ spec) {
  const sort = spec.sort;
  const keys = [...(sort || []), { field: "id", dir: "asc" }];
  /** @type {any[] | null} */ let key = null;
  if (spec.page.cursor) {
    try { key = JSON.parse(text(fromB64u(spec.page.cursor))); } catch { key = null; }
    if (!Array.isArray(key) || key.length !== keys.length) return { error: "invalid cursor" };
  }
  const order = (/** @type {any} */ a, /** @type {any} */ b) => { for (const k of keys) { const c = cmp(fieldOf(a, k.field), fieldOf(b, k.field)); if (c) return k.dir === "desc" ? -c : c; } return 0; };
  const after = (/** @type {any} */ r) => {
    if (!key) return true;
    const rk = keyOf(r, sort);
    for (let i = 0; i < keys.length; i++) { const c = cmp(rk[i], key[i]); if (c) return keys[i].dir === "desc" ? c < 0 : c > 0; }
    return false;
  };
  const limit = Math.max(1, Math.min(spec.page.limit, 500));
  /** @type {any[]} */ const best = [];
  let counted = 0;
  for (const r of all) {
    if (!matches(spec.filter, r) || !after(r)) continue;
    counted++;
    if (best.length === limit && order(r, best[limit - 1]) >= 0) continue;
    let lo = 0, hi = best.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (order(best[mid], r) <= 0) lo = mid + 1; else hi = mid; }
    best.splice(lo, 0, r);
    if (best.length > limit) best.pop();
  }
  const more = counted > limit;
  return { rows: best, ...(more && best.length ? { next_cursor: encodeCursor(best[best.length - 1], sort) } : {}) };
}

/**
 * Group and measure, one row at a time: `add(row)` folds a row into a running figure per group and measure and keeps nothing of the row, so memory is the number of groups, never
 * the number of rows. `maxGroups` stops a group-by on a unique field from being its own memory problem (`unsupported`). `avg` and `sum` skip nulls; an empty measure is null.
 * @param {any} spec @param {{ maxGroups?: number }} [o]
 */
export function createAggregator(spec, o = {}) {
  const measures = spec.measures;
  const groups = new Map();
  const fresh = () => measures.map(() => ({ n: 0, sum: 0, min: Infinity, max: -Infinity, nonnull: 0 }));
  return {
    add(/** @type {any} */ r) {
      if (!matches(spec.filter, r)) return;
      const g = Object.fromEntries((spec.group_by || []).map((/** @type {string} */ f) => [f, fieldOf(r, f)]));
      const k = canonical(g);
      let grp = groups.get(k);
      if (!grp) {
        if (o.maxGroups && groups.size >= o.maxGroups) throw Object.assign(new Error(`more than ${o.maxGroups} groups; group by something coarser`), { code: "unsupported" });
        grp = { group: g, n: 0, acc: fresh() }; groups.set(k, grp);
      }
      grp.n++;
      measures.forEach((/** @type {any} */ m, /** @type {number} */ i) => {
        if (!m.field) return;
        const v = fieldOf(r, m.field), a = grp.acc[i];
        if (v !== null) a.nonnull++;
        if (typeof v === "number") { a.n++; a.sum += v; if (v < a.min) a.min = v; if (v > a.max) a.max = v; }
      });
    },
    /** Fold in a group a store already totalled: its group values, its row count and, per measure that names a field, `{ nonnull, nums, sum, min, max }`. Groups with the same values join. */
    addGroup(/** @type {any} */ group, /** @type {number} */ n, /** @type {any[]} */ m) {
      const k = canonical(group);
      let grp = groups.get(k);
      if (!grp) {
        if (o.maxGroups && groups.size >= o.maxGroups) throw Object.assign(new Error(`more than ${o.maxGroups} groups; group by something coarser`), { code: "unsupported" });
        grp = { group, n: 0, acc: fresh() }; groups.set(k, grp);
      }
      grp.n += n;
      measures.forEach((/** @type {any} */ x, /** @type {number} */ i) => {
        if (!x.field || !m[i]) return;
        const a = grp.acc[i], b = m[i];
        a.nonnull += b.nonnull; a.n += b.nums; a.sum += b.sum; if (b.nums && b.min < a.min) a.min = b.min; if (b.nums && b.max > a.max) a.max = b.max;
      });
    },
    result() {
      if (!groups.size && !(spec.group_by || []).length) groups.set("{}", { group: {}, n: 0, acc: fresh() });
      return [...groups.values()].sort((a, b) => (canonical(a.group) < canonical(b.group) ? -1 : 1)).map(({ group, n, acc }) => ({
        group,
        values: Object.fromEntries(measures.map((/** @type {any} */ m, /** @type {number} */ i) => {
          const name = m.field ? `${m.fn}:${m.field}` : m.fn, a = acc[i];
          if (m.fn === "count") return [name, m.field ? a.nonnull : n];
          if (!a.n) return [name, null];
          return [name, m.fn === "sum" ? a.sum : m.fn === "min" ? a.min : m.fn === "max" ? a.max : a.sum / a.n];
        })),
      }));
    },
  };
}

/** Group and measure a whole list. @param {Iterable<any>} all @param {any} spec */
export function aggregate(all, spec) {
  const agg = createAggregator(spec);
  for (const r of all) agg.add(r);
  return agg.result();
}
