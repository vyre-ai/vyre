// @ts-check
// Customize (ui-primitives.md section 4.2): a space owns its types. Rename them, add fields, reorder stages, add a type from a template. Pure.

/** @typedef {{ key: string, label: string, kind: string, required?: boolean, rule?: string, sealed?: boolean, to?: string }} Field */
/** @typedef {{ id: string, label: string, plural: string, spaces: string[], work: boolean, kit?: string, icon?: string, fields: Field[], stages: string[], rules?: Record<string,string> }} TypeDef */

export const KINDS = [
  ["text", "Text"], ["number", "Number"], ["money", "Money"], ["date", "Date"], ["choice", "Choice"], ["stage", "Stage"], ["actor", "Person or assistant"],
  ["link", "Link"], ["file", "File"], ["address", "Address"], ["phone", "Phone"], ["email", "Email"], ["richtext", "Rich text"], ["rating", "Rating"], ["sealed", "Sealed"],
];
export const kindLabel = (/** @type {string} */ k) => KINDS.find((x) => x[0] === k)?.[1] ?? k;

export const TEMPLATES = [
  ["blank", "Blank"], ["order", "Order (a bakery)"], ["property", "Property"], ["deal", "Deal"],
];

/** @type {Record<string, { name: string, fields: Field[], stages: string[] }>} */
const TPL = {
  blank: { name: "Item", fields: [{ key: "title", label: "Title", kind: "text", required: true }], stages: [] },
  order: {
    name: "Order",
    fields: [{ key: "title", label: "Title", kind: "text", required: true }, { key: "customer", label: "Customer", kind: "link" }, { key: "total", label: "Total", kind: "money" }, { key: "due", label: "Due", kind: "date" }, { key: "stage", label: "Stage", kind: "stage" }],
    stages: ["New", "Baking", "Ready", "Picked up"],
  },
  property: {
    name: "Property",
    fields: [{ key: "title", label: "Address", kind: "address", required: true }, { key: "owner", label: "Owner", kind: "link" }, { key: "value", label: "Value", kind: "money" }, { key: "docs", label: "Deed", kind: "file" }],
    stages: [],
  },
  deal: {
    name: "Deal",
    fields: [{ key: "title", label: "Title", kind: "text", required: true }, { key: "contact", label: "Contact", kind: "link" }, { key: "value", label: "Value", kind: "money" }, { key: "close", label: "Close date", kind: "date" }, { key: "stage", label: "Stage", kind: "stage" }, { key: "owner", label: "Owner", kind: "actor" }],
    stages: ["Lead", "Meeting", "Proposal", "Won", "Lost"],
  },
};

export const templateName = (/** @type {string} */ id) => TPL[id]?.name ?? "Item";

/** "Order" > "Orders", "Property" > "Properties", "Case" > "Cases". Good enough for a default the person can change. */
export function pluralOf(/** @type {string} */ s) {
  const w = s.trim();
  if (!w) return w;
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + "ies";
  if (/(s|x|ch|sh)$/i.test(w)) return w + "es";
  return w + "s";
}

const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "type";

/** A new type from a template. A type that holds work gets a stage field if the template has stages. */
export function buildType(/** @type {string} */ tpl, /** @type {string} */ name, /** @type {boolean} */ work, /** @type {string} */ space, /** @type {string[]} */ taken = []) {
  const t = TPL[tpl] ?? TPL.blank;
  const label = name.trim() || t.name;
  let id = slug(label);
  for (let n = 2; taken.includes(id); n++) id = `${slug(label)}-${n}`;
  return /** @type {TypeDef} */ ({ id, label, plural: pluralOf(label), spaces: [space], work, fields: t.fields.map((f) => ({ ...f })), stages: [...t.stages] });
}

/** @returns {TypeDef} */
export function rename(/** @type {TypeDef} */ t, /** @type {string} */ label, /** @type {string} */ plural) {
  const l = label.trim() || t.label;
  return { ...t, label: l, plural: plural.trim() || pluralOf(l) };
}

/** "Call them Cases": the names change, the id and the Kit stay, so a Kit update keeps the names. */
export const callThemCases = (/** @type {TypeDef} */ t) => rename(t, "Case", "Cases");

/** @returns {TypeDef} */
export function addField(/** @type {TypeDef} */ t, /** @type {string} */ label, /** @type {string} */ kind, /** @type {string | undefined} */ to) {
  const base = slug(label);
  let key = base;
  for (let n = 2; t.fields.some((f) => f.key === key); n++) key = `${base}-${n}`;
  const fields = [...t.fields, { key, label: label.trim() || "New field", kind, sealed: kind === "sealed", ...(kind === "link" && to ? { to } : {}) }];
  return { ...t, fields };
}

/** @returns {TypeDef} */
export function sealField(/** @type {TypeDef} */ t, /** @type {string} */ key, /** @type {boolean} */ on) {
  return { ...t, fields: t.fields.map((f) => (f.key === key ? { ...f, sealed: on } : f)) };
}

/** Move a stage up (-1) or down (+1). Out of range is a no-op. */
export function moveStage(/** @type {string[]} */ stages, /** @type {number} */ i, /** @type {-1|1} */ dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || i >= stages.length || j >= stages.length) return stages;
  const out = [...stages];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Rename a stage; an empty or repeated name is refused (the old one stays). */
export function renameStage(/** @type {string[]} */ stages, /** @type {number} */ i, /** @type {string} */ name) {
  const n = name.trim();
  if (!n || stages.some((s, k) => k !== i && s.toLowerCase() === n.toLowerCase())) return stages;
  return stages.map((s, k) => (k === i ? n : s));
}

export function addStage(/** @type {string[]} */ stages) {
  let n = stages.length + 1;
  while (stages.includes(`Stage ${n}`)) n++;
  return [...stages, `Stage ${n}`];
}

/** The line under a field. */
export function fieldLine(/** @type {Field} */ f) {
  return [f.kind === "link" && f.to ? `Link to ${f.to}` : kindLabel(f.kind), f.required ? "required" : null, f.rule ?? null].filter(Boolean).join(" · ");
}

/** The line under a type in the list. */
export function typeLine(/** @type {TypeDef} */ t) {
  return `${t.fields.length} ${t.fields.length === 1 ? "field" : "fields"}${t.work ? " · holds work" : ""}${t.kit ? ` · from the Kit ${t.kit}` : ""}`;
}
