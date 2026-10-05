// @ts-check
// A type's stored views (TypeDefinition.views) written into the Space's Records as its own views: a list is a table view, a board a kanban view grouped by
// the field, a calendar a calendar view on the date field; columns are the view's fields, a sort is a view sort, a filter is a filter group of field filters.
// The type definition stays what the gateway and the app read; this keeps the Records' own copy in step with it, one deterministic id per view, so a view
// is never made twice and a changed view replaces its old self. `page` and `dashboard` views have no Records form and are not written.
//
// A view's `filter` is an Expression. The Records' filters are a field, an operand and a value, joined by AND or OR, so the part of the language that has that
// shape is written (`area == "PI" and stage != "Closed"`, `empty(due)`, `not empty(due)`, `fee >= 100`, a date `<` or `>`) and anything else is kept in the
// definition only: the app still applies it, the Records' copy of the view simply shows the rows the filter would not narrow. `viewsPlan` says which.
import { createHash } from "node:crypto";
import { parseExpr } from "../../kernel/expr/expr.js";
import { optionValue } from "./plan.js";

const KIND = { list: "TABLE", board: "KANBAN", calendar: "CALENDAR" };
const ICON = { list: "IconTable", board: "IconLayoutKanban", calendar: "IconCalendar" };

/** One id per view of one type of one Space: a UUID made from the three, so the same view is always the same row. @param {string} space @param {string} type @param {string} name */
export function viewId(space, type, name) {
  const h = createHash("sha256").update(`vyre-view\0${space}\0${type}\0${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Operand and value for one comparison of a field with a literal, or null when the Records have no such filter. @param {any} f the field plan @param {string} op @param {any} v */
function leaf(f, op, v) {
  const isDate = f.type === "DATE" || f.type === "DATE_TIME";
  const val = f.type === "SELECT" ? JSON.stringify([optionValue(String(v))]) : f.type === "MULTI_SELECT" ? JSON.stringify([optionValue(String(v))]) : String(v);
  if (op === "==") return { operand: "IS", value: val };
  if (op === "!=") return { operand: "IS_NOT", value: val };
  if (op === ">=" && !isDate) return { operand: "GREATER_THAN_OR_EQUAL", value: val };
  if (op === "<=" && !isDate) return { operand: "LESS_THAN_OR_EQUAL", value: val };
  if (op === ">" && isDate) return { operand: "IS_AFTER", value: val };
  if (op === "<" && isDate) return { operand: "IS_BEFORE", value: val };
  return null;
}
const FLIP = { "<": ">", ">": "<", "<=": ">=", ">=": "<=", "==": "==", "!=": "!=" };

/**
 * An Expression as a filter group: `{ op: "AND"|"OR", filters: [{ field, operand, value }] }`, or null when it has no such form. @param {string} src @param {any} p the type plan
 * @returns {{ op: "AND" | "OR", filters: { field: string, operand: string, value: any }[] } | null}
 */
export function filterPlan(src, p) {
  let tree; try { tree = parseExpr(src); } catch { return null; }
  /** @param {any} n @param {string} op @param {any[]} out */
  const chain = (n, op, out) => { if (n.n === "bin" && n.op === op) { chain(n.a, op, out); chain(n.b, op, out); } else out.push(n); return out; };
  const top = tree.n === "bin" && tree.op === "or" ? "or" : "and";
  const parts = chain(tree, top, []);
  const filters = [];
  for (const n of parts) {
    const fld = (/** @type {any} */ x) => (x && x.n === "path" && x.p.length === 1 ? p.byVyre.get(x.p[0]) : undefined);
    if (n.n === "call" && n.f === "empty" && fld(n.a[0]) && !fld(n.a[0]).sealed) { filters.push({ field: fld(n.a[0]).twenty, operand: "IS_EMPTY", value: "" }); continue; }
    if (n.n === "un" && n.op === "not" && n.a.n === "call" && n.a.f === "empty" && fld(n.a.a[0]) && !fld(n.a.a[0]).sealed) { filters.push({ field: fld(n.a.a[0]).twenty, operand: "IS_NOT_EMPTY", value: "" }); continue; }
    if (n.n === "bin" && n.op in FLIP) {
      const left = fld(n.a), right = fld(n.b);
      const f = left && n.b.n === "lit" ? left : right && n.a.n === "lit" ? right : undefined;
      const lit = left && n.b.n === "lit" ? n.b.v : n.a.v;
      const op = left ? n.op : /** @type {any} */ (FLIP)[n.op];
      if (f && !f.sealed && lit !== null) { const l = leaf(f, op, lit); if (l) { filters.push({ field: f.twenty, ...l }); continue; } }
    }
    return null;
  }
  return filters.length ? { op: top === "or" ? "OR" : "AND", filters } : null;
}

/**
 * What the Records' views of one type should be. @param {any} p the type plan @param {string} space
 * @returns {{ name: string, id: string, view: any, fields: { field: string, position: number }[], groups: { value: string, position: number }[], sort: { field: string, direction: string } | null,
 *   filter: ReturnType<typeof filterPlan>, filterKept: boolean }[]}
 */
export function viewsPlan(p, space) {
  const out = [];
  for (const [i, v] of (p.def.views || []).entries()) {
    const kind = /** @type {any} */ (KIND)[v.type]; if (!kind) continue;
    const plan = (/** @type {string | undefined} */ n) => (n ? p.byVyre.get(n) : undefined);
    const fields = (v.columns || []).map((/** @type {string} */ c) => plan(c)).filter(Boolean).map((/** @type {any} */ f, /** @type {number} */ k) => ({ field: f.twenty, position: k }));
    const g = v.type === "board" ? plan(v.groupBy) : undefined;
    const d = v.type === "calendar" ? plan(v.dateField) : undefined;
    const sort = v.sort && plan(v.sort.field) ? { field: plan(v.sort.field).twenty, direction: v.sort.dir === "desc" ? "DESC" : "ASC" } : null;
    const filter = v.filter ? filterPlan(v.filter, p) : null;
    out.push({
      name: v.name, id: viewId(space, p.vyre, v.name),
      view: { name: v.label || v.name, type: kind, icon: /** @type {any} */ (ICON)[v.type], position: 100 + i, ...(g ? { mainGroupByFieldMetadataIdOf: g.twenty } : {}), ...(d ? { calendarFieldMetadataIdOf: d.twenty, calendarLayout: "MONTH" } : {}) },
      fields, groups: g ? (g.def.options || []).map((/** @type {string} */ o, /** @type {number} */ k) => ({ value: optionValue(o), position: k })) : [], sort, filter, filterKept: Boolean(v.filter) && !filter,
    });
  }
  return out;
}

/**
 * Bring the Records' views of one object in step with the plan: a view that is gone from the definition is destroyed, a changed or new one is (re)made from scratch under its own id.
 * @param {{ gql: (api: "metadata", q: string, vars?: any) => Promise<any> }} client @param {{ id: string, fields: Map<string, string> }} obj the Records object and its field ids by name
 * @param {any} p the type plan @param {string} space @param {any} [was] the definition as it stood, to know what changed and what was removed
 * @returns {Promise<string[]>} what changed, in words
 */
export async function syncViews(client, obj, p, space, was) {
  const changes = [];
  const want = viewsPlan(p, space);
  const gql = (/** @type {string} */ q, /** @type {any} */ vars) => client.gql("metadata", q, vars);
  const wasViews = new Map((was && was.views ? was.views : []).map((/** @type {any} */ v) => [v.name, v]));
  const nowViews = new Map((p.def.views || []).map((/** @type {any} */ v) => [v.name, v]));
  for (const [name] of wasViews) if (!nowViews.has(name) && /** @type {any} */ (KIND)[wasViews.get(name).type]) { await gql("mutation Gone($id: String!) { destroyView(id: $id) }", { id: viewId(space, p.vyre, name) }); changes.push(`removed view ${p.vyre}.${name}`); }
  const have = new Set((await gql("query V($o: String) { getViews(objectMetadataId: $o) { id } }", { o: obj.id })).getViews.map((/** @type {any} */ v) => v.id));
  for (const w of want) {
    const same = wasViews.has(w.name) && JSON.stringify(wasViews.get(w.name)) === JSON.stringify(nowViews.get(w.name)) && have.has(w.id);
    if (same) continue;
    if (have.has(w.id)) await gql("mutation Re($id: String!) { destroyView(id: $id) }", { id: w.id });
    const fid = (/** @type {string} */ tw) => { const id = obj.fields.get(tw); if (!id) throw new Error(`the Records have no field ${tw} on ${p.vyre}`); return id; };
    const { mainGroupByFieldMetadataIdOf, calendarFieldMetadataIdOf, ...rest } = w.view;
    const input = { id: w.id, objectMetadataId: obj.id, ...rest, ...(mainGroupByFieldMetadataIdOf ? { mainGroupByFieldMetadataId: fid(mainGroupByFieldMetadataIdOf) } : {}), ...(calendarFieldMetadataIdOf ? { calendarFieldMetadataId: fid(calendarFieldMetadataIdOf) } : {}) };
    await gql("mutation MkView($i: CreateViewInput!) { createView(input: $i) { id } }", { i: input });
    for (const f of w.fields) await gql("mutation MkVF($i: CreateViewFieldInput!) { createViewField(input: $i) { id } }", { i: { viewId: w.id, fieldMetadataId: fid(f.field), isVisible: true, position: f.position } });
    // a kanban view's groups (one per option, and one for no value) are made by the Records themselves when the grouping field is set; making them again would double every column
    if (w.sort) await gql("mutation MkVS($i: CreateViewSortInput!) { createViewSort(input: $i) { id } }", { i: { viewId: w.id, fieldMetadataId: fid(w.sort.field), direction: w.sort.direction } });
    if (w.filter) {
      const grp = (await gql("mutation MkVFG($i: CreateViewFilterGroupInput!) { createViewFilterGroup(input: $i) { id } }", { i: { viewId: w.id, logicalOperator: w.filter.op, positionInViewFilterGroup: 0 } })).createViewFilterGroup.id;
      for (const [k, f] of w.filter.filters.entries()) await gql("mutation MkVFl($i: CreateViewFilterInput!) { createViewFilter(input: $i) { id } }", { i: { viewId: w.id, fieldMetadataId: fid(f.field), operand: f.operand, value: f.value, viewFilterGroupId: grp, positionInViewFilterGroup: k } });
    }
    changes.push(`${have.has(w.id) ? "changed" : "added"} view ${p.vyre}.${w.name}${w.filterKept ? " (its filter is kept in the definition only)" : ""}`);
  }
  return changes;
}

/** What the Records hold of one view, in the plan's own terms, for a check that the two agree. @param {{ gql: Function }} client @param {string} id */
export async function readView(client, id) {
  const r = await client.gql("metadata", "query RV($id: String!) { getView(id: $id) { id name type icon position mainGroupByFieldMetadataId calendarFieldMetadataId viewFields { fieldMetadataId position isVisible } viewGroups { fieldValue position } viewSorts { fieldMetadataId direction } viewFilterGroups { id logicalOperator } viewFilters { fieldMetadataId operand value viewFilterGroupId } } }", { id });
  return r.getView;
}
