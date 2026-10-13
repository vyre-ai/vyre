// @ts-check
// The pure half of the template composer: the {object.field} tokens in a message, the list a person inserts from, the preview and the text-message count.
// A token is stored as written ("Hello {client.first_name}") and read when the step runs; the engine's own half is kernel/flows/expr.js, not touched here.
import { flat } from "./tree.js";
import { isRecordTrigger } from "./logic.js";

/** @typedef {import("./logic.js").Draft} Draft */
/** @typedef {import("./logic.js").Options} Options */
/** @typedef {{ token: string, label: string, sealed?: boolean, known: boolean, alias: string, note?: string, address?: boolean, date?: boolean, dateKind?: string }} Item  `address`: the field holds an email address, so it suits To, From, CC and Reply-To */
/** @typedef {{ title: string, items: Item[], object?: string, soon?: Item[] }} Group  `object`: the object's own label, shown before a field in a chip */

/** `{path}`, and for a date `{path - 1 day}`, `{path + 2 hours as date}`: a path, then an optional offset and an optional format (the engine's own grammar, logic.js). The path is group 1, the rest group 2. */
export const TOKEN_RE = /\{([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*)((?: [+-] \d{1,4} (?:minutes?|hours?|days?|weeks?|months?))?(?: as (?:date|time|datetime|weekday|weekdaytime|iso))?)\}/gi;

/** The text as pieces: plain words and tokens. @param {string} text @returns {({ text: string } | { token: string, path: string })[]} */
export function parseTemplate(text) {
  const s = String(text ?? "");
  /** @type {any[]} */ const out = [];
  let at = 0;
  for (const m of s.matchAll(TOKEN_RE)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ token: m[0], path: m[1], suffix: m[2] });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** Just the tokens, in order. @param {string} text */
export const tokensOf = (text) => /** @type {{ token: string, path: string }[]} */ (parseTemplate(text).filter((p) => "token" in p));

/** Helper values a message can use, by token. `engine` is true only for those the Flow engine resolves today; the rest are listed and marked. */
export const HELPERS = /** @type {{ token: string, label: string, engine: boolean }[]} */ ([
  { token: "{today}", label: "Today's date", engine: true },
  { token: "{now}", label: "The date and time now", engine: true },
  { token: "{run.number}", label: "The run number", engine: false },
  { token: "{flow.name}", label: "The Flow's name", engine: false },
  { token: "{approver.name}", label: "The approver's name", engine: false },
  { token: "{space.name}", label: "The Space's name", engine: false },
  { token: "{me.name}", label: "Your name", engine: false },
]);

/** Sealed field names come as `sealed: true` on a field. @param {{ name: string, label: string, sealed?: boolean }} f */
const sealedOf = (f) => f.sealed === true;
/** Whether a field holds an email address: its type says so, or its name ends in email. @param {{ name: string, type?: string, kind?: string }} f */
const isAddress = (f) => (f.kind ?? f.type) === "email" || /(^|_)email$/i.test(f.name);

/**
 * What a box can insert, in the order a person looks for it: each object in this Flow's context with its fields (the record that started the Flow, then the records earlier steps made),
 * the earlier steps' outputs, then the helper values. `engineHas` lists the helper tokens the engine resolves; others are marked "Not available yet".
 * @param {Draft} d @param {string} stepId @param {Options} o @param {{ engineHas?: string[] }} [opt] @returns {Group[]}
 */
export function insertList(d, stepId, o, opt = {}) {
  /** @type {Group[]} */ const out = [];
  const t = d.trigger;
  /** @type {Record<string, number>} */ const used = {};
  // the name a person sees for an object: its own name, and name_2 for a second record of the same object
  const baseFor = (/** @type {string} */ n) => { used[n] = (used[n] || 0) + 1; return used[n] === 1 ? n : `${n}_${used[n]}`; };
  const fieldsOf = (/** @type {string} */ type) => o.types.find((x) => x.name === type)?.fields || [];
  const labelOf = (/** @type {string} */ type) => o.types.find((x) => x.name === type)?.label || type;
  const isLink = (/** @type {any} */ f) => (f.kind === "link" || f.kind === "ref") && typeof f.to === "string";
  /** The fields of an object as items, and through each link field the fields of the object it points to, up to three links deep: {after.spouse.name}. A link to several reads as its names joined by commas. */
  const fieldItems = (/** @type {string} */ type, /** @type {string} */ path, /** @type {string} */ words, /** @type {number} */ hops, /** @type {string} */ al) => {
    /** @type {Item[]} */ const rows = [];
    for (const f of /** @type {any[]} */ (fieldsOf(type))) {
      if (isLink(f)) {
        if (hops < 3 && rows.length < 300) rows.push(...fieldItems(f.to, `${path}.${f.name}`, `${words}${f.label} \u00b7 `, hops + 1, `${al}.${f.name}`).map((i) => (f.many ? { ...i, note: i.note ?? "Several: the names are joined with commas" } : i)));
      } else rows.push(item(`{${path}.${f.name}}`, `${words}${f.label}`, f, `{${al}.${f.name}}`));
    }
    return rows;
  };
  const item = (/** @type {string} */ token, /** @type {string} */ label, /** @type {any} */ f, /** @type {string} */ alias = token) => /** @type {Item} */ ({ token, label, alias, known: true, ...(f && sealedOf(f) ? { sealed: true, note: "Sent only where the step allows sealed values" } : {}), ...(f && isAddress(f) ? { address: true } : {}), ...(f && ((f.kind ?? f.type) === "date" || (f.kind ?? f.type) === "datetime") ? { date: true, dateKind: f.kind ?? f.type } : {}) });
  if (isRecordTrigger(t) && t.type) out.push({ object: labelOf(t.type), title: `${labelOf(t.type)} (the record that started the Flow)`, items: fieldItems(t.type, "after", "", 0, baseFor(t.type)) });
  else if (t.kind === "form" || t.kind === "signup") out.push({ title: "The form", items: ["name", "email", "phone", "message"].map((f) => item(`{${f}}`, `${f[0].toUpperCase()}${f.slice(1)}`, { name: f }, `{form.${f}}`)) });
  /** @type {Item[]} */ const steps = [];
  for (const s of flat(d.steps)) {
    if (s.id === stepId) break;
    if (s.kind === "create" || s.kind === "upsert") {
      const base = baseFor(s.type);
      out.push({ object: labelOf(s.type), title: `${labelOf(s.type)} made by ${s.id}`, items: [item(`{steps.${s.id}.record.id}`, "The record itself", null, `{${base}.id}`), ...fieldItems(s.type, `steps.${s.id}.record.data`, "", 0, base)] });
    }
    if (s.kind === "find") steps.push(item(`{steps.${s.id}.rows}`, `The records found by ${s.id}`, null, `{${s.id}.rows}`));
    if (s.kind === "formula") steps.push(item(`{steps.${s.id}.value}`, `The value worked out by ${s.id}`, null, `{${s.id}.value}`));
    if (s.kind === "classify") steps.push(item(`{steps.${s.id}.label}`, `The group picked by ${s.id}`, null, `{${s.id}.label}`));
  }
  if (steps.length) out.push({ title: "Earlier steps", items: steps });
  const has = new Set(opt.engineHas || []);
  const help = HELPERS.map((h) => ({ token: h.token, alias: h.token, label: h.label, known: h.engine || has.has(h.token), ...(h.engine || has.has(h.token) ? {} : { note: "Not available yet" }) }));
  // helpers the engine cannot read yet are kept apart, so the panel does not show a wall of rows that do nothing
  out.push({ title: "Helpful values", items: help.filter((h) => h.known), soon: help.filter((h) => !h.known) });
  return out;
}

/** The words for one token path, from the insert list. @param {string} path @param {Group[]} groups */
export function tokenLabel(path, groups) {
  const tok = `{${path}}`;
  for (const g of groups) { const it = [...g.items, ...(g.soon || [])].find((x) => x.token === tok); if (it) return g.object ? `${g.object} \u00b7 ${it.label}` : it.label; }
  return path;
}

/** Whether a token is on the insert list and can be resolved. @param {string} path @param {Group[]} groups */
export const tokenKnown = (path, groups) => groups.some((g) => g.items.some((x) => x.token === `{${path}}` && x.known));

/** Tokens in the text that nothing on the list explains, so the person sees a mistake before it runs. @param {string} text @param {Group[]} groups */
export const unknownTokens = (text, groups) => tokensOf(text).filter((t) => !tokenKnown(t.path, groups)).map((t) => t.token);

/** The text with every token swapped for a sample value; one with no sample shows its label in brackets. @param {string} text @param {Record<string, string>} sample @param {Group[]} groups */
export function renderPreview(text, sample, groups = []) {
  return parseTemplate(text).map((p) => ("token" in p ? (p.path in sample ? String(sample[p.path]) : `[${tokenLabel(p.path, groups)}${p.suffix ? `,${p.suffix}` : ""}]`) : p.text)).join("");
}

/** When the text ends inside an open brace ("Hello {cl"), the part typed after it; otherwise null. This is what opens the autocomplete. @param {string} text @returns {string | null} */
export function openBrace(text) {
  const s = String(text ?? "");
  const i = s.lastIndexOf("{");
  if (i < 0 || s.indexOf("}", i) >= 0) return null;
  const q = s.slice(i + 1);
  return /^[a-z0-9_.]*$/i.test(q) ? q : null;
}

/** The text with the open brace finished as the chosen token. @param {string} text @param {string} token */
export function completeBrace(text, token) {
  const s = String(text ?? "");
  const i = s.lastIndexOf("{");
  return i < 0 || s.indexOf("}", i) >= 0 ? `${s}${token}` : `${s.slice(0, i)}${token}`;
}

/** What matches a typed start, over the whole list. @param {Group[]} groups @param {string} q */
export function suggest(groups, q) {
  const n = q.toLowerCase();
  return groups.flatMap((g) => g.items).filter((i) => !n || i.alias.toLowerCase().includes(n) || i.label.toLowerCase().includes(n)).slice(0, 5);
}

/** Add a token where the text ends, with a space before it when one is needed. @param {string} text @param {string} token */
export const appendToken = (text, token) => `${text}${text && !/\s$/.test(text) ? " " : ""}${token}`;

/** Characters and how many text-message segments they make (160 for plain text, 70 for any other character; longer ones are split into 153 and 67). @param {string} text */
export function smsCount(text) {
  const s = String(text ?? "");
  const chars = [...s].length;
  const plain = /^[\x20-\x7e\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ\u00a7¿äöñüà]*$/.test(s);
  const one = plain ? 160 : 70, many = plain ? 153 : 67;
  return { chars, segments: chars === 0 ? 0 : chars <= one ? 1 : Math.ceil(chars / many), unicode: !plain };
}

/** A small history for Undo: push each change, step back with undo. @param {string} first */
export function history(first) {
  /** @type {string[]} */ const past = [];
  let now = first;
  return {
    get value() { return now; },
    get canUndo() { return past.length > 0; },
    push(/** @type {string} */ v) { if (v === now) return now; past.push(now); if (past.length > 100) past.shift(); now = v; return now; },
    undo() { if (past.length) now = /** @type {string} */ (past.pop()); return now; },
  };
}

/** Addresses a To, From, CC or Reply-To box can offer first: every email-type field of the objects in context, by its own label and object. @param {Group[]} groups @returns {Item[]} */
export const addressPicks = (groups) => groups.flatMap((g) => g.items.filter((i) => i.address).map((i) => ({ ...i, label: `${i.label} (${g.title.replace(/ \(the record that started the Flow\)$/, "")})` })));

/** The date fields in context, for "Insert a date": a field typed date or datetime, or one whose name says so, plus Today and Now. `dateKind` is the field's own type; the engine formats a date or datetime field by it. @param {Group[]} groups @returns {Item[]} */
export function dateRefs(groups) {
  const like = (/** @type {string} */ t) => /(^|[._])(date|time|start|end|starts|ends|due|[a-z]+_at|[a-z]+_on|[a-z]+_date)$/i.test(t.replace(/\}$/, ""));
  const found = groups.filter((g) => g.title !== "Helpful values").flatMap((g) => g.items.filter((i) => i.date || like(i.token)).map((i) => ({ ...i, label: g.object ? `${g.object} \u00b7 ${i.label}` : i.label })));
  return [...found, { token: "{today}", alias: "{today}", label: "Today", known: true, date: true, dateKind: "date" }, { token: "{now}", alias: "{now}", label: "Now", known: true, date: true, dateKind: "datetime" }];
}

export const DATE_DIRS = /** @type {[string, string][]} */ ([["before", "before"], ["at", "at"], ["after", "after"]]);
export const DATE_UNITS = /** @type {[string, string][]} */ ([["minutes", "minutes"], ["hours", "hours"], ["days", "days"], ["weeks", "weeks"], ["months", "months"]]);
/** The formats the engine prints a time in, and how a person says them. The first, "", lets the field's own type decide. */
export const DATE_FORMATS = /** @type {[string, string][]} */ ([["", "As the field is set"], ["date", "date"], ["time", "time"], ["datetime", "date and time"], ["weekday", "weekday and date"], ["weekdaytime", "weekday, date and time"], ["iso", "ISO (2026-10-14T14:00)"]]);

/** How the engine shows a date: a date as "Tue 14 Oct" (weekday and date), a datetime as "Tue 14 Oct, 2:00 pm", both in the Space's time zone; any other field as plain text. @param {string} [kind] */
export const dateFormatWords = (kind) => (kind === "datetime" ? "date and time" : kind === "date" ? "weekday and date" : "text");

/**
 * One inserted date as a spec: { ref (a token), refLabel, kind (the field's type), dir, amount, unit }. `dateWords` reads it back ("Appointment \u00b7 Start, minus 1 day, as weekday and date") and `dateToken` is
 * what goes into the text. The engine formats a date or datetime field by its type, so the format is not a choice; an offset has no engine function yet, so `datePending` says so.
 * @param {{ ref: string, refLabel: string, kind?: string, dir: string, amount: number, unit: string, format?: string }} d
 */
export function dateWords(d) {
  const unit = d.amount === 1 ? d.unit.replace(/s$/, "") : d.unit;
  const shift = d.dir === "at" || !d.amount ? "" : `, ${d.dir === "before" ? "minus" : "plus"} ${d.amount} ${unit}`;
  const named = DATE_FORMATS.find((f) => f[0] && f[0] === d.format);
  return `${d.refLabel}${shift}, as ${named ? named[1] : dateFormatWords(d.kind)}`;
}
/** The token to put in the text: `{after.starts_at - 1 day as date}`. The offset is left out for "at" or an amount of 0, the format when the field's own type decides. @param {{ ref: string, dir: string, amount: number, unit: string, format?: string }} d */
export function dateToken(d) {
  if (!d.ref) return "";
  const unit = d.amount === 1 ? d.unit.replace(/s$/, "") : d.unit;
  const shift = d.dir === "at" || !d.amount ? "" : ` ${d.dir === "before" ? "-" : "+"} ${d.amount} ${unit}`;
  return `${d.ref.slice(0, -1)}${shift}${d.format ? ` as ${d.format}` : ""}}`;
}
/** The other way: a date token read back into its choices, or null when it is not one. @param {string} token */
export function parseDateToken(token) {
  TOKEN_RE.lastIndex = 0;
  const m = new RegExp(TOKEN_RE.source, "i").exec(token);
  if (!m || m[0] !== token) return null;
  const off = /^ ([+-]) (\d+) (\w+?)s?(?= as |$)/.exec(m[2]);
  const fmt = /as (\w+)$/.exec(m[2]);
  return { ref: `{${m[1]}}`, dir: off ? (off[1] === "-" ? "before" : "after") : "at", amount: off ? Number(off[2]) : 1, unit: off ? `${off[3]}s` : "days", format: fmt ? fmt[1] : "" };
}
/** What the engine does not do yet for this date, in words, or null. @param {{ ref: string, kind?: string, dir: string, amount: number }} d @param {{ engineDates?: boolean }} [o] */
export function datePending(d, o = {}) {
  if (d.ref && !d.kind) return "This field is not a date type, so it is inserted as plain text. Set its type to date in Records to format it.";
  return null;
}

/** The friendly names a person reads and types, and the engine paths they stand for, from the insert list: [{ alias: "{client.name}", path: "{after.name}" }]. A helper is its own alias. @param {Group[]} groups */
export const aliasTable = (groups) => groups.flatMap((g) => [...g.items, ...(g.soon || [])].map((i) => ({ alias: i.alias, path: i.token })));

/** A text with its engine paths shown as friendly names. A token not on the list stays as written. @param {string} text @param {{ alias: string, path: string }[]} table */
export function toAliasText(text, table) {
  const m = new Map(table.map((r) => [r.path, r.alias]));
  return String(text ?? "").replace(TOKEN_RE, (all, p, suf) => { const a = m.get(`{${p}}`); return a ? `${a.slice(0, -1)}${suf}}` : all; });
}
/** The other way, on save: friendly names back to engine paths. @param {string} text @param {{ alias: string, path: string }[]} table */
export function toPathText(text, table) {
  const m = new Map(table.map((r) => [r.alias, r.path]));
  return String(text ?? "").replace(TOKEN_RE, (all, p, suf) => { const a = m.get(`{${p}}`); return a ? `${a.slice(0, -1)}${suf}}` : all; });
}
