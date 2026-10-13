// @ts-check
// A person's own saved views of a record type, as pure functions: the builder's choices become a stored view (the same shape a type stores in TypeDefinition.views, so one reader draws both), a
// personal view is one sidebar entry that carries its definition (lib/sidebar/model.js: a `view` payload; `hidden` means saved but not pinned), and a view shared with the space is written to the
// type itself (records.define) by an owner or an admin. A view only chooses layout, filter, sort and grouping: the rows always come from the permission-checked records the person can read, so a
// view, shared or not, never shows a record or a field its reader could not open without it.
import { viewDefOf } from "./view-defs.js";
import { add, keyOf, moveBefore, setHidden, remove } from "../../../../lib/sidebar/model.js";

/** The layouts a person picks. A table and a list are both a `list` view; a table names its columns. */
export const LAYOUTS = Object.freeze([
  { id: "list", label: "List", icon: "list", type: "list" },
  { id: "table", label: "Table", icon: "records", type: "list" },
  { id: "board", label: "Board", icon: "board", type: "board" },
  { id: "calendar", label: "Calendar", icon: "cal", type: "calendar" },
]);
/** What a personal view's name starts with, so it can never be mistaken for a view the type or a Kit stores. */
export const MINE = "mine-";
/** The filter words a person picks, and the operator each one writes. */
export const OPS = Object.freeze([
  { id: "is", label: "is", sym: "==" }, { id: "isnt", label: "is not", sym: "!=" }, { id: "atleast", label: "is at least", sym: ">=" }, { id: "atmost", label: "is at most", sym: "<=" },
  { id: "before", label: "is before", sym: "<" }, { id: "after", label: "is after", sym: ">" }, { id: "empty", label: "is empty" }, { id: "filled", label: "is filled in" },
]);
const NUMERIC = new Set(["number", "money", "rating", "integer", "decimal"]);
const hidden = (/** @type {any} */ f) => f.kind === "sealed" || f.hidden === true;

/** @param {{ fields: readonly any[] }} def */
export function fieldChoices(def) {
  const fs = (def.fields || []).filter((/** @type {any} */ f) => !hidden(f));
  return {
    groupBy: fs.filter((/** @type {any} */ f) => f.kind === "stage" || f.kind === "choice"),
    dateField: fs.filter((/** @type {any} */ f) => f.kind === "date" || f.kind === "datetime"),
    filter: fs.filter((/** @type {any} */ f) => f.kind !== "rich_text"),
    sort: fs.filter((/** @type {any} */ f) => f.kind !== "rich_text"),
    columns: fs.filter((/** @type {any} */ f) => f.kind !== "rich_text"),
  };
}

/** The layouts for a type, each with whether this type can have it and, when it cannot, why. @param {{ fields: readonly any[] }} def */
export function layoutsFor(def) {
  const c = fieldChoices(def);
  return LAYOUTS.map(l => {
    const why = l.id === "board" && !c.groupBy.length ? "Needs a stage or choice field to group by." : l.id === "calendar" && !c.dateField.length ? "Needs a date field to place records on." : "";
    return { ...l, ok: !why, why };
  });
}

/** One expression for a list of filters (joined by and), or undefined when none has a value. @param {{ field: string, op: string, value?: string }[]} filters @param {{ fields?: readonly any[] }} [def] */
export function filterExpr(filters, def) {
  const parts = [];
  for (const f of filters || []) {
    if (!f || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(f.field))) continue;
    if (f.op === "empty") { parts.push(`empty(${f.field})`); continue; }
    if (f.op === "filled") { parts.push(`not empty(${f.field})`); continue; }
    const op = OPS.find(o => o.id === f.op && o.sym);
    const raw = String(f.value ?? "").trim();
    if (!op || !raw) continue;
    const kind = def?.fields?.find(x => x.name === f.field)?.kind;
    const numeric = /^-?\d+(\.\d+)?$/.test(raw) && (NUMERIC.has(kind) || (kind === undefined && !["==", "!="].includes(/** @type {string} */ (op.sym))));
    parts.push(`${f.field} ${op.sym} ${numeric ? raw : JSON.stringify(raw)}`);
  }
  return parts.length ? parts.join(" and ") : undefined;
}

/** A stored name: lower case, dashes, nothing else. @param {string} s */
export const slugify = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * The builder's choices as a stored view, or the reasons it cannot be one. `taken` are the slugs of the person's other views of this type.
 * @param {{ name?: string, fields: readonly any[] }} def
 * @param {{ name: string, layout: string, groupBy?: string, dateField?: string, columns?: string[], filters?: any[], sort?: { field: string, dir?: string } }} draft
 * @param {{ taken?: readonly string[] }} [opts]
 * @returns {{ ok: true, view: any, errors: [] } | { ok: false, errors: string[] }}
 */
export function buildView(def, draft, opts = {}) {
  const errors = [];
  const label = String(draft.name || "").trim().slice(0, 60);
  const name = slugify(label);
  const lay = LAYOUTS.find(l => l.id === draft.layout);
  const c = fieldChoices(def);
  const has = (/** @type {any[]} */ list, /** @type {any} */ n) => list.some(f => f.name === n);
  if (!name) errors.push("Give the view a name.");
  else if ((opts.taken || []).includes(name)) errors.push("You already have a view with that name.");
  if (!lay) errors.push("Pick a layout.");
  /** @type {any} */ const view = { name, type: lay?.type, label };
  if (lay?.id === "board") { if (has(c.groupBy, draft.groupBy)) view.groupBy = draft.groupBy; else errors.push("Group the board by a stage or choice field."); }
  if (lay?.id === "calendar") { if (has(c.dateField, draft.dateField)) view.dateField = draft.dateField; else errors.push("A calendar needs a date field."); }
  if (lay?.id === "table") { const cols = (draft.columns || []).filter(n => has(c.columns, n)); if (cols.length) view.columns = cols; else errors.push("A table needs at least one column."); }
  const filter = filterExpr(draft.filters || [], def);
  if (filter) view.filter = filter;
  if (draft.sort && draft.sort.field) { if (has(c.sort, draft.sort.field)) view.sort = { field: draft.sort.field, dir: draft.sort.dir === "desc" ? "desc" : "asc" }; else errors.push("Sort by a field this type has."); }
  return errors.length ? { ok: false, errors } : { ok: true, view, errors: [] };
}

/** The sidebar entry that keeps a person's own view: hidden until pinned. @param {string} type @param {any} view a built view @param {{ icon?: string, pinned?: boolean }} [opts] */
export function personalEntry(type, view, opts = {}) {
  const name = MINE + view.name;
  const { name: _n, label: _l, type: layout, ...rest } = view;
  return {
    kind: /** @type {"view"} */ ("view"), id: `records-${type}-${name}`.slice(0, 64), label: String(view.label || view.name), href: `/u/records/${type}?view=${name}`,
    ...(opts.icon ? { icon: opts.icon } : {}), ...(opts.pinned ? {} : { hidden: /** @type {true} */ (true) }),
    view: { type, name, layout, ...rest },
  };
}

/** A person's saved views of one type, as the stored views a type holds, read from their sidebar entries (a renamed entry renames the view). @param {string} type @param {readonly any[]} entries */
export function personalViewsOf(type, entries) {
  return (entries || []).filter(e => e && e.kind === "view" && e.view && e.view.type === type).map(e => {
    const { type: _t, name, layout, ...rest } = e.view;
    return { name, type: layout, label: e.label, ...rest };
  });
}

/** A type with a person's views laid after its own. The type is not edited. @template {{ views?: readonly any[] }} T @param {T} def @param {readonly any[]} mine @returns {T} */
export const withPersonalViews = (def, mine) => (mine.length ? { ...def, views: [...(def.views || []), ...mine] } : def);

/** May this role share a view with the space (write it to the type)? @param {string | null | undefined} role */
export const canShare = role => role === "owner" || role === "admin";

const VIEWKEY = (/** @type {string} */ id) => `view:${id}`;
const isRecordsView = (/** @type {any} */ e) => e && e.kind === "view" && typeof e.href === "string" && e.href.startsWith("/u/records/");

/** The pins under Records: the visible records views of a sidebar list, in its order. @param {readonly any[]} list */
export const pinnedViews = list => list.filter(e => isRecordsView(e) && !e.hidden);

/** Keep a view and pin it (a saved personal view that is hidden is shown; a new entry is added). @param {any[]} list @param {string | any} idOrEntry */
export const pinList = (list, idOrEntry) => {
  if (typeof idOrEntry !== "string") return add(list, { ...idOrEntry, hidden: undefined });
  return setHidden(list, VIEWKEY(idOrEntry), false);
};

/** Unpin: a personal view stays saved (hidden); a pin with no definition behind it is taken out. @param {any[]} list @param {string} id */
export const unpinList = (list, id) => {
  const e = list.find(x => x.kind === "view" && x.id === id);
  if (!e) return list;
  return e.view ? setHidden(list, VIEWKEY(id), true) : remove(list, VIEWKEY(id));
};

/** A new name for a view; an empty one changes nothing. @param {any[]} list @param {string} id @param {string} label */
export const renameView = (list, id, label) => {
  const name = String(label || "").trim().slice(0, 60);
  return name ? list.map(e => (e.kind === "view" && e.id === id ? { ...e, label: name } : e)) : list;
};

/** Delete a saved view for good. @param {any[]} list @param {string} id */
export const deleteView = (list, id) => list.filter(e => !(e.kind === "view" && e.id === id));

/** Drag: one pin before another. An id the list does not have changes nothing. @param {any[]} list @param {string} id @param {string} beforeId */
export const reorderPinned = (list, id, beforeId) => (list.some(e => e.kind === "view" && e.id === id) && list.some(e => e.kind === "view" && e.id === beforeId) ? moveBefore(list, VIEWKEY(id), VIEWKEY(beforeId)) : list);

/** A built view as a view of the space: the type definition with the view added (the change records.define takes). Only an owner or an admin gets as far as sending it. @param {{ name: string, views?: readonly any[] }} def @param {any} view */
export function sharedEntry(def, view) {
  const have = def.views || [];
  if (have.length >= 30) return { ok: /** @type {const} */ (false), errors: ["This type already has 30 views."] };
  if (have.some(v => v.name === view.name)) return { ok: /** @type {const} */ (false), errors: ["The space already has a view with that name."] };
  return { ok: /** @type {const} */ (true), errors: [], type: { ...def, views: [...have, view] } };
}
export { viewDefOf, keyOf };
