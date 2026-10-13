// @ts-check
// The pure half of the setup screens (Records: a type, its fields, choices, relations, who sees a field). A draft is what a person is editing; toDefinition is the kernel's FieldDefinition it becomes.

/** @typedef {{ name?: string, label: string, kind: string, description: string, required: boolean, unique: boolean, hidden: boolean, sealed: boolean, options: string[], to: string | null, many: boolean, inverse: string, hidden_from: string[], visible_if: string, required_if: string }} Draft */
/** @typedef {{ name: string, label: string, plural: string }} TypeRef */

export const UNIQUE_KINDS = ["text", "number", "url", "choice", "date", "datetime"];
export const CHOICE_KINDS = ["choice", "multi_choice", "stage"];

/** @param {string} kind @returns {Draft} */
export const newDraft = (kind = "text") => ({ label: "", kind, description: "", required: false, unique: false, hidden: false, sealed: false, options: [], to: null, many: false, inverse: "", hidden_from: [], visible_if: "", required_if: "" });

/** The stored name from a label: lower case, words joined by underscores. @param {string} label */
export const nameOf = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";

/** @param {string} kind */
export const canBeUnique = (kind) => UNIQUE_KINDS.includes(kind);

const same = (/** @type {string} */ a, /** @type {string} */ b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What is wrong with a draft, by the control it belongs to. @param {Draft} d @param {{ name: string, label: string }[]} siblings @param {TypeRef[]} types */
export function checkField(d, siblings, types) {
  /** @type {Record<string, string>} */ const errors = {};
  if (!d.label.trim()) errors.label = "Give the field a name.";
  else if (siblings.some((s) => s.name === (d.name || nameOf(d.label)) && s.name !== d.name)) errors.label = "A field with that name already exists.";
  if (CHOICE_KINDS.includes(d.kind) && d.kind !== "stage") {
    if (!d.options.length) errors.options = "Add at least one option.";
    else if (d.options.some((o) => !o.trim())) errors.options = "An option is empty.";
    else if (d.options.some((o, i) => d.options.findIndex((p) => same(p, o)) !== i)) errors.options = "An option appears twice.";
  }
  if (d.kind === "link" && !types.some((t) => t.name === d.to)) errors.to = "Pick the type this field links to.";
  if (d.unique && !canBeUnique(d.kind)) errors.unique = "This kind of field cannot be unique.";
  if (d.required && d.hidden) errors.hidden = "A required field cannot be hidden.";
  if (d.required && d.required_if) errors.required_if = "Use either required or required when, not both.";
  return { ok: Object.keys(errors).length === 0, errors };
}

/** @param {string[]} opts @param {string} text */
export const addChoice = (opts, text) => (!text.trim() || opts.some((o) => same(o, text)) ? opts : [...opts, text.trim()]);
/** @param {string[]} opts @param {number} i @param {number} dir */
export function moveChoice(opts, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= opts.length) return opts;
  const n = [...opts];
  [n[i], n[j]] = [n[j], n[i]];
  return n;
}
/** @param {string[]} opts @param {number} i */
export const removeChoice = (opts, i) => opts.filter((_, k) => k !== i);

/** The name the other type shows by default: the owner's plural. @param {{ plural: string }} owner */
export const inverseDefault = (owner) => owner.plural;

/** A relation read from both sides, in two sentences. @param {{ label: string, plural: string }} owner @param {{ label: string, plural: string }} target @param {boolean} many @param {string} inverse */
export function relationLines(owner, target, many, inverse) {
  const a = many ? `Each ${owner.label} can link to many ${target.plural}.` : `Each ${owner.label} belongs to one ${target.label}.`;
  const b = !inverse.trim()
    ? `The ${target.label} does not show its ${owner.plural}.`
    : many ? `A ${target.label} can be on many ${owner.plural}, shown as ${inverse.trim()} on the ${target.label}.` : `A ${target.label} can have many ${owner.plural}, shown as ${inverse.trim()} on the ${target.label}.`;
  return [a, b];
}

/** @param {string[]} hiddenFrom @param {string} role */
export const toggleRole = (hiddenFrom, role) => (hiddenFrom.includes(role) ? hiddenFrom.filter((r) => r !== role) : [...hiddenFrom, role]);
/** @param {{ hidden?: boolean, hidden_from?: string[] }} f @param {string} role */
export const seesField = (f, role) => !f.hidden && !(f.hidden_from ?? []).includes(role);

/** The stored FieldDefinition (kernel/contracts/fields.d.ts): what is off or empty is left out. @param {Draft} d */
export function toDefinition(d) {
  /** @type {Record<string, any>} */
  const o = { name: d.name || nameOf(d.label), kind: d.sealed ? "sealed" : d.kind, label: d.label.trim() };
  if (d.sealed) { if (d.description.trim()) o.description = d.description.trim(); if (d.required) o.required = true; if (d.hidden_from.length) o.hidden_from = [...d.hidden_from]; return o; }
  if (d.description.trim()) o.description = d.description.trim();
  if (d.required) o.required = true;
  if (d.unique && canBeUnique(d.kind)) o.unique = true;
  if (d.hidden) o.hidden = true;
  if (CHOICE_KINDS.includes(d.kind) && d.kind !== "stage" && d.options.length) o.options = [...d.options];
  if (d.kind === "link" && d.to) {
    o.to = d.to;
    if (d.many) o.many = true;
    if (d.inverse.trim()) o.inverse = { name: nameOf(d.inverse), label: d.inverse.trim() };
  }
  if (d.hidden_from.length) o.hidden_from = [...d.hidden_from];
  if (d.visible_if) o.visible_if = d.visible_if;
  if (d.required_if) o.required_if = d.required_if;
  return o;
}

const KIND_WORD = /** @type {Record<string, string>} */ ({ text: "Text", number: "Number", money: "Money", date: "Date", datetime: "Date and time", choice: "Choice", multi_choice: "Choices", boolean: "Yes or no", file: "File", address: "Address", phones: "Phone", emails: "Email", url: "Web address", rich_text: "Rich text", rating: "Rating", actor: "Person or assistant", stage: "Stage", sealed: "Sealed", link: "Link" });

/** One line under a field's name. @param {Partial<Draft> & { kind: string }} f @param {TypeRef[]} types */
export function fieldSummary(f, types) {
  const target = types.find((t) => t.name === f.to);
  if (f.kind === "link" && target) return (f.many ? `Links to many ${target.plural}` : `Link to ${target.label}`) + (f.required ? ", required" : "");
  const parts = [f.sealed ? "Sealed" : KIND_WORD[f.kind] ?? f.kind];
  if (f.options?.length) parts.push(`${f.options.length} options`);
  if (f.required) parts.push("required");
  if (f.unique) parts.push("unique");
  if (f.hidden) parts.push("hidden");
  const n = f.hidden_from?.length ?? 0;
  if (n) parts.push(`hidden from ${n} ${n === 1 ? "role" : "roles"}`);
  return parts.join(", ");
}

/** A rule from a pick: the Expression the type stores. @param {{ field: string, op: "is" | "is_not" | "filled", value?: string }} r */
export function buildRule(r) {
  if (!r.field) return "";
  if (r.op === "filled") return `not empty(${r.field})`;
  if (!r.value) return "";
  return `${r.field} ${r.op === "is" ? "==" : "!="} ${JSON.stringify(r.value)}`;
}
/** @param {{ field: string, op: "is" | "is_not" | "filled", value?: string }} r @param {string} fieldLabel */
export const ruleWords = (r, fieldLabel) => (r.op === "filled" ? `${fieldLabel} is filled in` : `${fieldLabel} ${r.op === "is" ? "is" : "is not"} ${r.value ?? ""}`.trim());
