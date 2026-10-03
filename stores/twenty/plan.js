// @ts-check
// Kernel type definitions and values <-> Twenty metadata and rows. Pure, no network.
//
// Twenty has no stage rules, no sealed values and no polymorphic links, so those are kept as plain
// fields (a select, a JSON reference, text) and enforced by the gateway (spec 5.4). A reference to a
// record is the urn as text, never a Twenty relation, so any store can hold it and nothing depends on
// Twenty's joins. A sealed field holds the SealedRefValue the kernel gives it (reference and flags),
// never a value.

import { checkValue, isSealedRef } from "../../kernel/store/values.js";

export class PlanError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

export const camel = (/** @type {string} */ s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
export const pascal = (/** @type {string} */ s) => { const c = camel(s); return c[0].toUpperCase() + c.slice(1); };
export const optionValue = (/** @type {string} */ c) => c.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Names Twenty refuses and would rename with a "Custom" suffix (twenty-shared reserved-metadata-name-keywords, MIT). */
export const TWENTY_RESERVED = new Set(["approvedAccessDomain", "approvedAccessDomains", "appToken", "appTokens", "billingCustomer", "billingCustomers", "billingEntitlement", "billingEntitlements", "billingMeter", "billingMeters", "billingProduct", "billingProducts", "billingSubscription", "billingSubscriptions", "billingSubscriptionItem", "billingSubscriptionItems", "featureFlag", "featureFlags", "job", "jobs", "keyValuePair", "keyValuePairs", "pageLayout", "pageLayouts", "pageLayoutTab", "pageLayoutTabs", "pageLayoutWidget", "pageLayoutWidgets", "twoFactorMethod", "twoFactorMethods", "user", "users", "userWorkspace", "userWorkspaces", "role", "roles", "userWorkspaceRole", "userWorkspaceRoles", "plan", "plans", "event", "events", "field", "fields", "link", "links", "currency", "currencies", "fullNames", "address", "addresses", "type", "types", "object", "objects", "index", "relation", "relations", "aggregate", "connect", "create", "disconnect", "search", "searches"]);
const safe = (/** @type {string} */ n) => (TWENTY_RESERVED.has(n) ? n + "Custom" : n);
/** Standard Twenty objects and the system columns on every object: a Vyre type or field may not take them. */
const STANDARD_OBJECTS = new Set(["person", "people", "company", "companies", "opportunity", "opportunities", "task", "tasks", "note", "notes", "attachment", "attachments", "workspaceMember", "workspaceMembers", "dashboard", "dashboards", "workflow", "workflows", "workflowRun", "workflowRuns", "workflowVersion", "favorite", "favorites", "message", "messages", "calendarEvent", "calendarEvents", "timelineActivity", "blocklist", "connectedAccount"]);
const SYSTEM_FIELDS = new Set(["id", "name", "createdAt", "updatedAt", "deletedAt", "createdBy", "updatedBy", "position", "searchVector", "timelineActivities", "attachments", "favorites", "noteTargets", "taskTargets", "vyreVersion"]);

const COLORS = ["blue", "turquoise", "purple", "orange", "green", "gray", "red", "pink", "yellow", "sky"];
export const VERSION_FIELD = "vyreVersion";

/**
 * @typedef {{ vyre: string, kind: string, twenty: string, type: string, def: any, options?: { value: string, label: string, position: number, color: string }[],
 *   settings?: any, isTitle: boolean, sealed: boolean }} FieldPlan
 * @typedef {{ vyre: string, singular: string, plural: string, label: string, icon: string, def: any, fields: FieldPlan[],
 *   byVyre: Map<string, FieldPlan>, byTwenty: Map<string, FieldPlan>, title: string | null }} TypePlan
 */

/** @param {any} f @returns {{ type: string, settings?: any, options?: any[] }} */
function twentyKind(f) {
  const opts = () => (f.options ?? []).map((/** @type {string} */ o, /** @type {number} */ i) => ({ value: optionValue(o), label: o, position: i, color: COLORS[i % COLORS.length] }));
  switch (f.kind) {
    case "text": case "rich_text": case "link": case "ref": return { type: "TEXT" };
    case "number": return { type: "NUMBER", settings: { dataType: "float", decimals: 4, type: "number" } };
    case "money": return { type: "CURRENCY" };
    case "boolean": return { type: "BOOLEAN" };
    case "date": return { type: "DATE" };
    case "datetime": return { type: "DATE_TIME" };
    case "choice": case "stage": return { type: "SELECT", options: opts() };
    case "multi_choice": return { type: "MULTI_SELECT", options: opts() };
    case "rating": return { type: "RATING" };
    case "actor": case "file": case "address": case "phones": case "emails": case "urls": case "sealed": return { type: "RAW_JSON" };
    default: throw new PlanError("invalid", `Unknown field kind ${f.kind}`);
  }
}

/** @param {string} n */
function plural(n) { return /(s|x|z|ch|sh)$/.test(n) ? n + "es" : /[^aeiou]y$/.test(n) ? n.slice(0, -1) + "ies" : n + "s"; }

/** @param {any} def a kernel TypeDefinition @param {{ plural?: string }} [hint] @returns {TypePlan} */
export function planType(def, hint = {}) {
  if (!def || typeof def.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(def.name)) throw new PlanError("invalid", "A type name is lowercase letters, digits and underscores");
  const singular = safe(camel(def.name));
  const pl = safe(hint.plural ?? camel(plural(def.name)));
  if (STANDARD_OBJECTS.has(singular) || STANDARD_OBJECTS.has(pl)) throw new PlanError("invalid", `"${def.name}" is a name Twenty uses for a standard object`);
  if (singular === pl) throw new PlanError("invalid", `Type "${def.name}" needs a plural that differs from its name`);
  const title = def.fields.find((/** @type {any} */ f) => f.kind === "text")?.name ?? null;
  /** @type {FieldPlan[]} */ const fields = [];
  for (const f of def.fields) {
    const isTitle = f.name === title;
    const tw = isTitle ? "name" : safe(camel(f.name));
    if (!isTitle && SYSTEM_FIELDS.has(tw)) throw new PlanError("invalid", `Field "${f.name}" of ${def.name} collides with a name Twenty uses on every object`);
    const k = isTitle ? { type: "TEXT" } : twentyKind(f);
    if (k.options) { const vals = k.options.map((o) => o.value); if (new Set(vals).size !== vals.length || vals.some((v) => !v)) throw new PlanError("invalid", `The options of ${def.name}.${f.name} are not distinct once written as Twenty values`); }
    fields.push({ vyre: f.name, kind: f.kind, twenty: tw, type: k.type, def: f, options: k.options, settings: k.settings, isTitle, sealed: f.kind === "sealed" });
  }
  const byTwenty = new Map(fields.map((f) => [f.twenty, f]));
  if (byTwenty.size !== fields.length) throw new PlanError("invalid", `Two fields of ${def.name} map to the same Twenty name`);
  return { vyre: def.name, singular, plural: pl, label: def.label ?? def.name, icon: def.icon ?? "IconBox", def, fields, byVyre: new Map(fields.map((f) => [f.vyre, f])), byTwenty, title };
}

/** The selection set. @param {TypePlan} p */
export function selection(p) {
  return ["id", "createdAt", "updatedAt", "deletedAt", VERSION_FIELD, ...p.fields.map((f) => (f.type === "CURRENCY" ? `${f.twenty} { amountMicros currencyCode }` : f.twenty))].join(" ");
}

/**
 * Validate a whole data object against the definition, with the kernel's own validators so every store agrees on what is valid.
 * Returns an error string, "sealed_value_refused", or null. @param {TypePlan} p @param {Record<string, any>} data
 */
export function checkData(p, data) {
  for (const k of Object.keys(data)) if (!p.byVyre.has(k)) return { code: "unknown_field", message: `${p.vyre} has no field ${k}` };
  for (const f of p.fields) {
    const err = checkValue(f.def, data[f.vyre]);
    if (err === "sealed_value_refused") return { code: "sealed_value_refused", message: `${f.vyre} is sealed: a value is never stored, only a reference` };
    if (err) return { code: "invalid", message: err };
    const v = data[f.vyre];
    if (v !== null && v !== undefined) {
      if (f.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { code: "invalid", message: `${f.vyre} must be a date written YYYY-MM-DD` };
      if (f.kind === "sealed" && Object.keys(v).some((k) => !["sealed", "ref", "present", "valid_format", "set_at", "hint"].includes(k))) return { code: "sealed_value_refused", message: `${f.vyre} holds a reference only` };
    }
  }
  return null;
}

/** Kernel value -> Twenty value. @param {FieldPlan} f @param {any} v */
function toTwenty(f, v) {
  if (v === null || v === undefined) return null;
  switch (f.kind) {
    case "money": return { amountMicros: Math.round(v.amount * 1_000_000), currencyCode: v.currency };
    case "choice": case "stage": return optionValue(v);
    case "multi_choice": return v.map(optionValue);
    case "datetime": return new Date(v).toISOString();
    case "rating": return `RATING_${v}`;
    case "ref": return v.urn;
    default: return v;
  }
}
/** Twenty value -> kernel value, or undefined when absent. @param {FieldPlan} f @param {any} v */
function fromTwenty(f, v) {
  if (v === null || v === undefined || v === "") return undefined;
  switch (f.kind) {
    case "money": return v.amountMicros == null ? undefined : { amount: Number(v.amountMicros) / 1_000_000, currency: v.currencyCode };
    case "choice": case "stage": return f.def.options?.find((/** @type {string} */ o) => optionValue(o) === v);
    case "multi_choice": return Array.isArray(v) && v.length ? v.map((x) => f.def.options?.find((/** @type {string} */ o) => optionValue(o) === x)).filter((x) => x !== undefined) : undefined;
    case "rating": return Number(String(v).replace("RATING_", ""));
    case "ref": return { urn: v };
    case "number": return typeof v === "string" ? Number(v) : v;
    case "date": return String(v).slice(0, 10);
    case "datetime": return new Date(v).toISOString();
    case "phones": case "emails": case "urls": return Array.isArray(v) && v.length ? v : undefined;
    default: return v;
  }
}

/** @param {TypePlan} p @param {Record<string, any>} patch null clears a field @returns {Record<string, any>} */
export function toInput(p, patch) {
  /** @type {Record<string, any>} */ const out = {};
  for (const [k, v] of Object.entries(patch)) { const f = /** @type {FieldPlan} */ (p.byVyre.get(k)); out[f.twenty] = toTwenty(f, v); }
  return out;
}

/** A Twenty row -> the kernel's StoredRecord. @param {TypePlan} p @param {any} row */
export function fromRow(p, row) {
  /** @type {Record<string, any>} */ const data = {};
  for (const f of p.fields) { const v = fromTwenty(f, row[f.twenty]); if (v !== undefined) data[f.vyre] = v; }
  const rec = { type: p.vyre, id: row.id, version: row[VERSION_FIELD] == null ? 1 : Number(row[VERSION_FIELD]), data, created_at: Date.parse(row.createdAt), updated_at: Date.parse(row.updatedAt), ...(row.deletedAt ? { deleted_at: Date.parse(row.deletedAt) } : {}) };
  return /** @type {any} */ (rec);
}

const OP_SIMPLE = { eq: "eq", ne: "neq", lt: "lt", lte: "lte", gt: "gt", gte: "gte" };

/**
 * Kernel filter -> Twenty filter input (a JSON variable, so enum values need no quoting).
 * @param {TypePlan} p @param {any} f @returns {Record<string, any> | undefined}
 */
export function toFilter(p, f) {
  if (!f) return undefined;
  if (f.and) { const sub = f.and.map((/** @type {any} */ x) => toFilter(p, x)).filter(Boolean); return sub.length ? { and: sub } : undefined; }
  if (f.or) { const sub = f.or.map((/** @type {any} */ x) => toFilter(p, x)).filter(Boolean); return sub.length ? { or: sub } : undefined; }
  if (f.not) { const s = toFilter(p, f.not); return s ? { not: s } : undefined; }
  if (typeof f.field !== "string") throw new PlanError("invalid", "a filter names a field");
  if (f.field === "id") return { id: sys(f.op, f.value) };
  if (f.field === "created_at" || f.field === "updated_at") return { [f.field === "created_at" ? "createdAt" : "updatedAt"]: sys(f.op, typeof f.value === "number" ? new Date(f.value).toISOString() : f.value) };
  if (f.field === "version") return { [VERSION_FIELD]: sys(f.op, f.value) };
  const fp = p.byVyre.get(f.field);
  if (!fp) throw new PlanError("unknown_field", `${p.vyre} has no field ${f.field}`);
  if (fp.sealed) throw new PlanError("invalid", `${p.vyre}.${f.field} is sealed and cannot be filtered`);
  const t = fp.twenty;
  const one = (/** @type {any} */ x) => toTwenty(fp, x);
  if (f.op === "is_null") return fp.type === "CURRENCY" ? { [t]: { amountMicros: { is: "NULL" } } } : fp.type === "RAW_JSON" ? { [t]: { is: "NULL" } } : { [t]: { is: "NULL" } };
  if (f.op === "contains") {
    if (fp.type === "MULTI_SELECT") return { [t]: { containsAny: [one([f.value])[0]] } };
    if (fp.type === "TEXT") return { [t]: { ilike: `%${String(f.value).replace(/[%_\\]/g, "\\$&")}%` } };
    throw new PlanError("invalid", `contains works on text and multi_choice fields, not ${fp.kind}`);
  }
  if (f.op === "in") { if (!Array.isArray(f.value)) throw new PlanError("invalid", "in takes a list"); return fp.type === "CURRENCY" ? { [t]: { amountMicros: { in: f.value.map((/** @type {any} */ x) => Math.round(x.amount * 1e6)) } } } : { [t]: { in: f.value.map(one) } }; }
  if (!(f.op in OP_SIMPLE)) throw new PlanError("invalid", `Unknown operator ${f.op}`);
  const op = /** @type {any} */ (OP_SIMPLE)[f.op];
  if (fp.type === "CURRENCY") return { [t]: { amountMicros: { [op]: Math.round((typeof f.value === "object" && f.value ? f.value.amount : f.value) * 1e6) } } };
  if (fp.type === "RAW_JSON" || fp.type === "MULTI_SELECT") throw new PlanError("invalid", `${fp.kind} fields support contains and is_null only`);
  if (f.op === "ne" && (f.value === null || f.value === undefined)) return { [t]: { is: "NOT_NULL" } };
  if (f.op === "eq" && (f.value === null || f.value === undefined)) return { [t]: { is: "NULL" } };
  return { [t]: { [op]: one(f.value) } };
}
/** @param {string} op @param {any} v */
function sys(op, v) {
  if (op === "in") return { in: v };
  if (!(op in OP_SIMPLE)) throw new PlanError("invalid", `Unknown operator ${op}`);
  return { [/** @type {any} */ (OP_SIMPLE)[op]]: v };
}

/** @param {TypePlan} p @param {{ field: string, dir: "asc" | "desc" }[] | undefined} sort */
export function toOrderBy(p, sort) {
  /** @type {any[]} */ const out = [];
  for (const s of sort ?? []) {
    const dir = s.dir === "desc" ? "DescNullsLast" : "AscNullsFirst";
    if (s.field === "id") { out.push({ id: dir }); continue; }
    if (s.field === "created_at" || s.field === "updated_at") { out.push({ [s.field === "created_at" ? "createdAt" : "updatedAt"]: dir }); continue; }
    if (s.field === "version") { out.push({ [VERSION_FIELD]: dir }); continue; }
    const f = p.byVyre.get(s.field);
    if (!f) throw new PlanError("unknown_field", `${p.vyre} has no field ${s.field}`);
    if (f.sealed || f.type === "RAW_JSON" || f.type === "MULTI_SELECT") throw new PlanError("invalid", `${p.vyre}.${s.field} cannot be sorted`);
    out.push({ [f.twenty]: f.type === "CURRENCY" ? { amountMicros: dir } : dir });
  }
  if (!out.some((o) => "id" in o)) out.push({ id: "AscNullsFirst" });
  return out;
}
export { isSealedRef };
