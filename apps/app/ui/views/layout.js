// @ts-check
// A person's layout of a type (records.layout.get): the columns they chose, how it is sorted, and filters as structured conditions. It lies over the type's own view, key by key; nothing here is an
// expression a person writes. Pure, so Node tests it. The table reads `applyLayout` and `layoutRows`; the column chooser edits the list with `toggleName` and `moveName`.
import { isEmpty } from "../fields/logic.js";

/** Whether a layout says anything at all. @param {any} layout */
export const hasLayout = (layout) => !!layout && typeof layout === "object" && Object.keys(layout).length > 0;

/** The view definition with the layout's columns and sort laid over its list. @param {any} vd @param {any} layout */
export function applyLayout(vd, layout) {
  if (!hasLayout(layout)) return vd;
  const columns = Array.isArray(layout.columns) && layout.columns.length ? layout.columns : undefined;
  const sort = layout.sort && layout.sort.field ? { sort: String(layout.sort.field), sortDir: layout.sort.dir === "desc" ? "desc" : "asc" } : {};
  if (!columns && !("sort" in sort)) return vd;
  return { ...vd, list: { ...(vd.list || {}), ...(columns ? { columns } : {}), ...sort } };
}

/** What a value is for a comparison: an amount for money, the text for anything with a name or title, else itself. @param {any} v */
function plain(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v.amount ?? v.urn ?? v.name ?? v.title ?? v.actor?.id ?? "";
  return v;
}
const num = (/** @type {any} */ v) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/** One condition { field, op, value } against one record's data. @param {any} data @param {{ field: string, op: string, value?: any }} c */
export function holdsCondition(data, c) {
  const raw = data ? data[c.field] : undefined;
  if (c.op === "empty") return isEmpty(raw);
  if (c.op === "notempty") return !isEmpty(raw);
  const list = Array.isArray(raw) ? raw.map(plain) : [plain(raw)];
  const text = (/** @type {any} */ v) => String(v ?? "").toLowerCase();
  const any = (/** @type {(v: any) => boolean} */ f) => list.some(f);
  switch (c.op) {
    case "eq": return any((v) => text(v) === text(c.value));
    case "ne": return !any((v) => text(v) === text(c.value));
    case "contains": return any((v) => text(v).includes(text(c.value)));
    case "in": return Array.isArray(c.value) && any((v) => c.value.some((/** @type {any} */ x) => text(x) === text(v)));
    case "gt": case "lt": case "gte": case "lte": {
      const a = num(list[0]), b = num(c.value);
      if (a === null || b === null) return false;
      return c.op === "gt" ? a > b : c.op === "lt" ? a < b : c.op === "gte" ? a >= b : a <= b;
    }
    default: return true;
  }
}

/** The rows every condition holds for (all of them, "and"); every row when there are none. @param {any[]} rows @param {any[] | undefined} filters */
export function layoutRows(rows, filters) {
  if (!Array.isArray(filters) || !filters.length) return rows;
  return rows.filter((r) => filters.every((c) => holdsCondition(r && r.data, c)));
}

/** A name turned on or off in an ordered list: off removes it, on adds it at the end. @param {string[]} list @param {string} name */
export const toggleName = (list, name) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);

/** A name one place up or down in an ordered list; at an end it stays. @param {string[]} list @param {string} name @param {-1 | 1} dir */
export function moveName(list, name, dir) {
  const i = list.indexOf(name), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = list.slice();
  out[i] = list[j]; out[j] = name;
  return out;
}

/** The layout to save when a key changes: the layout so far with that key replaced (or dropped when it says nothing). @param {any} layout @param {string} key @param {any} value */
export function withKey(layout, key, value) {
  const out = { ...(layout || {}) };
  if (value === undefined || value === null || (Array.isArray(value) && !value.length)) delete out[key]; else out[key] = value;
  return out;
}

/** Whether any key of the effective layout is the person's own (so "Reset to Space layout" has something to reset). @param {any} source */
export const hasMine = (source) => !!source && Object.values(source).some((s) => s === "mine");

/**
 * The layout one scope owns, with one key changed: records.layout.set replaces a scope's layout whole, so saving "mine" must not copy the Space's keys into the person's own layer (they would stop following the Space),
 * and saving "space" must not copy the person's. `layout` is the effective one and `source` says, key by key, which layer it came from.
 * @param {any} layout @param {any} source @param {"mine" | "space"} scope @param {string} key @param {any} value
 */
export function ownLayout(layout, source, scope, key, value) {
  const own = {};
  for (const k of Object.keys(layout || {})) if ((source && source[k] === "mine") === (scope === "mine")) /** @type {any} */ (own)[k] = layout[k];
  return withKey(own, key, value);
}
