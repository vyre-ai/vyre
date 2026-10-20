// @ts-check
import { fmtDate } from "../fields/logic.js";
import { isKeptField } from "./record-id.js";
// The pure half of the create form, the one timeline and the import wizard (Records).

/** @typedef {{ name: string, label: string, kind: string, required?: boolean, hidden?: boolean, unique?: boolean, options?: string[] }} F */

const blank = (/** @type {any} */ v) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

/** A type's own bookkeeping fields, kept by the service that owns the type: nobody's to read or fill. The task's are the planner's (records/core-types.js). */
const BOOKKEEPING = /** @type {Record<string, Set<string>>} */ ({ task: new Set(["planner", "wall", "floating", "source"]) });

/**
 * A field that is the system's own, not a person's: removed from view (hidden), the fast-field bag (`extra`, JSON text), hidden from every role down to the owner (hidden_from, as the task's planner bookkeeping is), or a type's own bookkeeping. A field hidden from some roles only is
 * still a field for the rest. The record page
 * shows none of them and the create form asks for none. @param {any} f @param {string} [type]
 */
export const isInternalField = (f, type) => f.hidden === true || (f.name === "extra" && f.kind === "text") || (Array.isArray(f.hidden_from) && f.hidden_from.includes("owner")) || !!(type && BOOKKEEPING[type]?.has(f.name));

/** A field only the system writes: owned by the kernel (a task's status), computed, or read-only (an ID). The record page shows it and never offers to change it; the create form never asks for it. @param {any} f */
export const isLockedField = (f) => !!(f.owned_by || f.computed || f.read_only || isKeptField(f));

/** The fields of a type a person reads and fills: every field but the internal ones. The record page and the create form both start from this. @param {{ name: string, fields: any[] }} def */
export const personFields = (def) => (def.fields || []).filter((f) => !isInternalField(f, def.name));

/** The fields a create form asks for: internal and locked ones left out, required ones first, the rest in the type's order. @param {F[]} fields */
export function formOrder(fields) {
  const shown = fields.filter((f) => !isInternalField(f) && !isLockedField(f) && f.kind !== "stage");
  return [...shown.filter((f) => f.required), ...shown.filter((f) => !f.required)];
}

/** What stops a save, by field name: only the fields the form asks for (formOrder), so a field the kernel fills (a task's status) never blocks it. A sealed value has its own step, so it is not judged here. @param {F[]} fields @param {Record<string, any>} values */
export function formErrors(fields, values) {
  /** @type {Record<string, string>} */ const out = {};
  for (const f of formOrder(fields)) {
    if (f.kind === "sealed") continue;
    const v = values[f.name];
    if (f.required && blank(v)) out[f.name] = `${f.label} is required.`;
    else if (f.kind === "choice" && f.options?.length && !blank(v) && !f.options.includes(v)) out[f.name] = `${f.label} must be one of the options.`;
  }
  return out;
}

export const TIMELINE_KINDS = /** @type {[string, string][]} */ ([["all", "All"], ["note", "Notes"], ["email", "Emails"], ["call", "Calls"], ["change", "Changes"]]);

/** The one timeline of a record: newest first, narrowed to one kind or all. @template {{ kind: string, at: number }} T @param {T[]} items @param {string} kind */
export const timelineOf = (items, kind) => items.filter((i) => kind === "all" || i.kind === kind).sort((a, b) => b.at - a.at);

const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A header to a field name, "" for none. Same name first, then a header that holds a field's name ("Full name" holds "name"); a field is taken once. @param {string[]} headers @param {{ name: string, label: string }[]} fields */
export function guessMapping(headers, fields) {
  /** @type {Record<string, string>} */ const out = {};
  const taken = new Set();
  for (const h of headers) out[h] = "";
  for (const pass of ["exact", "holds"]) {
    for (const h of headers) {
      if (out[h]) continue;
      const n = norm(h);
      const f = fields.find((x) => !taken.has(x.name) && [norm(x.label), norm(x.name)].some((m) => (pass === "exact" ? m === n : n.length >= 4 && m.length >= 4 && (n.includes(m) || m.includes(n)))));
      if (f) { out[h] = f.name; taken.add(f.name); }
    }
  }
  return out;
}

/** What a row would be refused for: an empty required value, a repeat in a unique field, a value that is not a number or a date. @param {Record<string, string>[]} rows @param {Record<string, string>} mapping @param {F[]} fields */
export function importIssues(rows, mapping, fields) {
  /** @type {{ row: number, field: string, problem: string }[]} */ const out = [];
  const byField = Object.entries(mapping).filter(([, f]) => f);
  /** @type {Record<string, Set<string>>} */ const seen = {};
  rows.forEach((r, i) => {
    for (const f of fields) {
      const col = byField.find(([, n]) => n === f.name)?.[0];
      if (!col) continue;
      const v = (r[col] ?? "").trim();
      if (!v) { if (f.required) out.push({ row: i + 1, field: f.name, problem: "empty" }); continue; }
      if (f.unique) { const s = (seen[f.name] ??= new Set()); if (s.has(v.toLowerCase())) { out.push({ row: i + 1, field: f.name, problem: "duplicate" }); continue; } s.add(v.toLowerCase()); }
      if ((f.kind === "number" || f.kind === "money") && Number.isNaN(Number(v.replace(/[$,\s]/g, "")))) out.push({ row: i + 1, field: f.name, problem: "not a number" });
      if ((f.kind === "date" || f.kind === "datetime") && Number.isNaN(Date.parse(v))) out.push({ row: i + 1, field: f.name, problem: "not a date" });
      if (f.kind === "choice" && f.options?.length && !f.options.some((/** @type {string} */ o) => o.toLowerCase() === v.toLowerCase())) out.push({ row: i + 1, field: f.name, problem: "not one of the options" });
    }
  });
  return out;
}

/** The line above the preview. @param {number} total @param {{ row: number }[]} issues @param {Record<string, string>} mapping */
export function importSummary(total, issues, mapping) {
  const flagged = new Set(issues.map((i) => i.row)).size;
  return { total, ready: total - flagged, flagged, unmapped: Object.values(mapping).filter((v) => !v).length };
}

/** What a create sends: plain values to the record, sealed values (kind sealed, or a field with a seal) held back to be put one by one after it exists. Empty values are left out; text is trimmed. @param {(F & { seal?: unknown })[]} fields @param {Record<string, any>} values */
export function createPayload(fields, values) {
  /** @type {Record<string, any>} */ const plain = {}, /** @type {Record<string, any>} */ sealed = {};
  for (const f of formOrder(fields)) {
    let v = values[f.name];
    if (blank(v)) continue;
    if (typeof v === "string") v = v.trim();
    if (f.kind === "sealed" || /** @type {any} */ (f).seal) sealed[f.name] = v; else plain[f.name] = v;
  }
  return { plain, sealed };
}

/**
 * A new task as tasks.request takes it: the person who makes it does it, it is about the record it was started from, and the task's own words (title, note, due, part of, project) are the task's; every other value
 * is a custom field of the Task record. The kernel writes the status. @param {Record<string, any>} plain createPayload's plain values @param {{ doer: string, about?: string }} o
 */
export function taskRequestOf(plain, o) {
  const { title, note, due, parent, project, ...rest } = plain;
  const urnOf = (/** @type {any} */ v) => (v && typeof v === "object" ? v.urn : typeof v === "string" ? v : undefined);
  const ms = typeof due === "number" ? due : due ? Date.parse(String(due)) : NaN;
  const parentUrn = urnOf(parent), projectUrn = urnOf(project);
  return {
    title: String(title ?? "").trim(), doer: o.doer, output: { kind: "note" }, source: "manual",
    ...(o.about ? { record: o.about } : {}), ...(Number.isFinite(ms) ? { due: ms } : {}), ...(note ? { note: String(note) } : {}),
    ...(parentUrn ? { parent: String(parentUrn).split("/").pop() } : {}), ...(projectUrn ? { project: projectUrn } : {}), ...(Object.keys(rest).length ? { fields: rest } : {}),
  };
}

/** The related records of a page by type, in the order each type first appears. @param {{ urn: string, title: string, type: string }[]} related @param {Record<string, { label: string, plural: string }>} types */
export function groupRelated(related, types) {
  /** @type {{ type: string, label: string, plural: string, rows: { urn: string, title: string, type: string }[] }[]} */ const out = [];
  for (const r of related) {
    let g = out.find((x) => x.type === r.type);
    if (!g) { const t = types[r.type]; g = { type: r.type, label: t?.label ?? r.type, plural: t?.plural ?? `${r.type}s`, rows: [] }; out.push(g); }
    g.rows.push(r);
  }
  return out;
}

/** Up to three facts for under a record's name, from its plain filled fields (never the first text field, which is the name, a stage, a sealed or hidden one). @param {{ fields: any[] }} def @param {{ data?: Record<string, any> }} rec @returns {[string, string][]} */
export function factsOf(def, rec) {
  const first = def.fields.find((f) => f.kind === "text");
  /** @type {[string, string][]} */ const out = [];
  for (const f of def.fields) {
    if (out.length === 3) break;
    if (f === first || f.hidden || f.seal || !["text", "choice", "number", "money", "date"].includes(f.kind)) continue;
    const v = rec.data?.[f.name];
    if (blank(v)) continue;
    const s = f.kind === "money" ? `$${Number(v.amount).toLocaleString("en-US")}` : f.kind === "date" || f.kind === "datetime" ? fmtDate(v) : String(v);
    out.push([f.label, s]);
  }
  return out;
}

/**
 * The fields a person pinned under a record's name (the layout's header_fields), in their order, up to eight: a label and the value as it reads, or null when the field is empty so the page can offer to fill it.
 * A field that is not there, hidden or sealed is left out. @param {{ fields: any[] }} def @param {{ data?: Record<string, any> }} rec @param {string[]} names @returns {[string, string | null][]}
 */
export function pinnedFacts(def, rec, names) {
  /** @type {[string, string | null][]} */ const out = [];
  for (const n of (Array.isArray(names) ? names : []).slice(0, 8)) {
    const f = def.fields.find((x) => x.name === n);
    if (!f || f.hidden || f.seal || f.kind === "sealed") continue;
    const v = rec.data?.[n];
    if (blank(v)) { out.push([f.label, null]); continue; }
    const s = f.kind === "money" ? `$${Number(v.amount ?? v).toLocaleString("en-US")}` : f.kind === "date" || f.kind === "datetime" ? fmtDate(v) : typeof v === "object" ? String(v.name ?? v.title ?? v.urn ?? "") : String(v);
    out.push([f.label, s]);
  }
  return out;
}

/** The link field of `type` that points at `target`: how a record of that type is tied to this one. @param {{ name: string, fields: any[] }[]} types @param {string} type @param {string} target */
export const viaOf = (types, type, target) => types.find((t) => t.name === type)?.fields.find((/** @type {any} */ f) => f.kind === "link" && f.to === target)?.name;

/** The values a new record starts with when it is made from another record's page. @param {{ fields: any[] }} def @param {string} via @param {string} urn */
export const prefillFromLink = (def, via, urn) => (via && urn && def.fields.some((/** @type {any} */ f) => f.name === via && f.kind === "link") ? { [via]: { urn } } : {});
