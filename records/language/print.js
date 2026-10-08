// @ts-check
// Stored form -> canonical text. The text is a faithful projection of everything inside the
// language: compile(print(kit)) equals kit, and print(compile(text)) is the canonical text.
// Not preserved: comments, layout, constant names and any computed code (spec 5.6).

import { LanguageError } from "./errors.js";
import { labelOf, msToOffset, KERNEL_LINK_KIND } from "./sdk.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** @param {string} s */
export function q(s) {
  let out = '"';
  for (const ch of s) {
    if (ch === "\\") out += "\\\\"; else if (ch === '"') out += '\\"'; else if (ch === "\n") out += "\\n"; else if (ch === "\r") out += "\\r"; else if (ch === "\t") out += "\\t"; else out += ch;
  }
  return out + '"';
}
const pad = (n) => "  ".repeat(n);

/** Print any plain JSON value as a literal. @param {any} v @param {number} d */
function lit(v, d) {
  if (v === null) return "null";
  if (typeof v === "string") return q(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const flat = v.every((x) => x === null || typeof x !== "object");
    const one = "[" + v.map((x) => lit(x, d)).join(", ") + "]";
    if (flat && one.length < 90) return one;
    return "[\n" + v.map((x) => pad(d + 1) + lit(x, d + 1)).join(",\n") + ",\n" + pad(d) + "]";
  }
  const entries = Object.entries(v);
  if (!entries.length) return "{}";
  const one = "{ " + entries.map(([k, x]) => `${key(k)}: ${lit(x, d)}`).join(", ") + " }";
  if (entries.every(([, x]) => x === null || typeof x !== "object") && one.length < 90 && !one.includes("\n")) return one;
  return "{\n" + entries.map(([k, x]) => `${pad(d + 1)}${key(k)}: ${lit(x, d + 1)}`).join(",\n") + ",\n" + pad(d) + "}";
}
const key = (k) => (IDENT.test(k) ? k : q(k));

/** @param {any} f field (stored) @param {number} d @param {any} t the type, for its stages */
function field(f, d, t) {
  const { name, kind, ...rest } = f;
  if (kind === "stage") return stage(f, d, t);
  if (kind === "choice" || kind === "multi_choice") { const { options, ...o } = rest; const o2 = labelless(name, o); return `defineField.${kind}(${lit(options, d)}${Object.keys(o2).length ? ", " + lit(o2, d) : ""})`; }
  if (kind === "sealed") { const { seal, ...o } = rest; const o2 = { ...labelless(name, o), class: seal.class, ...(seal.level !== "ai" ? { level: seal.level } : {}), ...(seal.reveal_roles ? { reveal_roles: seal.reveal_roles } : {}), ...(seal.hint_allowed !== undefined ? { hint_allowed: seal.hint_allowed } : {}) }; return `defineField.sealed(${lit(o2, d)})`; }
  const o = labelless(name, rest);
  return `defineField.${kind === KERNEL_LINK_KIND ? "link" : kind}(${Object.keys(o).length ? lit(o, d) : ""})`;
}
/** The label is left out when it is the default made from the name. @param {string} name @param {any} o */
function labelless(name, o) { const { label, ...r } = o; return label !== undefined && label !== labelOf(name) ? { label, ...r } : r; }
/** One list of stages as text. @param {any[]} stages @param {number} d */
function stageItems(stages, d) {
  return stages.map((/** @type {any} */ s) => {
    if (!s.tasks && s.enter_if === undefined && s.owner === undefined) return pad(d + 1) + q(s.name);
    const parts = [`${pad(d + 2)}name: ${q(s.name)}`];
    if (s.owner !== undefined) parts.push(`${pad(d + 2)}owner: ${q(s.owner)}`);
    if (s.enter_if !== undefined) parts.push(`${pad(d + 2)}enter_if: ${q(s.enter_if)}`);
    if (s.tasks) parts.push(`${pad(d + 2)}tasks: [\n${s.tasks.map((/** @type {any} */ tk) => pad(d + 3) + "defineTask(" + lit(taskOut(tk), d + 3) + ")").join(",\n")},\n${pad(d + 2)}]`);
    return `${pad(d + 1)}{\n${parts.join(",\n")},\n${pad(d + 1)}}`;
  });
}
/** @param {any} f @param {number} d @param {any} t */
function stage(f, d, t) {
  const opts = labelless(f.name, { label: f.label, ...(f.description ? { description: f.description } : {}) });
  if (t.stage_sets?.length) opts.sets = t.stage_sets.map((/** @type {any} */ x) => ({ name: x.name, when: x.when, stages: x.stages }));
  const optText = Object.keys(opts).length ? ", " + litStages(opts, d) : "";
  return `defineStage([\n${stageItems(t.stages ?? [], d).join(",\n")},\n${pad(d)}]${optText})`;
}
/** Print the options of defineStage; a stage set's stages are printed as a stage list. @param {any} o @param {number} d */
function litStages(o, d) {
  const { sets, ...rest } = o;
  const parts = Object.entries(rest).map(([k, v]) => `${pad(d + 1)}${key(k)}: ${lit(v, d + 1)}`);
  if (sets) parts.push(`${pad(d + 1)}sets: [\n${sets.map((/** @type {any} */ x) => `${pad(d + 2)}{\n${pad(d + 3)}name: ${q(x.name)},\n${pad(d + 3)}when: ${q(x.when)},\n${pad(d + 3)}stages: [\n${stageItems(x.stages, d + 3).join(",\n")},\n${pad(d + 3)}],\n${pad(d + 2)}}`).join(",\n")},\n${pad(d + 1)}]`);
  return `{\n${parts.join(",\n")},\n${pad(d)}}`;
}
/** A stored task template back to the SDK's names. @param {any} t */
function taskOut(t) {
  const { depends_on, due_offset_ms, ...rest } = t;
  return { ...rest, ...(depends_on ? { dependsOn: depends_on } : {}), ...(due_offset_ms !== undefined ? { dueOffset: msToOffset(due_offset_ms) } : {}) };
}

/** @param {any} t */
function type(t) {
  const { fields, stages, stage_sets, rules, ...head } = t;
  const h = Object.entries(head).filter(([k, v]) => !(k === "label" && v === labelOf(t.name)));
  const parts = h.map(([k, x]) => `  ${key(k)}: ${lit(x, 1)}`);
  parts.push("  fields: {\n" + fields.map((/** @type {any} */ f) => `    ${key(f.name)}: ${field(f, 2, t)}`).join(",\n") + ",\n  }");
  if (rules?.length) parts.push("  rules: [\n" + rules.map((/** @type {any} */ r) => `    defineRule(${lit(r, 2)})`).join(",\n") + ",\n  ]");
  return "defineType({\n" + parts.join(",\n") + ",\n})";
}
const call = (fn, o) => `${fn}(${lit(o, 0)})`;

const pascal = (s) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "Item";

/**
 * Canonical text for a stored kit.
 * @param {any} kit
 * @returns {string}
 */
export function print(kit) {
  if (!kit || kit.kind !== "kit") throw new LanguageError("invalid_definition", "Not a stored kit");
  const used = new Set();
  const constName = (base) => { let n = base, i = 2; while (used.has(n)) n = base + i++; used.add(n); return n; };
  /** @type {string[]} */ const blocks = [];
  /** @type {string[]} */ const names = [];
  const emit = (suffix, items, render) => { for (const it of items ?? []) { const n = constName(pascal(it.name) + suffix); names.push(n); blocks.push(`export const ${n} = ${render(it)};`); } };
  emit("", kit.types, type);
  emit("Template", kit.templates, (t) => call("defineTemplate", t));
  emit("Role", kit.roles, (r) => call("defineRole", r));
  emit("Flow", kit.flows, (f) => { const { format, ...rest } = f; return call("defineFlow", rest); });
  emit("View", kit.views, (v) => call("defineView", v));
  emit("CodeStep", kit.codeSteps, (c) => call("defineCodeStep", c));
  const used2 = new Set(["defineKit"]);
  const all = blocks.join("\n");
  for (const m of all.matchAll(/\b(define[A-Z][A-Za-z]*)\b/g)) used2.add(m[1]);
  const head = { id: kit.id, version: kit.version, ...(kit.label ? { label: kit.label } : {}), ...(kit.description ? { description: kit.description } : {}) };
  const headParts = Object.entries(head).map(([k, x]) => `  ${key(k)}: ${lit(x, 1)}`);
  headParts.push(`  includes: [${names.join(", ")}]`);
  return `import { ${[...used2].sort().join(", ")} } from "@vyre/sdk";\n\n${blocks.join("\n\n")}\n\nexport default defineKit({\n${headParts.join(",\n")},\n});\n`;
}
