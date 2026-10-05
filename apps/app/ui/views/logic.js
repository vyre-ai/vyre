// @vyre/ui/views/logic: the pure half of the generated views (ui-primitives.md section 5), ported from deck/ui/views.js onto the kernel's shapes
// (TypeDefinition fields by `name`, GatewayRecord `data`). Which columns, which grouping, which month grid, what Seal-for-all
// confirms. A ViewDefinition (deck/ui/view-defs.js) names fields; nothing here knows a record type.
import { viewDefOf } from "./view-defs.js";
import { eventLine } from "../../src/vendor/deck/ui/kernel-view.js";
import { isEmpty, isoDay, toDate } from "../fields/logic.js";

const lc = (/** @type {string} */ s) => s.toLowerCase();
export { viewDefOf };

/** The field of a type by name. @param {any} def @param {string} name */
export const fieldOf = (def, name) => (def.fields || []).find((/** @type {any} */ f) => f.name === name);
/** A record's value for a field. @param {any} rec @param {string} name */
export const val = (rec, name) => rec?.data?.[name];
/** What a record is called: its title field, else its id. @param {any} def @param {any} rec @param {any} [vd] */
export const titleOf = (def, rec, vd = viewDefOf(def)) => String(val(rec, vd.titleField) ?? rec.id);
/** The options a choice has, or the stages a stage has. @param {any} f */
export const optionsOf = (f) => [...(f?.options || [])];
/** The first stage field of a type. @param {any} def */
export const stageField = (def) => (def.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
/** A field that holds a sealed value (its kind) or has been sealed from assistants (its seal config). @param {any} f */
export const isSealedField = (f) => f.kind === "sealed" || !!f.seal;
/** The first letters of a title, for a person-like type's tile. @param {string} s */
export const initialsOf = (s) => String(s).split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

/** The columns of the list: the definition's, in order, only those the type has. @param {any} def @param {any} [vd] */
export function listColumns(def, vd = viewDefOf(def)) {
  const names = vd.list?.columns || def.fields.slice(1, 5).map((/** @type {any} */ f) => f.name);
  return names.map((/** @type {string} */ n) => fieldOf(def, n)).filter(Boolean);
}
/** Which views a type has, in the order the switcher shows them. @param {any} def @param {any} [vd] @returns {("list"|"board"|"calendar"|"dashboard")[]} */
export function viewsOf(def, vd = viewDefOf(def)) {
  /** @type {("list"|"board"|"calendar"|"dashboard")[]} */
  const out = ["list"];
  if (vd.board && fieldOf(def, vd.board.groupBy)) out.push("board");
  if (vd.calendar && fieldOf(def, vd.calendar.date)) out.push("calendar");
  if (vd.dashboard?.widgets?.some((/** @type {any} */ w) => dashboardWidgetOk(def, w))) out.push("dashboard");
  return out;
}

/** The board: one column per option or stage of the grouping field, and "No <label>" for rows with none. @param {any} def @param {any} rows @param {any} [vd] */
export function boardColumns(def, rows, vd = viewDefOf(def)) {
  const g = vd.board && fieldOf(def, vd.board.groupBy);
  if (!g) return null;
  const names = optionsOf(g);
  const none = rows.filter((/** @type {any} */ r) => !names.includes(String(val(r, g.name) ?? "")));
  const columns = names.map((/** @type {string} */ n) => ({ id: n, title: n }));
  if (none.length) columns.push({ id: "", title: `No ${lc(g.label)}` });
  return { field: g, columns, cardFields: (vd.board.card || []).filter((/** @type {string} */ k) => k !== vd.titleField && k !== g.name).map((/** @type {string} */ k) => fieldOf(def, k)).filter(Boolean) };
}
/** The column a row sits in: its value, or the "No <label>" column. @param {any} g @param {any} rec */
export const columnOf = (g, rec) => { const v = String(val(rec, g.name) ?? ""); return optionsOf(g).includes(v) ? v : ""; };

/** Filter rows by chip selections: { fieldName: Set of chosen values }. An empty set for a field keeps every row. @param {any[]} rows @param {Record<string, Set<string>>} filters */
export function filterRows(rows, filters) {
  return rows.filter((r) => Object.entries(filters).every(([name, set]) => !set.size || set.has(String(val(r, name) ?? ""))));
}

// ------------------------------------------------------------------------------------------------------------------------------------ calendar

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The first month to show: the first one with a dated row from this month on, else the first dated row's, else this month. @param {any[]} dated @param {string} dateName @param {number} now */
export function startMonth(dated, dateName, now) {
  const n = new Date(now), from = new Date(n.getFullYear(), n.getMonth(), 1);
  const dates = dated.map((r) => toDate(val(r, dateName))).filter(Boolean).sort((a, b) => /** @type {Date} */ (a).getTime() - /** @type {Date} */ (b).getTime());
  const d = dates.find((x) => /** @type {Date} */ (x) >= from) || dates[0] || n;
  return { y: /** @type {Date} */ (d).getFullYear(), m: /** @type {Date} */ (d).getMonth() };
}
/** A month as weeks of seven cells, Monday first: a day number, or null before the 1st and after the last. @param {number} y @param {number} m @returns {(number|null)[][]} */
export function monthWeeks(y, m) {
  const days = new Date(y, m + 1, 0).getDate(), lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}
/** The month after n steps. @param {{ y: number, m: number }} ym @param {number} n */
export function stepMonth(ym, n) { const d = new Date(ym.y, ym.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; }
/** "2026-10-04" for a day of a month. @param {{ y: number, m: number }} ym @param {number} d */
export const dayKey = (ym, d) => `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** The rows dated in a month, grouped by day key. @param {any[]} rows @param {string} dateName @param {{ y: number, m: number }} ym @returns {Record<string, any[]>} */
export function rowsByDay(rows, dateName, ym) {
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const r of rows) {
    const d = toDate(val(r, dateName));
    if (!d || d.getFullYear() !== ym.y || d.getMonth() !== ym.m) continue;
    (out[isoDay(d)] ||= []).push(r);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------------ record page

/** The confirm for "Seal this field for all <type>": it names how many records have a value. @param {any} def @param {any} f @param {any[]} pool @param {any} [vd] */
export function sealSpec(def, f, pool, vd = viewDefOf(def)) {
  const n = pool.filter((r) => !isEmpty(val(r, f.name))).length, word = lc(vd.plural);
  return { title: `Seal ${f.label} for all ${word}?`, action: "Seal",
    body: `${n} of ${pool.length} ${word} ${n === 1 ? "has a value" : "have a value"} for ${lc(f.label)}. Assistants will see "${f.label} on file, sealed" on each and will never get the value. You can still reveal it with Face ID.` };
}

/** What the banner says while the person looks as their assistant does. @param {any[]} sealedNow the sealed fields that hold a value on this record */
export function assistantNote(sealedNow) {
  return sealedNow.length
    ? `${sealedNow.length} ${sealedNow.length === 1 ? "field is" : "fields are"} sealed, so it sees ${sealedNow.map((f) => `"${f.label} on file, sealed"`).join(", ")} instead of the values.`
    : "Nothing on this record is sealed. A field menu can seal a field for every record of the type.";
}

/** The urn of a route param: a urn as it is (decoded), or null for a bare id. @param {string} param */
export function urnParam(param) {
  const s = decodeURIComponent(String(param || ""));
  return /^vyre:\/\/[^/]+\/[^/]+\/[^/]+$/.test(s) ? s : null;
}

/** id -> { title, type } for every record of every type, so a link shows its target's title. @param {any[]} types @param {Record<string, any[]>} byType */
export function linkIndex(types, byType) {
  /** @type {Record<string, { title: string, type: string, id: string }>} */
  const out = {};
  for (const t of types) for (const r of byType[t.name] || []) out[r.urn] = { title: titleOf(t, r), type: t.name, id: r.id };
  return out;
}

/** The records a record links to (its link fields) and the records that link to it, as [{ urn, title, type }]. @param {any[]} types @param {Record<string, any[]>} byType @param {any} def @param {any} rec */
export function relatedRecords(types, byType, def, rec) {
  const idx = linkIndex(types, byType);
  /** @type {{ urn: string, title: string, type: string }[]} */
  const out = [];
  const add = (/** @type {string} */ urn) => { if (urn && urn !== rec.urn && idx[urn] && !out.some((o) => o.urn === urn)) out.push({ urn, title: idx[urn].title, type: idx[urn].type }); };
  for (const f of def.fields) if (f.kind === "link" || f.kind === "ref") add(String(val(rec, f.name)?.urn || ""));
  for (const t of types) for (const f of t.fields) if ((f.kind === "link" || f.kind === "ref") && f.to === def.name)
    for (const r of byType[t.name] || []) if (val(r, f.name)?.urn === rec.urn) add(r.urn);
  return out;
}

/** The file names on a record: its file fields. @param {any} def @param {any} rec */
export function filesOf(def, rec) {
  return def.fields.filter((/** @type {any} */ f) => f.kind === "file" && !isEmpty(val(rec, f.name))).map((/** @type {any} */ f) => ({ field: f.label, name: String(val(rec, f.name).name || val(rec, f.name).file) }));
}

/** An event as a timeline line: who (by id), what, when, why. @param {any} e */
export const timelineLine = (e) => eventLine(e);

/** "Today", "Yesterday", "3 days ago", "Oct 3": when an event happened, for the timeline. @param {number} at @param {number} now */
export function ago(at, now) {
  const day = (/** @type {number} */ t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const n = Math.round((day(now) - day(at)) / 86400_000);
  const time = new Date(at);
  const hm = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
  if (n <= 0) return `Today, ${hm}`;
  if (n === 1) return `Yesterday, ${hm}`;
  if (n < 7) return `${n} days ago`;
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][time.getMonth()]} ${time.getDate()}`;
}

/** A field spec for the store's addField from the Add a field sheet. @param {{ label: string, kind: string }} draft @param {any} def */
export function newFieldSpec(draft, def) {
  return { label: draft.label.trim(), kind: draft.kind, ...(draft.kind === "link" ? { to: def.name } : {}) };
}

// ------------------------------------------------------------------------------------------------------------------------------------ dashboard

/** A widget the type can draw: "recent" needs nothing, the others need their field. @param {any} def @param {any} w */
export const dashboardWidgetOk = (def, w) => w.kind === "recent" || !!(w.field && fieldOf(def, w.field));

/** `field op value` (!=, >=, <=, =, >, <) as a row test, or null when the text is not one. @param {string} where @returns {((rec: any) => boolean) | null} */
export function whereFn(where) {
  const m = /^\s*(\w+)\s*(!=|>=|<=|=|>|<)\s*(.+?)\s*$/.exec(where || "");
  if (!m) return null;
  const [, name, op, rhs] = m;
  const numeric = !Number.isNaN(Number(rhs));
  return (rec) => {
    const v = val(rec, name), a = numeric ? Number(v) : String(v ?? ""), b = numeric ? Number(rhs) : rhs;
    return op === "=" ? a === b : op === "!=" ? a !== b : op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
  };
}
/** The where text in words: "stage is not Closed". @param {string} w */
export const saysWhere = (w) => w.replace("!=", "is not").replace(">=", "is at least").replace("<=", "is at most").replace(/ = /, " is ").replace(" > ", " is over ").replace(" < ", " is under ");
/** A number out of a field value: money and plain numbers, anything else 0. @param {any} v */
export const numberOf = (v) => { const n = typeof v === "object" && v ? Number(v.amount) : Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * What the dashboard draws, as data. sum: the total of a number or money field over the rows that pass `where`; countBy: a bar per stage or option;
 * funnel: a bar per stage in `where` ("From..To"), counting rows that reached that stage or later; recent: the five rows changed last.
 * @param {any} def @param {any[]} rows @param {any} [vd] @returns {any[]}
 */
export function dashboardCards(def, rows, vd = viewDefOf(def)) {
  /** @type {any[]} */
  const out = [];
  for (const w of vd.dashboard?.widgets || []) {
    if (!dashboardWidgetOk(def, w)) continue;
    const f = w.field ? fieldOf(def, w.field) : null;
    if (w.kind === "sum" && f) {
      const keep = whereFn(w.where || ""), use = keep ? rows.filter(keep) : rows;
      out.push({ kind: "sum", title: `${f.label} total`, total: use.reduce((a, r) => a + numberOf(val(r, f.name)), 0), money: f.kind === "money", field: f,
        hint: `${use.length} ${lc(use.length === 1 ? def.label || def.name : vd.plural)}${w.where ? ", " + saysWhere(w.where) : ""}` });
    } else if (w.kind === "countBy" && f) {
      const bars = optionsOf(f).map((/** @type {string} */ n) => [n, rows.filter((r) => String(val(r, f.name) ?? "") === n).length]);
      out.push({ kind: "countBy", title: `${vd.plural} by ${lc(f.label)}`, bars, max: Math.max(1, ...bars.map((/** @type {any} */ b) => b[1])) });
    } else if (w.kind === "funnel" && f) {
      const all = optionsOf(f), [from, to] = String(w.where || "").split("..");
      const a = Math.max(0, all.indexOf(from)), b = to ? all.indexOf(to) : all.length - 1, span = all.slice(a, (b < 0 ? all.length - 1 : b) + 1);
      const bars = span.map((/** @type {string} */ n, /** @type {number} */ i) => [n, rows.filter((r) => all.indexOf(String(val(r, f.name))) >= a + i).length]);
      out.push({ kind: "funnel", title: `${span[0]} to ${span[span.length - 1]} funnel`, bars, max: Math.max(1, rows.length), hint: "Reached this stage or later" });
    } else if (w.kind === "recent") {
      out.push({ kind: "recent", title: "Recently changed", rows: [...rows].sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0)).slice(0, 5) });
    }
  }
  return out;
}
/** The width of a bar, 0 to 100. @param {number} n @param {number} max */
export const barPct = (n, max) => Math.round((n / Math.max(max, 1)) * 100);
