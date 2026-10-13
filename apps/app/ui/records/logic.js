// @ts-check
import { fmtDate } from "../fields/logic.js";
// The pure half of the create form, the one timeline and the import wizard (Records).

/** @typedef {{ name: string, label: string, kind: string, required?: boolean, hidden?: boolean, unique?: boolean, options?: string[] }} F */

const blank = (/** @type {any} */ v) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

/** The fields a create form asks for: hidden ones left out, required ones first, the rest in the type's order. @param {F[]} fields */
export function formOrder(fields) {
  const shown = fields.filter((f) => !f.hidden && f.kind !== "stage" && !(/** @type {any} */ (f)).computed && !(/** @type {any} */ (f)).owned_by);
  return [...shown.filter((f) => f.required), ...shown.filter((f) => !f.required)];
}

/** What stops a save, by field name. A sealed value has its own step, so it is not judged here. @param {F[]} fields @param {Record<string, any>} values */
export function formErrors(fields, values) {
  /** @type {Record<string, string>} */ const out = {};
  for (const f of fields) {
    if (f.hidden || f.kind === "sealed") continue;
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

/** The link field of `type` that points at `target`: how a record of that type is tied to this one. @param {{ name: string, fields: any[] }[]} types @param {string} type @param {string} target */
export const viaOf = (types, type, target) => types.find((t) => t.name === type)?.fields.find((/** @type {any} */ f) => f.kind === "link" && f.to === target)?.name;

/** The values a new record starts with when it is made from another record's page. @param {{ fields: any[] }} def @param {string} via @param {string} urn */
export const prefillFromLink = (def, via, urn) => (via && urn && def.fields.some((/** @type {any} */ f) => f.name === via && f.kind === "link") ? { [via]: { urn } } : {});
