// @ts-check
// deck/ui/views: the five views, generated from a TypeDef and its rows (ui-primitives.md section 5). There is no code per record type here: a list, a board, a
// calendar, a dashboard and a record page all read the definition's fields and draw every value through fields.js. A field added to the definition (addField)
// is on every view of that type the next time it is drawn, with no new screen.
//
//   listView(def, rows, o)      table: columns from def.views.list, sort, filter chips; rows on a phone (the table component)
//   boardView(def, rows, o)     columns by a choice or stage field; they stack on a phone
//   calendarView(def, rows, o)  a month grid, a dot per day on a phone, and the agenda
//   dashboardView(def, rows, o) widgets: sum, countBy, funnel, recent
//   recordPage(def, row, o)     fields in order, You / Your assistant sees, Add a field, stage steps, timeline, linked records, chats, files, field menu
//   describeDef(def, kind)      the text "How this page is made" shows
//
// o: { actors, links, who, now, open(id), reveal(rowId, key, proof), store, empty, rowExtra(row), onupdate(patch), onaddfield(field), onsealtype(key),
//      rows (every row of the type, for the sealed count), events, team, related, chats, files, doing, seesAs(rowId), confirm(spec), faceId, timers }
import { h, add, put } from "../js/dom.js";
import { when } from "../js/fmt.js";
import { icon } from "../js/icons.js";
import { avatar, agentAvatar } from "../js/avatars.js";
import { display, edit, KINDS, sortRows, isEmpty, toDate, isoDay, fmtMoney, fmtDate } from "./fields.js";
import { button, iconButton, chip, segmented, card, banner, menu, table, stageSteps, timelineItem, emptyState, openSheet } from "./components/index.js";

/** @typedef {import("./contracts.js").TypeDef} TypeDef */
/** @typedef {import("./contracts.js").FieldDef} FieldDef */
/** @typedef {import("./contracts.js").RecordRow} RecordRow */

// ------------------------------------------------------------------------------------------------------------------------------ helpers

/** @param {TypeDef} def @param {string} key @returns {FieldDef | undefined} */
export const fieldOf = (def, key) => def.fields.find(f => f.key === key);
/** A row's value for a key: values[key], or the row's stage for a stage field the store keeps there. @param {TypeDef} def @param {RecordRow} row @param {string} key */
export function val(def, row, key) {
  const v = row.values?.[key];
  if (v !== undefined) return v;
  return fieldOf(def, key)?.kind === "stage" ? row.stage : undefined;
}
/** @param {TypeDef} def @param {RecordRow} row */
export const titleOf = (def, row) => String(val(def, row, def.titleKey) ?? row.id);
const stagesOf = (/** @type {FieldDef} */ f) => f.stages || f.options || [];
const lc = (/** @type {string} */ s) => s.toLowerCase();
/** The first stage field of a definition, if it has one. @param {TypeDef} def */
export const stageField = def => def.fields.find(f => f.kind === "stage");

/** The ctx a field renderer gets. @param {any} o @param {FieldDef} f @param {{ who?: "person"|"assistant", rowId?: string }} [x] */
function fctx(o, f, x = {}) {
  return { def: f, actors: o.actors || [], links: o.links || {}, who: x.who || o.who || "person", now: o.now, open: o.open, store: o.store, timers: o.timers, faceId: o.faceId,
    reveal: x.rowId && o.reveal ? (/** @type {any} */ proof) => o.reveal(x.rowId, f.key, proof) : undefined };
}
const nameOf = (/** @type {any} */ o, /** @type {string} */ id) => (o.actors || []).find((/** @type {any} */ a) => a.id === id)?.name || String(id);
const actorAv = (/** @type {any} */ o, /** @type {string} */ id, size = 24) => { const a = (o.actors || []).find((/** @type {any} */ x) => x.id === id); return !a || a.kind === "person" ? avatar("person", a?.seed || id, { size }) : agentAvatar(id, { size }); };
const initialsOf = (/** @type {string} */ s) => s.split(/[\s.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
const TINTS = 6;
/** The initials tile a person-like type shows before its title. @param {string} title */
const tile = title => { let n = 0; for (const c of title) n += c.charCodeAt(0); return h("span", { class: `uv-ini uv-ini-${n % TINTS}`, "aria-hidden": "true" }, initialsOf(title)); };
const dayKey = (/** @type {any} */ v) => isoDay(v);

/** Add a field to a definition so every view of the type shows it: the record page (fields), the list (a column) and the board (a card line). Returns the field.
 * The one place a custom field is made; a store with its own addField is used by the screen instead. @param {TypeDef} def @param {{ label: string, kind: FieldDef["kind"] } & Partial<FieldDef>} spec */
export function addField(def, spec) {
  let key = lc(spec.label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
  const base = key; let n = 2;
  while (def.fields.some(f => f.key === key)) key = `${base}_${n++}`;
  /** @type {FieldDef & { custom?: boolean }} */
  const f = { ...spec, key, custom: true };
  if (f.kind === "choice" && !f.options) f.options = ["Option A", "Option B"];
  if (f.kind === "stage" && !f.stages) f.stages = ["Start", "Middle", "Done"];
  def.fields.push(f);
  if (def.views.list && f.kind !== "richText" && f.kind !== "sealed") def.views.list.columns = [...def.views.list.columns, key];
  if (def.views.board && f.kind !== "richText" && f.kind !== "sealed") def.views.board.card = [...def.views.board.card, key];
  return f;
}
/** Seal a field from every assistant on every record of the type (a space admin's act). @param {TypeDef} def @param {string} key */
export function sealField(def, key) { const f = fieldOf(def, key); if (f) f.sealed = true; return f; }

/** @param {string} where @returns {((def: TypeDef, row: RecordRow) => boolean) | null} */
function whereFn(where) {
  const m = /^\s*(\w+)\s*(!=|>=|<=|=|>|<)\s*(.+?)\s*$/.exec(where || "");
  if (!m) return null;
  const [, key, op, rhs] = m;
  return (def, row) => {
    const v = val(def, row, key), a = Number.isNaN(Number(rhs)) ? String(v) : Number(v), b = Number.isNaN(Number(rhs)) ? rhs : Number(rhs);
    return op === "=" ? a === b : op === "!=" ? a !== b : op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
  };
}
const saysWhere = (/** @type {string} */ w) => w.replace("!=", "is not").replace(">=", "is at least").replace("<=", "is at most").replace(/ = /, " is ").replace(" > ", " is over ").replace(" < ", " is under ");

/** The text the "How this page is made" disclosure shows: the definition that drew the page. @param {TypeDef} def @param {"list"|"board"|"calendar"|"dashboard"|"record"} kind */
export function describeDef(def, kind) {
  const V = def.views;
  const fieldsLine = def.fields.map(f => `${f.key} ${f.kind}${f.kind === "link" && f.link ? " " + f.link : ""}${f.kind === "stage" ? `[${stagesOf(f).join(", ")}]` : ""}${f.kind === "choice" && f.options ? `[${f.options.join(", ")}]` : ""}${f.sealed ? " (sealed)" : ""}`).join("\n    ");
  const lines = {
    list: V.list ? `view "${def.plural} list" of ${def.name}\n  columns: ${V.list.columns.join(", ")}${V.list.sort ? `\n  sort: ${V.list.sort}` : ""}` : "",
    board: V.board ? `view "${def.plural} board" of ${def.name}\n  group by: ${V.board.groupBy}\n  card: ${V.board.card.join(", ")}` : "",
    calendar: V.calendar ? `view "${def.plural} calendar" of ${def.name}\n  date: ${V.calendar.date}` : "",
    dashboard: V.dashboard ? `view "${def.plural} dashboard" of ${def.name}\n${V.dashboard.widgets.map(w => "  widget " + (w.kind === "recent" ? "recent" : `${w.kind}(${w.field})${w.where ? " where " + w.where : ""}`)).join("\n")}` : "",
    record: `view "${def.name} page" of ${def.name}\n  fields, in order:\n    ${fieldsLine}\n  also: timeline, linked records, chats, files`,
  };
  return `${lines[kind]}\n\nNo screen was written for ${lc(def.plural)}. The renderers read the type's fields.`;
}
/** @param {TypeDef} def @param {"list"|"board"|"calendar"|"dashboard"|"record"} kind */
const howMade = (def, kind) => h("details", { class: "uv-def" }, h("summary", null, "How this page is made"), h("pre", null, describeDef(def, kind)));

// ------------------------------------------------------------------------------------------------------------------------------ list

/**
 * The list: a table with the title first, the columns the definition names, a sort, and chips for the choice and stage columns.
 * @param {TypeDef} def @param {RecordRow[]} rows @param {any} [o] @returns {HTMLElement}
 */
export function listView(def, rows, o = {}) {
  const spec = def.views.list || { columns: def.fields.slice(1, 5).map(f => f.key) };
  const cols = spec.columns.map(k => fieldOf(def, k)).filter(/** @returns {f is FieldDef} */ f => !!f);
  const state = { sort: spec.sort || def.titleKey, desc: false, filters: /** @type {Record<string, Set<string>>} */ ({}) };
  const root = h("div", { class: "uv-list" });
  const sortable = [def.fields.find(f => f.key === def.titleKey), ...cols].filter((f, i, a) => f && a.indexOf(f) === i);
  const chipFields = cols.filter(f => f.kind === "choice" || f.kind === "stage");

  function draw() {
    let shown = rows.filter(r => chipFields.every(f => !state.filters[f.key]?.size || state.filters[f.key].has(String(val(def, r, f.key) ?? ""))));
    const sf = fieldOf(def, state.sort);
    if (sf) shown = sortRows(shown, r => val(def, r, sf.key), sf.kind, fctx(o, sf), state.desc);
    const columns = [
      { key: "_title", label: def.name, render: (/** @type {RecordRow} */ r) => h("span", { class: "uv-title" }, /** @type {any} */ (def).initials ? tile(titleOf(def, r)) : null, h("b", null, titleOf(def, r)), o.rowExtra ? o.rowExtra(r) : null) },
      ...cols.map(f => ({ key: f.key, label: f.label, render: (/** @type {RecordRow} */ r) => display(f.kind, val(def, r, f.key), fctx(o, f)) })),
    ];
    const bar = h("div", { class: "uv-bar" },
      chipFields.map(f => h("div", { class: "uv-chips", role: "group", "aria-label": f.label }, stagesOrOptions(f).map(opt => {
        const on = !!state.filters[f.key]?.has(opt);
        return h("button", { type: "button", class: "uv-fchip", "aria-pressed": String(on), onclick: () => { const s = (state.filters[f.key] ||= new Set()); if (s.has(opt)) s.delete(opt); else s.add(opt); draw(); } }, opt);
      }))),
      h("span", { class: "uv-grow" }),
      h("label", { class: "uv-sort" }, h("span", null, "Sort"),
        h("select", { class: "ui-input uv-select", "aria-label": "Sort by", onchange: (/** @type {any} */ e) => { state.sort = e.target.value; draw(); } },
          sortable.map(f => h("option", { value: f?.key, selected: f?.key === state.sort }, f?.label))),
        iconButton({ icon: state.desc ? "right" : "left", label: state.desc ? "Sorted high to low. Reverse" : "Sorted low to high. Reverse", size: 32, onclick: () => { state.desc = !state.desc; draw(); } })));
    put(root, bar, card({}, table({ columns, rows: shown, onrow: o.open ? (/** @type {RecordRow} */ r) => o.open(r.id) : undefined, empty: o.empty ?? `No ${lc(def.plural)} here yet.` })), howMade(def, "list"));
  }
  draw();
  return root;
}
/** @param {FieldDef} f */
const stagesOrOptions = f => f.kind === "stage" ? stagesOf(f) : f.options || [];

// ------------------------------------------------------------------------------------------------------------------------------ board

/** @param {TypeDef} def @param {RecordRow[]} rows @param {any} [o] @returns {HTMLElement} */
export function boardView(def, rows, o = {}) {
  const spec = def.views.board;
  const g = spec && fieldOf(def, spec.groupBy);
  if (!spec || !g) return h("div", { class: "uv-board" }, emptyState({ title: "No board for this type", body: "Its definition has no field to group by." }));
  const groups = stagesOrOptions(g);
  const none = rows.filter(r => !groups.includes(String(val(def, r, g.key) ?? "")));
  const columns = [...groups.map(n => [n, rows.filter(r => val(def, r, g.key) === n)]), ...(none.length ? [[`No ${lc(g.label)}`, none]] : [])];
  const cardKeys = spec.card.filter(k => k !== def.titleKey && k !== g.key);
  return h("div", { class: "uv-board" }, h("div", { class: "uv-cols" }, columns.map(([name, rs]) =>
    h("section", { class: "uv-col", "aria-label": String(name) }, h("h4", null, String(name), h("span", { class: "uv-n" }, String(/** @type {any[]} */ (rs).length))),
      /** @type {RecordRow[]} */ (rs).map(r => h(o.open ? "button" : "div", { class: "uv-bc", type: o.open ? "button" : null, onclick: o.open ? () => o.open(r.id) : null },
        h("b", null, titleOf(def, r)),
        cardKeys.map(k => { const f = fieldOf(def, k); return f ? h("span", { class: "uv-bc-m", "data-key": k }, display(f.kind, val(def, r, k), fctx(o, f))) : null; }),
        o.rowExtra ? o.rowExtra(r) : null))))),
    howMade(def, "board"));
}

// ------------------------------------------------------------------------------------------------------------------------------ calendar

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** @param {TypeDef} def @param {RecordRow[]} rows @param {any} [o] @returns {HTMLElement} */
export function calendarView(def, rows, o = {}) {
  const dk = def.views.calendar?.date, f = dk ? fieldOf(def, dk) : null;
  if (!dk || !f) return h("div", { class: "uv-cal" }, emptyState({ title: "No calendar for this type", body: "Its definition has no date to place rows on." }));
  const dated = rows.filter(r => toDate(val(def, r, dk)));
  const now = new Date(o.now ?? Date.now());
  const first = dated.map(r => toDate(val(def, r, dk))).sort((a, b) => /** @type {Date} */ (a).getTime() - /** @type {Date} */ (b).getTime()).find(d => /** @type {Date} */ (d) >= new Date(now.getFullYear(), now.getMonth(), 1)) || dated.length && toDate(val(def, dated[0], dk)) || now;
  let ym = o.month ? { y: +o.month.slice(0, 4), m: +o.month.slice(5, 7) - 1 } : { y: /** @type {Date} */ (first).getFullYear(), m: /** @type {Date} */ (first).getMonth() };
  const root = h("div", { class: "uv-cal" });
  const step = (/** @type {number} */ n) => { const d = new Date(ym.y, ym.m + n, 1); ym = { y: d.getFullYear(), m: d.getMonth() }; draw(); };
  function draw() {
    const inMonth = dated.filter(r => { const d = /** @type {Date} */ (toDate(val(def, r, dk))); return d.getFullYear() === ym.y && d.getMonth() === ym.m; });
    const days = new Date(ym.y, ym.m + 1, 0).getDate(), lead = (new Date(ym.y, ym.m, 1).getDay() + 6) % 7;
    const cells = [];
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) cells.push(h("div", { class: "uv-d uv-dh" }, d));
    for (let i = 0; i < lead; i++) cells.push(h("div", { class: "uv-d uv-do", "aria-hidden": "true" }));
    for (let d = 1; d <= days; d++) {
      const key = `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const ev = inMonth.filter(r => dayKey(val(def, r, dk)) === key);
      cells.push(h("div", { class: `uv-d${ev.length ? " has" : ""}`, "data-day": key }, h("span", { class: "uv-dn" }, String(d)),
        ev.map(r => h("button", { type: "button", class: "uv-ev", title: titleOf(def, r), onclick: o.open ? () => o.open(r.id) : null }, titleOf(def, r))),
        ev.length ? h("span", { class: "uv-dot", "aria-label": `${ev.length} ${lc(def.plural)}` }) : null));
    }
    const agenda = sortRows(inMonth, r => val(def, r, dk), f.kind, fctx(o, f));
    put(root,
      h("div", { class: "uv-bar" }, iconButton({ icon: "left", label: "Previous month", size: 32, onclick: () => step(-1) }),
        h("b", { class: "uv-month" }, `${MONTHS[ym.m]} ${ym.y}`), iconButton({ icon: "right", label: "Next month", size: 32, onclick: () => step(1) }),
        h("span", { class: "uv-hint" }, `by ${lc(f.label)} date`)),
      h("div", { class: "uv-grid" }, cells),
      card({ title: "Agenda" }, agenda.length ? agenda.map(r => h(o.open ? "button" : "div", { class: "uv-ag", type: o.open ? "button" : null, onclick: o.open ? () => o.open(r.id) : null },
        h("b", null, titleOf(def, r)), h("span", { class: "uv-hint" }, fmtDate(val(def, r, dk), o.now)))) : h("div", { class: "uv-hint uv-pad" }, `No ${lc(def.plural)} this month.`)),
      howMade(def, "calendar"));
  }
  draw();
  return root;
}

// ------------------------------------------------------------------------------------------------------------------------------ dashboard

/** @param {TypeDef} def @param {RecordRow[]} rows @param {any} [o] @returns {HTMLElement} */
export function dashboardView(def, rows, o = {}) {
  const widgets = def.views.dashboard?.widgets || [];
  const bars = (/** @type {[string, number][]} */ data, /** @type {number} */ max) => h("div", { class: "uv-bars" }, data.map(([l, n]) =>
    h("div", { class: "uv-b" }, h("span", null, l), h("i", { style: `--w:${Math.round(n / Math.max(max, 1) * 100)}%` }), h("span", { class: "uv-num" }, String(n)))));
  const cards = widgets.map(w => {
    const f = w.field ? fieldOf(def, w.field) : null;
    if (w.kind === "sum" && f) {
      const keep = whereFn(w.where || ""), use = keep ? rows.filter(r => keep(def, r)) : rows;
      const total = use.reduce((a, r) => a + (Number(val(def, r, f.key)) || 0), 0);
      return card({ title: `${f.label} total` }, h("div", { class: "uv-big uv-num" }, f.kind === "money" ? fmtMoney(total, f) : String(total)),
        h("div", { class: "uv-hint" }, `${use.length} ${lc(use.length === 1 ? def.name : def.plural)}${w.where ? ", " + saysWhere(w.where) : ""}`));
    }
    if (w.kind === "countBy" && f) {
      const names = stagesOrOptions(f), data = /** @type {[string, number][]} */ (names.map(n => [n, rows.filter(r => val(def, r, f.key) === n).length]));
      return card({ title: `${def.plural} by ${lc(f.label)}` }, bars(data, Math.max(...data.map(d => d[1]), 1)));
    }
    if (w.kind === "funnel" && f) {
      const all = stagesOrOptions(f), [from, to] = (w.where || "").split("..");
      const a = Math.max(0, all.indexOf(from)), b = to ? all.indexOf(to) : all.length - 1, span = all.slice(a, (b < 0 ? all.length - 1 : b) + 1);
      const data = /** @type {[string, number][]} */ (span.map((n, i) => [n, rows.filter(r => all.indexOf(String(val(def, r, f.key))) >= a + i).length]));
      return card({ title: `${span[0]} to ${span[span.length - 1]} funnel` }, bars(data, rows.length), h("div", { class: "uv-hint" }, "Reached this stage or later"));
    }
    if (w.kind === "recent") {
      const last = [...rows].sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 5);
      return card({ title: "Recently changed" }, last.length ? last.map(r => h(o.open ? "button" : "div", { class: "uv-ag", type: o.open ? "button" : null, onclick: o.open ? () => o.open(r.id) : null },
        h("b", null, titleOf(def, r)), h("span", { class: "uv-hint" }, when(r.updatedAt)))) : h("div", { class: "uv-hint uv-pad" }, "Nothing yet."));
    }
    return null;
  });
  return h("div", { class: "uv-dash-wrap" }, h("div", { class: "uv-dash" }, cards), howMade(def, "dashboard"));
}

// ------------------------------------------------------------------------------------------------------------------------------ record page

/** A confirm sheet. Resolves true when the person accepts. @param {{ title: string, body: string, action: string }} spec @returns {Promise<boolean>} */
function confirmSheet(spec) {
  return new Promise(resolve => {
    let ok = false;
    openSheet({ title: spec.title, onClose: () => resolve(ok), build: (body, close, parts) => {
      add(body, h("p", { class: "uv-sheet-p" }, spec.body));
      add(parts.actions, button({ label: spec.action, kind: "primary", onclick: () => { ok = true; close(); } }), button({ label: "Cancel", kind: "ghost", onclick: () => close() }));
    } });
  });
}

/** One sample value per kind, for the Add a field panel. @param {FieldDef} f @param {any} o */
function sampleFor(f, o) {
  const samples = { text: "Sample text", number: 42, money: 1250, date: isoDay(o.now ?? Date.now()), choice: (f.options || [])[0], stage: stagesOf(f)[0], actor: (o.actors || [])[0]?.id,
    link: Object.keys(o.links || {})[0], file: "Notes.pdf", address: "18 Larkin St, San Francisco", phone: "+1 415 555 0142", email: "name@example.com", richText: "A short note with **emphasis**.", rating: 4, sealed: "412-55-6789" };
  return /** @type {any} */ (samples)[f.kind];
}

/**
 * The record page. Returns the element; `el.setRow(row, def?)` redraws it from fresh data (a screen calls it when the store changes).
 * @param {TypeDef} def @param {RecordRow} row @param {any} [o]
 */
export function recordPage(def, row, o = {}) {
  let cur = row, seen = /** @type {Record<string, any> | null} */ (null);
  const st = { who: /** @type {"person"|"assistant"} */ (o.who || "person"), editing: /** @type {string|null} */ (null) };
  const root = /** @type {any} */ (h("div", { class: "uv-rec" }));
  const confirm = o.confirm || confirmSheet;
  const saveable = (/** @type {Record<string, any>} */ patch) => {
    const run = o.onupdate ? o.onupdate(patch) : null;
    return Promise.resolve(run).then(r => { cur = r && r.values ? r : { ...cur, values: { ...cur.values, ...patch }, updatedAt: Date.now() }; st.editing = null; draw(); });
  };
  const valueFor = (/** @type {FieldDef} */ f) => (st.who === "assistant" && seen ? seen[f.key] : val(def, cur, f.key));
  const sealedField = (/** @type {FieldDef} */ f) => f.kind === "sealed" || !!f.sealed;

  function fieldRow(/** @type {FieldDef} */ f) {
    const ai = st.who === "assistant", editing = st.editing === f.key && !ai;
    const ctx = fctx(o, f, { who: st.who, rowId: cur.id });
    let body;
    if (editing) {
      const ed = edit(f.kind, val(def, cur, f.key), { ...ctx, onchange: undefined });
      body = h("div", { class: "uv-edit" }, ed.el, h("div", { class: "uv-edit-acts" },
        button({ label: "Save", kind: "primary", size: "sm", onclick: () => { const v = ed.get(); if (v === undefined) { st.editing = null; draw(); } else saveable({ [f.key]: v }); } }),
        button({ label: "Cancel", kind: "ghost", size: "sm", onclick: () => { st.editing = null; draw(); } })));
    } else {
      const shown = display(f.kind, valueFor(f), ctx);
      body = !ai && f.kind !== "sealed" && f.kind !== "link" && f.kind !== "file" ? h("div", { class: "uv-click", onclick: () => { st.editing = f.key; draw(); } }, shown) : shown;
    }
    const notSealedYet = f.kind !== "sealed" && !f.sealed;
    const end = ai ? null : iconButton({ icon: "more", label: `${f.label}, more`, size: 32, onclick: (/** @type {any} */ e) => {
      const items = [{ label: "Edit", onclick: () => { st.editing = f.key; draw(); } }];
      if (notSealedYet) items.push({ label: `Seal this field for all ${lc(def.plural)}`, onclick: () => sealAll(f) });
      menu({ anchor: e.currentTarget, items });
    } });
    return h("div", { class: "uv-f", "data-key": f.key },
      h("div", { class: "uv-fl" }, f.label, sealedField(f) ? chip("Sealed", { tone: "sealed", icon: "lock", title: `Sealed from AI, on every ${def.name}` }) : null,
        /** @type {any} */ (f).custom ? chip("New", { tone: "accent" }) : null),
      h("div", { class: "uv-fv" }, body), h("div", { class: "uv-fe" }, end));
  }

  async function sealAll(/** @type {FieldDef} */ f) {
    const pool = o.rows || [cur], n = pool.filter((/** @type {RecordRow} */ r) => !isEmpty(val(def, r, f.key))).length;
    const word = lc(def.plural);
    const ok = await confirm({ title: `Seal ${f.label} for all ${word}?`, action: "Seal",
      body: `${n} of ${pool.length} ${word} ${n === 1 ? "has a value" : "have a value"} for ${lc(f.label)}. Assistants will see "${f.label} on file, sealed" on each and will never get the value. You can still reveal it with Face ID.` });
    if (!ok) return;
    await (o.onsealtype ? o.onsealtype(f.key) : sealField(def, f.key));
    draw();
  }

  function addFieldSheet() {
    const sel = { name: "", kind: /** @type {FieldDef["kind"]} */ ("text") };
    openSheet({ title: `Add a field to ${def.plural}`, build: (body, close, parts) => {
      const preview = h("div", { class: "uv-two" });
      const kinds = h("div", { class: "uv-kinds", role: "group", "aria-label": "Kind" });
      const draftDef = () => /** @type {FieldDef} */ ({ key: "new", label: sel.name.trim() || "New field", kind: sel.kind, options: ["Option A", "Option B"], stages: ["Start", "Middle", "Done"], link: def.id });
      const drawPreview = () => {
        const f = draftDef(), c = { def: f, actors: o.actors || [], links: o.links || {}, who: /** @type {"person"} */ ("person"), now: o.now };
        const v = sampleFor(f, o);
        put(preview, h("div", { class: "uv-box" }, h("div", { class: "uv-box-l" }, "How it shows"), display(f.kind, v, c)), h("div", { class: "uv-box" }, h("div", { class: "uv-box-l" }, "How it is edited"), edit(f.kind, v, c).el));
        put(kinds, KINDS.map(([k, label]) => h("button", { type: "button", class: "uv-kind", "aria-pressed": String(k === sel.kind), onclick: () => { sel.kind = k; drawPreview(); } }, label)));
      };
      const nameIn = /** @type {HTMLInputElement} */ (h("input", { class: "ui-input", type: "text", placeholder: "Name, for example Preferred contact time", "aria-label": "Name" }));
      nameIn.addEventListener("input", () => { sel.name = nameIn.value; });
      nameIn.addEventListener("change", () => { sel.name = nameIn.value; drawPreview(); });
      add(body, h("p", { class: "uv-sheet-p" }, `Every ${lc(def.name)} gets it. The list, board, record page and the assistant's view pick it up with no new screen.`),
        h("div", { class: "uv-box-l" }, "Name"), nameIn, h("div", { class: "uv-box-l" }, "Kind"), kinds, preview);
      drawPreview();
      add(parts.actions, button({ label: `Add to ${def.plural}`, kind: "primary", onclick: async () => {
        sel.name = nameIn.value;
        if (!sel.name.trim()) { nameIn.focus(); return; }
        const spec = { label: sel.name.trim(), kind: sel.kind, ...(sel.kind === "link" ? { link: def.id } : {}) };
        await (o.onaddfield ? o.onaddfield(spec) : addField(def, spec));
        close(); draw();
      } }), button({ label: "Cancel", kind: "ghost", onclick: () => close() }));
    } });
  }

  const section = (/** @type {string} */ title, /** @type {any} */ sub, /** @type {any[]} */ kids) => card({ title, actions: sub ? h("span", { class: "uv-hint" }, sub) : null }, kids.length ? kids : null);

  function draw() {
    const sf = stageField(def);
    const ai = st.who === "assistant";
    const sealedNow = def.fields.filter(f => sealedField(f) && !isEmpty(val(def, cur, f.key)));
    const linked = [];
    for (const f of def.fields) if (f.kind === "link" && cur.values[f.key] && o.links?.[cur.values[f.key]]) linked.push({ id: cur.values[f.key], ...o.links[cur.values[f.key]] });
    for (const r of o.related || []) if (!linked.some(l => l.id === r.id)) linked.push(r);
    const files = [...(o.files || []), ...def.fields.filter(f => f.kind === "file" && cur.values[f.key]).map(f => cur.values[f.key])].filter((x, i, a) => a.indexOf(x) === i);
    const events = o.events || [];
    const bar = h("div", { class: "uv-bar" },
      segmented({ options: [["person", "You"], ["assistant", "Your assistant sees"]], value: st.who, label: "Who is looking", onchange: async v => {
        st.who = /** @type {any} */ (v); st.editing = null; seen = null;
        if (v === "assistant" && o.seesAs) seen = await o.seesAs(cur.id);
        draw();
      } }),
      h("span", { class: "uv-grow" }), ai ? null : button({ label: "Add a field", kind: "secondary", size: "sm", icon: "plus", onclick: addFieldSheet }));
    const note = ai ? banner({ tone: "warn", icon: "lock" }, h("b", null, "This is what an assistant sees."),
      h("div", { class: "uv-hint" }, sealedNow.length ? `${sealedNow.length} ${sealedNow.length === 1 ? "field is" : "fields are"} sealed, so it sees ${sealedNow.map(f => `"${f.label} on file, sealed"`).join(", ")} instead of the values.` : "Nothing on this record is sealed. A field menu can seal a field for every record of the type.")) : null;
    put(root,
      sf ? stageSteps({ stages: stagesOf(sf), current: String(val(def, cur, sf.key) ?? ""), onselect: ai ? undefined : (s) => { saveable({ [sf.key]: s }); } }) : null,
      o.doing ? h("p", { class: "uv-doing" }, h("span", { class: "uv-live", "aria-hidden": "true" }), o.doing) : null,
      bar, note,
      h("div", { class: "uv-rec-grid" },
        h("div", { class: "uv-main" }, card({ tone: "plain" }, def.fields.map(fieldRow)),
          card({ title: "Timeline", actions: h("span", { class: "uv-hint" }, "Every change, who and why") },
            events.length ? events.map((/** @type {any} */ e) => timelineItem({ actor: h("span", { class: "uv-actor" }, actorAv(o, e.actor, 20), h("span", null, nameOf(o, e.actor))), what: e.what, at: when(e.at), why: e.why })) : h("div", { class: "uv-hint uv-pad" }, "Nothing has happened yet."))),
        h("div", { class: "uv-side" },
          def.holdsWork ? section("Team", null, (o.team || []).map((/** @type {any} */ m) => h("div", { class: "uv-mem" }, actorAv(o, m.id, 32), h("div", { class: "uv-mem-t" }, h("b", null, nameOf(o, m.id)), h("span", { class: "uv-hint" }, m.doing || m.role || ""))))) : null,
          section("Linked records", null, linked.length ? linked.map(l => h("a", { class: "uv-rel", href: `/u/record/${encodeURIComponent(l.id)}`, onclick: (/** @type {Event} */ e) => { if (o.open) { e.preventDefault(); o.open(l.id); } } },
            l.type === "contact" ? tile(l.title) : null, h("span", { class: "uv-rel-t" }, h("b", null, l.title), h("span", { class: "uv-hint" }, l.type ? l.type[0].toUpperCase() + l.type.slice(1) : "")))) : [h("div", { class: "uv-hint uv-pad" }, "Nothing linked.")]),
          section("Chats", "About this record", (o.chats || []).length ? o.chats.map((/** @type {any} */ c) => h("div", { class: "uv-chat" }, h("span", { class: "uv-stack" }, (c.members || []).map((/** @type {string} */ id) => actorAv(o, id, 22))),
            h("span", { class: "uv-rel-t" }, h("b", null, c.title), h("span", { class: "uv-hint" }, (c.members || []).map((/** @type {string} */ id) => nameOf(o, id)).join(", "))), h("span", { class: "uv-hint" }, c.when || ""))) : [h("div", { class: "uv-hint uv-pad" }, `No chats yet. Type #${titleOf(def, cur)} in any chat to start one.`)]),
          section("Files", null, files.length ? files.map(n => h("div", { class: "uv-rel" }, icon("file", 18), h("span", { class: "uv-rel-t" }, h("b", null, String(n))))) : [h("div", { class: "uv-hint uv-pad" }, "No files.")]))),
      howMade(def, "record"));
  }
  root.setRow = (/** @type {RecordRow} */ r, /** @type {TypeDef} */ d) => { cur = r; if (d) def = d; seen = null; draw(); };
  root.redraw = draw;
  draw();
  return root;
}
