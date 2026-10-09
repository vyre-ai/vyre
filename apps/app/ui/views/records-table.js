// @ts-check
// A type's records as the table block's typed content (design language): the columns the type's list view names, each row's cells typed by the field kind, and the little a surface needs to sort and
// filter them. Pure, so Node tests it, and the one place a record's values cross into a block, which is why it is where a sealed value is stopped:
//
//   A sealed field (kind sealed, a definition that seals, or a value that is a seal reference) becomes { k: "sealed", on } and nothing else. The value, its reference and its sort key never enter
//   the content, so they cannot reach a log, a chat card, an agent or a screenshot through it.
import { viewDefOf } from "./view-defs.js";
import { fieldOf, listColumns, optionsOf, titleOf, val, viewRows } from "./logic.js";
import { isEmpty, isSealedValue, normalizeKind, sortKey, urnOf, actorIdOf } from "../fields/logic.js";

/** Kinds that read as the line under a phone row's title. */
const LINE_KINDS = ["link", "ref", "stage", "choice", "text"];

/** @param {any} f @param {any} v */
const sealedOn = (f, v) => normalizeKind(f.kind) === "sealed" || !!f.seal || isSealedValue(v);

/**
 * One field's cell. Sealed first, so nothing below can read the value of a sealed field.
 * @param {any} f the field definition @param {any} rec @param {{ actors?: any[], links?: Record<string, any> }} env
 */
export function cellOf(f, rec, env) {
  const v = val(rec, f.name);
  if (sealedOn(f, v)) return { k: "sealed", on: !isEmpty(v) };
  const k = normalizeKind(f.kind);
  if (isEmpty(v)) return { k };
  const s = sortKey(k, v, { def: f, actors: env.actors, links: env.links });
  const base = { k, v, ...(s === null || s === undefined ? {} : { s }) };
  if (k === "link" || k === "ref") {
    const urn = urnOf(v), t = env.links?.[urn];
    return { ...base, v: urn, ...(t ? { link: { title: String(t.title), ...(t.type ? { type: String(t.type) } : {}) } } : {}) };
  }
  if (k === "actor") {
    const id = actorIdOf(v), a = (env.actors || []).find(x => x.id === id);
    return { ...base, v: id, who: { id, name: a ? a.name : v?.actor?.name || id, ...(a?.family ? { family: a.family } : {}), ...(a?.seed ? { seed: a.seed } : {}) } };
  }
  return base;
}

/** The part of a field definition a renderer needs: its label, options, target and currency; never a value. @param {any} f */
const defOf = f => ({ name: f.name, label: f.label, kind: normalizeKind(f.kind), ...(f.options ? { options: [...f.options] } : {}), ...(f.to ? { to: f.to } : {}), ...(f.currency ? { currency: f.currency } : {}) });

/**
 * @param {any} def the type definition @param {any[]} rows its records
 * @param {{ view?: string, noFilter?: boolean, env?: { actors?: any[], links?: Record<string, any> } }} [o]
 * @returns {{ props: Record<string, any>, content: Record<string, any> }}
 */
export function tableFromRecords(def, rows, o = {}) {
  const env = o.env || {};
  const vd = viewDefOf(def, undefined, o.view);
  const cols = listColumns(def, vd);
  const kept = viewRows(rows, o.noFilter ? undefined : vd.list?.filter);
  const money = cols.find((/** @type {any} */ f) => normalizeKind(f.kind) === "money");
  const dateField = vd.calendar ? fieldOf(def, vd.calendar.date) : null;
  const titleField = fieldOf(def, vd.titleField);
  const sortName = vd.list?.sort || vd.titleField;
  const sortF = fieldOf(def, sortName);
  /** @type {any[]} */
  const columns = [{ id: "_title", title: def.label, sortLabel: titleField ? titleField.label : def.label, kind: "title", role: "title", sort: true, initials: Boolean(vd.initials) }];
  for (const f of cols) {
    const k = normalizeKind(f.kind);
    columns.push({ id: f.name, title: f.label, kind: k, role: f === money ? "end" : !sealedOn(f, undefined) && LINE_KINDS.includes(k) ? "line" : "col", sort: !sealedOn(f, undefined), ...((k === "choice" || k === "stage") ? { filter: true, options: optionsOf(f) } : {}), f: defOf(f) });
  }
  // The phone row's date, and a field the view sorts by that is not a column, are carried as columns a wide table does not show.
  if (dateField && !columns.some(c => c.id === dateField.name)) columns.push({ id: dateField.name, title: dateField.label, kind: normalizeKind(dateField.kind), role: "endDate", f: defOf(dateField) });
  else if (dateField) { const c = columns.find(c => c.id === dateField.name); if (c) c.endDate = true; }
  if (sortF && sortF !== titleField && !columns.some(c => c.id === sortF.name)) columns.push({ id: sortF.name, title: sortF.label, kind: normalizeKind(sortF.kind), role: "sortOnly", sort: !sealedOn(sortF, undefined), f: defOf(sortF) });
  const outRows = kept.map(r => {
    const title = titleOf(def, r, vd);
    /** @type {Record<string, any>} */
    const cells = { _title: { k: "title", v: title, id: String(r.id ?? title), s: title.toLowerCase(), ...(vd.initials ? { initials: true } : {}) } };
    for (const c of columns) if (c.id !== "_title") cells[c.id] = cellOf(fieldOf(def, c.id), r, env);
    return { id: String(r.id ?? r.urn), urn: String(r.urn ?? ""), cells };
  });
  return {
    props: { controls: true, sort: sortF && sortF === titleField ? "_title" : sortName, desc: vd.list?.sortDir === "desc" },
    content: { columns, rows: outRows, total: rows.length, empty: `No ${vd.plural.toLowerCase()} here yet.` },
  };
}

/**
 * The rows in the order and under the filters the person chose: the chips' picks (a row stays when its value for each picked column is one of the picks), then the column's sort key, empty last, ties
 * kept in place. The same rules the list view had (filterRows, sortRows), over the cells' own sort keys, so the order is identical.
 * @param {any[]} rows @param {{ sort: string, desc: boolean, filters: Record<string, Set<string>> }} o
 */
export function orderRows(rows, { sort, desc, filters }) {
  const kept = rows.filter(r => Object.entries(filters).every(([name, set]) => !set.size || set.has(String(r.cells?.[name]?.v ?? ""))));
  const keyed = kept.map((r, i) => ({ r, i, k: (r.cells?.[sort] && typeof r.cells[sort] === "object" ? r.cells[sort].s : null) ?? null }));
  keyed.sort((a, b) => {
    if (a.k === null && b.k === null) return a.i - b.i;
    if (a.k === null) return 1;
    if (b.k === null) return -1;
    const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : String(a.k).localeCompare(String(b.k));
    return (desc ? -c : c) || a.i - b.i;
  });
  return keyed.map(x => x.r);
}
