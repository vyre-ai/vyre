// @ts-check
// Vyre definitions and values <-> Twenty metadata and values. Pure functions, no network.
//
// Twenty has no stage rules, no sealed fields and no polymorphic person-or-assistant link, so those
// are stored as plain fields (a select, a placeholder text, a text "person:alex") and enforced by
// the gateway (spec 5.4). A link is stored as the target's id in a UUID field, not as a Twenty
// relation, so that any store can hold it and nothing depends on Twenty joins.

import { StoreError, SEALED_PLACEHOLDER } from "../contract.js";

export const camel = (/** @type {string} */ s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
export const snake = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
export const pascal = (/** @type {string} */ s) => { const c = camel(s); return c[0].toUpperCase() + c.slice(1); };
export const choiceValue = (/** @type {string} */ c) => c.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Names Twenty already uses on every object, and its standard objects: a Vyre type or field may not take them. */
export const RESERVED_FIELDS = new Set(["id", "name", "createdAt", "updatedAt", "deletedAt", "createdBy", "updatedBy", "position", "searchVector", "timelineActivities", "attachments", "favorites", "noteTargets", "taskTargets"]);
export const RESERVED_TYPES = new Set(["person", "people", "company", "companies", "opportunity", "opportunities", "task", "tasks", "note", "notes", "attachment", "attachments", "workspaceMember", "workspaceMembers", "dashboard", "dashboards", "workflow", "workflows", "workflowRun", "workflowVersion", "favorite", "favorites", "message", "messages", "calendarEvent", "calendarEvents", "timelineActivity", "blocklist", "connectedAccount"]);

/**
 * How one language field is held in Twenty.
 * @typedef {{ vyre: string, kind: string, twenty: string, type: string, settings?: any, options?: any[], sealed: boolean,
 *   nullable: true, required: boolean, isTitle: boolean, def: any }} FieldPlan
 * @typedef {{ vyre: string, singular: string, plural: string, label: string, plural_label: string, icon: string,
 *   title: string | null, fields: FieldPlan[], byVyre: Map<string, FieldPlan>, byTwenty: Map<string, FieldPlan>, stage: FieldPlan | null, def: any }} TypePlan
 */

const COLORS = ["blue", "turquoise", "purple", "orange", "green", "gray", "red", "pink", "yellow", "sky"];

/** @param {any} f @returns {{ type: string, settings?: any, options?: any[] }} */
function twentyKind(f) {
  switch (f.kind) {
    case "text": case "richtext": case "actor": return { type: "TEXT" };
    case "sealed": return { type: "TEXT" };
    case "number": return { type: "NUMBER", settings: f.integer ? { dataType: "int", decimals: 0, type: "number" } : { dataType: "float", decimals: 4, type: "number" } };
    case "money": return { type: "CURRENCY" };
    case "date": return { type: "DATE" };
    case "datetime": return { type: "DATE_TIME" };
    case "boolean": return { type: "BOOLEAN" };
    case "choice": return { type: "SELECT", options: f.options.map((/** @type {string} */ o, /** @type {number} */ i) => ({ value: choiceValue(o), label: o, position: i, color: COLORS[i % COLORS.length] })) };
    case "stage": return { type: "SELECT", options: f.stages.map((/** @type {any} */ s, /** @type {number} */ i) => ({ value: choiceValue(s.name), label: s.name, position: i, color: COLORS[i % COLORS.length] })) };
    case "person": return f.multiple ? { type: "ARRAY" } : { type: "TEXT" };
    case "link": return f.many ? { type: "ARRAY" } : { type: "UUID" };
    case "file": case "address": case "phones": case "emails": return { type: "RAW_JSON" };
    default: throw new StoreError("invalid", `Unknown field kind ${f.kind}`);
  }
}

/** @param {any} typeDef a stored type @returns {TypePlan} */
export function planType(typeDef) {
  const singular = camel(typeDef.name);
  const plural = typeDef.plural ? camel(typeDef.plural.toLowerCase().replace(/[^a-z0-9]+/g, "_")) : singular + "s";
  if (RESERVED_TYPES.has(singular) || RESERVED_TYPES.has(plural)) throw new StoreError("name_reserved", `"${typeDef.name}" is a name Twenty already uses for a standard object`, { name: typeDef.name });
  if (singular === plural) throw new StoreError("invalid", `Type "${typeDef.name}" needs a plural that differs from its name`);
  const title = typeDef.title ?? typeDef.fields.find((/** @type {any} */ f) => f.kind === "text")?.name ?? null;
  /** @type {FieldPlan[]} */ const fields = [];
  for (const f of typeDef.fields) {
    const isTitle = f.name === title;
    const tw = isTitle ? "name" : camel(f.name);
    if (!isTitle && RESERVED_FIELDS.has(tw)) throw new StoreError("name_reserved", `Field "${f.name}" of ${typeDef.name} collides with a name Twenty uses on every object`, { name: f.name });
    const k = isTitle ? { type: "TEXT" } : twentyKind(f);
    fields.push({ vyre: f.name, kind: f.kind, twenty: tw, type: k.type, settings: k.settings, options: k.options, sealed: f.kind === "sealed", nullable: true, required: !!f.required, isTitle, def: f });
  }
  const byVyre = new Map(fields.map((f) => [f.vyre, f]));
  const byTwenty = new Map(fields.map((f) => [f.twenty, f]));
  const twentyDupes = fields.length !== byTwenty.size;
  if (twentyDupes) throw new StoreError("invalid", `Two fields of ${typeDef.name} map to the same Twenty name`);
  return { vyre: typeDef.name, singular, plural, label: typeDef.label ?? typeDef.name, plural_label: typeDef.plural ?? (typeDef.label ?? typeDef.name) + "s", icon: typeDef.icon ?? "IconBox", title, fields, byVyre, byTwenty, stage: fields.find((f) => f.kind === "stage") ?? null, def: typeDef };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Language value -> Twenty value. @param {FieldPlan} f @param {any} v @param {string} typeName */
export function toTwentyValue(f, v, typeName) {
  const bad = (msg) => { throw new StoreError("invalid", `${typeName}.${f.vyre}: ${msg}`, { field: f.vyre }); };
  if (v === null || v === undefined) return null;
  switch (f.kind) {
    case "sealed": if (v !== SEALED_PLACEHOLDER) throw new StoreError("sealed_value", `${typeName}.${f.vyre} is sealed: a store only ever holds the placeholder`, { field: f.vyre }); return SEALED_PLACEHOLDER;
    case "text": case "richtext": if (typeof v !== "string") bad("expected text"); if (f.def.maxLength && v.length > f.def.maxLength) bad(`longer than ${f.def.maxLength}`); return v;
    case "actor": case "person": if (f.def.multiple) { if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) bad("expected a list of actors"); return v; } if (typeof v !== "string" || !/^(person|assistant|device):[a-z0-9._-]+$/.test(v)) bad('expected an actor such as "person:alex" or "assistant:juno"'); return v;
    case "number": if (typeof v !== "number" || !Number.isFinite(v)) bad("expected a number"); if (f.def.integer && !Number.isInteger(v)) bad("expected a whole number"); if (f.def.min !== undefined && v < f.def.min) bad(`below ${f.def.min}`); if (f.def.max !== undefined && v > f.def.max) bad(`above ${f.def.max}`); return v;
    case "money": { if (typeof v !== "object" || typeof v.amount !== "number" || !Number.isFinite(v.amount)) bad("expected { amount, currency }"); const cur = v.currency ?? f.def.currency ?? "USD"; if (!/^[A-Z]{3}$/.test(cur)) bad("bad currency"); return { amountMicros: Math.round(v.amount * 1_000_000), currencyCode: cur }; }
    case "date": if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) bad("expected YYYY-MM-DD"); return v;
    case "datetime": { const d = new Date(v); if (typeof v !== "string" || Number.isNaN(d.getTime())) bad("expected an ISO date and time"); return d.toISOString(); }
    case "boolean": if (typeof v !== "boolean") bad("expected true or false"); return v;
    case "choice": { if (!f.def.options.includes(v)) bad(`expected one of ${f.def.options.join(", ")}`); return choiceValue(v); }
    case "stage": { const names = f.def.stages.map((/** @type {any} */ s) => s.name); if (!names.includes(v)) bad(`expected one of ${names.join(", ")}`); return choiceValue(v); }
    case "link": if (f.def.many) { if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !UUID_RE.test(x))) bad("expected a list of ids"); return v; } if (typeof v !== "string" || !UUID_RE.test(v)) bad("expected an id"); return v;
    case "file": case "address": case "phones": case "emails": if (typeof v !== "object") bad("expected structured data"); return v;
    default: return bad(`unsupported kind ${f.kind}`);
  }
}

/** Twenty value -> language value. @param {FieldPlan} f @param {any} v */
export function fromTwentyValue(f, v) {
  if (v === null || v === undefined) return null;
  switch (f.kind) {
    case "money": return v.amountMicros == null ? null : { amount: Number(v.amountMicros) / 1_000_000, currency: v.currencyCode ?? f.def.currency ?? "USD" };
    case "choice": { const o = f.def.options.find((/** @type {string} */ x) => choiceValue(x) === v); return o ?? null; }
    case "stage": { const o = f.def.stages.find((/** @type {any} */ s) => choiceValue(s.name) === v); return o ? o.name : null; }
    case "datetime": return typeof v === "string" ? new Date(v).toISOString() : v;
    case "date": return typeof v === "string" ? v.slice(0, 10) : v;
    case "number": return typeof v === "string" ? Number(v) : v;
    case "sealed": return v === SEALED_PLACEHOLDER ? SEALED_PLACEHOLDER : null;
    default: return v;
  }
}

/** The selection set for a type. @param {TypePlan} plan */
export function selection(plan) {
  const sel = plan.fields.map((f) => (f.type === "CURRENCY" ? `${f.twenty} { amountMicros currencyCode }` : f.twenty));
  return ["id", "createdAt", "updatedAt", "deletedAt", ...sel].join(" ");
}

/** Twenty row -> { fields, ... } in Vyre form. @param {TypePlan} plan @param {any} row */
export function fromRow(plan, row) {
  /** @type {Record<string, any>} */ const fields = {};
  for (const f of plan.fields) fields[f.vyre] = fromTwentyValue(f, row[f.twenty]);
  return fields;
}

/** Language field values -> Twenty input. @param {TypePlan} plan @param {Record<string, any>} values @param {boolean} [applyDefaults] */
export function toInput(plan, values, applyDefaults = false) {
  /** @type {Record<string, any>} */ const out = {};
  for (const k of Object.keys(values)) {
    const f = plan.byVyre.get(k);
    if (!f) throw new StoreError("unknown_field", `${plan.vyre} has no field "${k}"`, { field: k });
    out[f.twenty] = toTwentyValue(f, values[k], plan.vyre);
  }
  if (applyDefaults) for (const f of plan.fields) {
    if (!(f.twenty in out) && f.def.default !== undefined) out[f.twenty] = toTwentyValue(f, f.def.default, plan.vyre);
    if (!(f.twenty in out) && f.kind === "stage") out[f.twenty] = choiceValue(f.def.stages[0].name);
  }
  return out;
}

/**
 * Our filter -> Twenty filter input (a JSON variable, so enum values need no quoting).
 * Operators: eq ne gt gte lt lte in contains isNull; combinators and, or, not.
 * @param {TypePlan} plan @param {Filter | undefined} filter @returns {Record<string, any> | undefined}
 */
export function toFilter(plan, filter) {
  if (!filter || !Object.keys(filter).length) return undefined;
  /** @type {Record<string, any>[]} */ const parts = [];
  for (const [k, cond] of Object.entries(filter)) {
    if (k === "and" || k === "or") { if (!Array.isArray(cond)) throw new StoreError("invalid", `${k} takes a list`); const sub = cond.map((c) => toFilter(plan, c)).filter(Boolean); if (sub.length) parts.push({ [k]: sub }); continue; }
    if (k === "not") { const sub = toFilter(plan, cond); if (sub) parts.push({ not: sub }); continue; }
    if (k === "id" || k === "createdAt" || k === "updatedAt") { parts.push({ [k]: sysCond(k, cond) }); continue; }
    const f = plan.byVyre.get(k);
    if (!f) throw new StoreError("unknown_field", `${plan.vyre} has no field "${k}"`, { field: k });
    if (f.sealed) throw new StoreError("invalid", `${plan.vyre}.${k} is sealed and cannot be filtered on`, { field: k });
    const c = cond !== null && typeof cond === "object" && !Array.isArray(cond) && !("amount" in cond) ? cond : { eq: cond };
    for (const [op, val] of Object.entries(c)) parts.push({ [f.twenty]: fieldCond(f, op, val, plan.vyre) });
  }
  return parts.length === 1 ? parts[0] : { and: parts };
}
/** @param {string} k @param {any} c */
function sysCond(k, c) {
  const map = { eq: "eq", ne: "neq", gt: "gt", gte: "gte", lt: "lt", lte: "lte", in: "in" };
  if (typeof c === "string") return { eq: c };
  const o = {};
  for (const [op, v] of Object.entries(c)) { if (!(op in map) || (k === "id" && !["eq", "ne", "in"].includes(op))) throw new StoreError("invalid", `${k} does not support ${op}`); o[map[op]] = v; }
  return o;
}
/** @param {any} c */ function idCond(c) { if (typeof c === "string") return { eq: c }; if (c && typeof c === "object") { const o = {}; for (const [op, v] of Object.entries(c)) { if (!["eq", "in", "ne"].includes(op)) throw new StoreError("invalid", `id supports eq, ne and in, not ${op}`); o[op === "ne" ? "neq" : op] = v; } return o; } throw new StoreError("invalid", "bad id condition"); }
/** @param {FieldPlan} f @param {string} op @param {any} val @param {string} tn */
function fieldCond(f, op, val, tn) {
  const one = (/** @type {any} */ x) => toTwentyValue(f, x, tn);
  if (op === "isNull") return { is: val ? "NULL" : "NOT_NULL" };
  const map = { eq: "eq", ne: "neq", gt: "gt", gte: "gte", lt: "lt", lte: "lte", in: "in", contains: "ilike" };
  if (!(op in map)) throw new StoreError("invalid", `Unknown operator ${op}`);
  if (f.type === "CURRENCY") { if (op === "in" || op === "contains") throw new StoreError("invalid", "money supports eq ne gt gte lt lte isNull"); return { amountMicros: { [map[op]]: Math.round((typeof val === "object" ? val.amount : val) * 1_000_000) } }; }
  if (op === "in") { if (!Array.isArray(val)) throw new StoreError("invalid", "in takes a list"); return { in: val.map(one) }; }
  if (op === "contains") { if (f.type !== "TEXT") throw new StoreError("invalid", `contains works on text fields, not ${f.kind}`); return { ilike: `%${String(val).replace(/[%_\\]/g, "\\$&")}%` }; }
  if (f.type === "ARRAY" || f.type === "RAW_JSON") throw new StoreError("invalid", `${f.kind} fields cannot be filtered yet`);
  return { [map[op]]: one(val) };
}

/** @param {TypePlan} plan @param {import("../contract.js").Sort[] | undefined} sort */
export function toOrderBy(plan, sort) {
  const list = (sort && sort.length ? sort : [{ field: "id", dir: "asc" }]);
  return list.map((s) => {
    const dir = s.dir === "desc" ? "DescNullsLast" : "AscNullsFirst";
    if (s.field === "id" || s.field === "createdAt" || s.field === "updatedAt") return { [s.field]: dir };
    const f = plan.byVyre.get(s.field);
    if (!f) throw new StoreError("unknown_field", `${plan.vyre} has no field "${s.field}"`, { field: s.field });
    if (f.sealed || f.type === "ARRAY" || f.type === "RAW_JSON") throw new StoreError("invalid", `${plan.vyre}.${s.field} cannot be sorted`);
    return { [f.twenty]: f.type === "CURRENCY" ? { amountMicros: dir } : dir };
  });
}
