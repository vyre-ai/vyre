// @ts-check
// The Vyre SDK vocabulary: the define* functions a definition file may call. Each one checks its
// input against a fixed shape and returns plain data in canonical key order. The stored form is
// this data; the text form is a projection of it (print.js). Nothing here runs author code.

import { LanguageError } from "./errors.js";
import { defineFlow as flowsDefineFlow, step as flowsStep, expr as flowsExpr } from "../../kernel/flows/sdk.js";
import { STEP_KINDS } from "../../kernel/flows/schema.js";
import { parseExpr } from "./expr.js";

export const SDK_VERSION = 1;
const NAME_RE = /^[a-z][a-z0-9_]*$/;
const KIT_ID_RE = /^[a-z][a-z0-9-]*$/;

import { FIELD_KINDS as KERNEL_KINDS, SEAL_CLASSES as KERNEL_SEAL_CLASSES, TASK_HOW as KERNEL_TASK_HOW, TASK_OUTPUT_KINDS as KERNEL_OUTPUT_KINDS } from "../../kernel/contracts/index.js";

/** The kinds a definition file may call, one per kernel field kind. `stage` is made with defineStage. */
/** The name the SDK uses for a link to another record is `link` (ruling 3 Oct); the kernel still calls that kind `ref`, so it is mapped here. Flip these two when the kernel renames. */
export const KERNEL_LINK_KIND = "ref";
export const FIELD_KINDS = KERNEL_KINDS.filter((k) => k !== "stage" && k !== "link" && k !== KERNEL_LINK_KIND).concat(["link"]);
export const SEAL_CLASSES = KERNEL_SEAL_CLASSES;
export const SEAL_LEVELS = ["ai", "human"];
export const TASK_HOW = KERNEL_TASK_HOW;
export const TASK_OUTPUT_KINDS = KERNEL_OUTPUT_KINDS;
export const FLOW_VERBS = ["find", "create", "update", "remove", "decide", "repeat", "wait", "ask", "assign", "call", "stage", "agent", "classify", "http"];
export const ROLE_KINDS = ["teammate", "role"];
export const TEMPLATE_KINDS = ["email", "letter", "document", "message"];
export const VIEW_TYPES = ["list", "board", "calendar", "page", "dashboard"];
const COMMON = ["label", "description", "required"];
/** Options each field kind takes besides the common ones. Exactly what the kernel's FieldDefinition can say. */
const FIELD_OPTS = { choice: [], multi_choice: [], link: ["to"], sealed: ["class", "level", "reveal_roles", "hint_allowed"] };

/** @param {string} path @param {string} msg */
const bad = (path, msg) => { throw new LanguageError("invalid_definition", msg, { path }); };
/** @param {any} v */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Reject unknown keys and wrong types. @param {any} o @param {string[]} allowed @param {string} path */
function onlyKeys(o, allowed, path) {
  if (!isObj(o)) bad(path, "Expected an object");
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${path}.${k}`, `Unknown option "${k}". Allowed: ${allowed.join(", ")}`);
}
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/;
const str = (v, path, { max = 4000, required = true } = {}) => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || (required && !v.length)) bad(path, "Expected text");
  if (v.length > max) bad(path, `Longer than ${max} characters`);
  if (CONTROL.test(v)) bad(path, "Control characters are not allowed in text");
  return v;
};
const name = (v, path) => { if (typeof v !== "string" || !NAME_RE.test(v)) bad(path, "A name is lowercase letters, digits and underscores, starting with a letter"); if (v.length > 40) bad(path, "A name is at most 40 characters"); return v; };
const bool = (v, path) => { if (typeof v !== "boolean") bad(path, "Expected true or false"); return v; };
const strList = (v, path, max = 100) => { if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || !x.length || x.length > 200 || CONTROL.test(x))) bad(path, `Expected a list of up to ${max} texts`); return v; };
const expr = (v, path) => { const s = str(v, path, { max: 2000 }); try { parseExpr(/** @type {string} */ (s)); } catch (e) { bad(path, /** @type {Error} */ (e).message); } return s; };
/** Copy defined keys in the given order. @param {Record<string, any>} o @param {string[]} order */
const ordered = (o, order) => { /** @type {Record<string, any>} */ const out = {}; for (const k of order) if (o[k] !== undefined) out[k] = o[k]; return out; };
/** "full_name" -> "Full name" */
export const labelOf = (/** @type {string} */ n) => { const w = n.replace(/_/g, " "); return w[0].toUpperCase() + w.slice(1); };

/** @param {string} kind */
function fieldBuilder(kind) {
  return (/** @type {any[]} */ ...args) => {
    let main, opts;
    if (kind === "choice" || kind === "multi_choice") { main = args[0]; opts = args[1] ?? {}; if (!Array.isArray(main)) bad(`defineField.${kind}`, "Give the list of options first"); }
    else { opts = args[0] ?? {}; }
    onlyKeys(opts, [...COMMON, ...(FIELD_OPTS[kind] ?? [])], `defineField.${kind}`);
    /** @type {Record<string, any>} */ const f = { kind, label: opts.label === undefined ? undefined : str(opts.label, `defineField.${kind}.label`, { max: 120 }), description: opts.description === undefined ? undefined : str(opts.description, `defineField.${kind}.description`), required: opts.required === undefined ? undefined : bool(opts.required, `defineField.${kind}.required`) };
    if (kind === "choice" || kind === "multi_choice") { f.options = strList(main, `defineField.${kind} options`, 200); if (!f.options.length) bad(`defineField.${kind}`, "Needs at least one option"); if (new Set(f.options).size !== f.options.length) bad(`defineField.${kind}`, "Options must be different"); }
    if (kind === "link") { f.to = name(opts.to, "defineField.link.to"); f.kind = KERNEL_LINK_KIND; }
    if (kind === "sealed") {
      if (!SEAL_CLASSES.includes(opts.class)) bad("defineField.sealed.class", `Class must be one of ${SEAL_CLASSES.join(", ")}`);
      const level = opts.level ?? "ai"; if (!SEAL_LEVELS.includes(level)) bad("defineField.sealed.level", `Level must be one of ${SEAL_LEVELS.join(", ")}`);
      f.seal = ordered({ level, class: opts.class, reveal_roles: opts.reveal_roles === undefined ? undefined : strList(opts.reveal_roles, "defineField.sealed.reveal_roles", 20), hint_allowed: opts.hint_allowed === undefined ? undefined : bool(opts.hint_allowed, "defineField.sealed.hint_allowed") }, ["level", "class", "reveal_roles", "hint_allowed"]);
    }
    return { $: "field", ...ordered(f, ["kind", "label", "description", "required", "options", "to", "seal"]) };
  };
}
const defineField = Object.fromEntries(FIELD_KINDS.map((k) => [k, fieldBuilder(k)]));

const UNITS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };
/** "2d" -> ms, and back to the largest exact unit. */
export const offsetToMs = (/** @type {string} */ s) => Number(s.slice(0, -1)) * /** @type {any} */ (UNITS)[s.slice(-1)];
export const msToOffset = (/** @type {number} */ ms) => (ms % UNITS.w === 0 ? `${ms / UNITS.w}w` : ms % UNITS.d === 0 ? `${ms / UNITS.d}d` : `${ms / UNITS.h}h`);

/** @param {any} t task input: the kernel's TaskTemplateDef, with dependsOn and dueOffset for the two snake_case names */
function defineTask(t) {
  onlyKeys(t, ["title", "doer", "checker", "how", "output", "template", "dependsOn", "dueOffset", "required"], "defineTask");
  const out = { title: str(t.title, "defineTask.title", { max: 200 }), doer: str(t.doer, "defineTask.doer", { max: 100 }), checker: t.checker === undefined ? undefined : str(t.checker, "defineTask.checker", { max: 100 }), output: t.output, how: t.how, template: t.template === undefined ? undefined : name(t.template, "defineTask.template"), depends_on: t.dependsOn === undefined ? undefined : strList(t.dependsOn, "defineTask.dependsOn", 50), due_offset_ms: /** @type {number | undefined} */ (undefined), required: t.required };
  const who = /^(teammate|role|person|assistant|actor):[a-z][a-z0-9_.-]*$/;
  if (!who.test(out.doer) && out.doer !== "creator" && out.doer !== "owner") bad("defineTask.doer", 'A doer looks like "teammate:research", "role:attorney", "person:alex", "creator" or "owner"');
  if (out.checker !== undefined && !who.test(out.checker) && out.checker !== "owner") bad("defineTask.checker", 'A checker looks like "role:attorney" or "person:alex"');
  if (out.how !== undefined && !TASK_HOW.includes(out.how)) bad("defineTask.how", `How must be one of ${TASK_HOW.join(", ")}`);
  onlyKeys(out.output, ["kind", "target"], "defineTask.output");
  if (!TASK_OUTPUT_KINDS.includes(out.output.kind)) bad("defineTask.output.kind", `kind must be one of ${TASK_OUTPUT_KINDS.join(", ")}`);
  if (out.output.target !== undefined && typeof out.output.target !== "string" && !(Array.isArray(out.output.target))) bad("defineTask.output.target", "target is a name or a list of names");
  if (Array.isArray(out.output.target)) strList(out.output.target, "defineTask.output.target", 50);
  out.output = ordered(out.output, ["kind", "target"]);
  if (t.dueOffset !== undefined) { if (typeof t.dueOffset !== "string" || !/^\d+[hdw]$/.test(t.dueOffset)) bad("defineTask.dueOffset", 'A due offset looks like "2d", "48h" or "1w"'); out.due_offset_ms = offsetToMs(t.dueOffset); }
  if (out.required !== undefined) bool(out.required, "defineTask.required");
  return { $: "task", ...ordered(out, ["title", "doer", "checker", "output", "how", "template", "depends_on", "due_offset_ms", "required"]) };
}

/** @param {any[]} stages @param {any} [opts] */
function defineStage(stages, opts = {}) {
  if (!Array.isArray(stages) || stages.length < 2 || stages.length > 40) bad("defineStage", "A stage field needs a list of 2 to 40 stages");
  onlyKeys(opts, ["label", "description"], "defineStage");
  const seen = new Set();
  /** @type {any[]} */ const list = [];
  const titlesBefore = (/** @type {string} */ title) => list.some((s) => (s.tasks ?? []).some((/** @type {any} */ t) => t.title === title));
  stages.forEach((s, i) => {
    const path = `defineStage[${i}]`;
    if (typeof s === "string") { str(s, path, { max: 80 }); if (seen.has(s)) bad(path, `Two stages are named ${s}`); seen.add(s); list.push({ name: s }); return; }
    onlyKeys(s, ["name", "tasks"], path);
    const nm = str(s.name, `${path}.name`, { max: 80 }); if (seen.has(nm)) bad(path, `Two stages are named ${nm}`); seen.add(nm);
    const tasks = s.tasks === undefined ? undefined : (Array.isArray(s.tasks) ? s.tasks.map((t, j) => { if (!isObj(t) || t.$ !== "task") bad(`${path}.tasks[${j}]`, "Each entry in tasks must be a defineTask(...) call"); const { $, ...rest } = t; return rest; }) : bad(`${path}.tasks`, "tasks must be a list"));
    if (tasks) { const titles = new Set(); for (const t of tasks) { if (titles.has(t.title)) bad(`${path}.tasks`, `Two tasks in ${nm} are titled ${t.title}`); titles.add(t.title); for (const d of t.depends_on ?? []) if (!titles.has(d) && !titlesBefore(d)) bad(`${path}.tasks`, `Task "${t.title}" depends on "${d}", which is not an earlier task in this or a previous stage`); } }
    list.push(ordered({ name: nm, tasks: tasks && tasks.length ? tasks : undefined }, ["name", "tasks"]));
  });
  return { $: "stage", label: opts.label === undefined ? undefined : str(opts.label, "defineStage.label", { max: 120 }), description: opts.description === undefined ? undefined : str(opts.description, "defineStage.description"), stages: list };
}

function defineRule(r) {
  onlyKeys(r, ["name", "require"], "defineRule");
  const out = { name: r.name === undefined ? undefined : name(r.name, "defineRule.name"), require: expr(r.require, "defineRule.require") };
  return { $: "rule", ...ordered(out, ["name", "require"]) };
}

/** A type is the kernel's TypeDefinition: fields (a stage field among them), stages with their task templates, rules. */
function defineType(t) {
  onlyKeys(t, ["name", "label", "icon", "fields", "rules"], "defineType");
  const nm = name(t.name, "defineType.name");
  if (!isObj(t.fields) || !Object.keys(t.fields).length) bad(`defineType(${nm}).fields`, "A type needs at least one field");
  if (Object.keys(t.fields).length > 200) bad(`defineType(${nm}).fields`, "A type has at most 200 fields");
  const fields = []; /** @type {any} */ let stageDef = null;
  for (const [k, v] of Object.entries(t.fields)) {
    name(k, `defineType(${nm}).fields.${k}`);
    if (!isObj(v) || (v.$ !== "field" && v.$ !== "stage")) bad(`defineType(${nm}).fields.${k}`, "Each field must be a defineField.<kind>(...) or defineStage(...) call");
    if (v.$ === "stage") {
      if (stageDef) bad(`defineType(${nm})`, "A type has at most one stage field");
      stageDef = v;
      fields.push(ordered({ name: k, kind: "stage", label: v.label ?? labelOf(k), description: v.description, options: v.stages.map((/** @type {any} */ s) => s.name) }, ["name", "kind", "label", "description", "options"]));
    } else { const { $, ...rest } = v; fields.push({ name: k, ...ordered({ ...rest, label: rest.label ?? labelOf(k) }, ["kind", "label", "description", "required", "options", "to", "seal"]) }); }
  }
  const rules = (t.rules ?? []).map((/** @type {any} */ r, /** @type {number} */ i) => { if (!isObj(r) || r.$ !== "rule") bad(`defineType(${nm}).rules[${i}]`, "Each entry in rules must be a defineRule(...) call"); const { $, ...rest } = r; return rest; });
  return { $: "type", ...ordered({ name: nm, label: t.label === undefined ? labelOf(nm) : str(t.label, "defineType.label", { max: 120 }), icon: t.icon === undefined ? undefined : str(t.icon, "defineType.icon", { max: 60 }), fields, stages: stageDef ? stageDef.stages : undefined, rules: rules.length ? rules : undefined }, ["name", "label", "icon", "fields", "stages", "rules"]) };
}

function defineTemplate(t) {
  onlyKeys(t, ["name", "kind", "subject", "body", "description"], "defineTemplate");
  const out = { name: name(t.name, "defineTemplate.name"), kind: t.kind, subject: t.subject === undefined ? undefined : str(t.subject, "defineTemplate.subject", { max: 300 }), body: str(t.body, "defineTemplate.body", { max: 50000 }), description: t.description === undefined ? undefined : str(t.description, "defineTemplate.description") };
  if (!TEMPLATE_KINDS.includes(out.kind)) bad("defineTemplate.kind", `kind must be one of ${TEMPLATE_KINDS.join(", ")}`);
  for (const [label, text] of [["subject", out.subject ?? ""], ["body", out.body]]) for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!/^(sealed:)?[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(m[1])) bad(`defineTemplate.${label}`, `Merge field {{${m[1]}}} is not a name path such as client.name`);
  if (/\{\{[^}]*$/.test(out.body)) bad("defineTemplate.body", "A merge field is never closed");
  return { $: "template", ...ordered(out, ["name", "kind", "description", "subject", "body"]) };
}

function defineRole(r) {
  onlyKeys(r, ["name", "kind", "label", "description", "grants", "instructions"], "defineRole");
  const out = { name: name(r.name, "defineRole.name"), kind: r.kind ?? "role", label: r.label === undefined ? undefined : str(r.label, "defineRole.label", { max: 120 }), description: r.description === undefined ? undefined : str(r.description, "defineRole.description"), instructions: r.instructions === undefined ? undefined : str(r.instructions, "defineRole.instructions", { max: 20000 }), grants: r.grants };
  if (!ROLE_KINDS.includes(out.kind)) bad("defineRole.kind", `kind must be one of ${ROLE_KINDS.join(", ")}`);
  if (!Array.isArray(out.grants) || out.grants.length > 100) bad("defineRole.grants", "grants is a list of up to 100 entries");
  out.grants = out.grants.map((/** @type {any} */ g, /** @type {number} */ i) => {
    onlyKeys(g, ["read", "write", "create", "remove", "where", "until"], `defineRole.grants[${i}]`);
    const verbs = ["read", "write", "create", "remove"].filter((v) => g[v] !== undefined);
    if (verbs.length !== 1) bad(`defineRole.grants[${i}]`, "Each grant has exactly one of read, write, create or remove");
    const target = g[verbs[0]]; if (typeof target !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_*]*)?$/.test(target)) bad(`defineRole.grants[${i}].${verbs[0]}`, 'A target is a type or "type.field", such as "matter" or "matter.practice_area"');
    return ordered({ [verbs[0]]: target, where: g.where === undefined ? undefined : expr(g.where, `defineRole.grants[${i}].where`), until: g.until === undefined ? undefined : str(g.until, `defineRole.grants[${i}].until`, { max: 40 }) }, [verbs[0], "where", "until"]);
  });
  return { $: "role", ...ordered(out, ["name", "kind", "label", "description", "instructions", "grants"]) };
}

/** Flows are sessions' (kernel/flows): the stored form, the checks and the runner are theirs. */
function defineFlow(def) {
  try { return { $: "flow", ...flowsDefineFlow({ authorship: "kit", ...def }) }; }
  catch (e) { bad("defineFlow", String(/** @type {Error} */ (e).message).replace(/^defineFlow: /, "")); }
}
const stepBuilders = Object.fromEntries(STEP_KINDS.map((k) => [`step.${k}`, (/** @type {string} */ id, /** @type {any} */ props) => flowsStep[k](id, props)]));

function defineView(v) {
  onlyKeys(v, ["name", "type", "of", "label", "groupBy", "dateField", "columns", "filter", "sort"], "defineView");
  const out = { name: name(v.name, "defineView.name"), type: v.type, of: name(v.of, "defineView.of"), label: v.label === undefined ? undefined : str(v.label, "defineView.label", { max: 120 }), groupBy: v.groupBy === undefined ? undefined : name(v.groupBy, "defineView.groupBy"), dateField: v.dateField === undefined ? undefined : name(v.dateField, "defineView.dateField"), columns: v.columns === undefined ? undefined : strList(v.columns, "defineView.columns", 50), filter: v.filter === undefined ? undefined : expr(v.filter, "defineView.filter"), sort: v.sort };
  if (!VIEW_TYPES.includes(out.type)) bad("defineView.type", `type must be one of ${VIEW_TYPES.join(", ")}`);
  if (out.sort !== undefined) { onlyKeys(out.sort, ["field", "dir"], "defineView.sort"); name(out.sort.field, "defineView.sort.field"); if (!["asc", "desc"].includes(out.sort.dir ?? "asc")) bad("defineView.sort.dir", "asc or desc"); out.sort = ordered(out.sort, ["field", "dir"]); }
  if (out.type === "board" && !out.groupBy) bad("defineView", "A board needs groupBy: the choice or stage field to group by");
  if (out.type === "calendar" && !out.dateField) bad("defineView", "A calendar needs dateField");
  return { $: "view", ...ordered(out, ["name", "type", "of", "label", "groupBy", "dateField", "columns", "filter", "sort"]) };
}

const MAX_CODE_BODY = 200_000;
function defineCodeStep(c) {
  onlyKeys(c, ["name", "language", "inputs", "outputs", "needs", "body"], "defineCodeStep");
  const body = str(c.body, "defineCodeStep.body", { max: MAX_CODE_BODY });
  if (c.language !== undefined && c.language !== "js") bad("defineCodeStep.language", "Only js is supported");
  return { $: "code", ...ordered({ name: name(c.name, "defineCodeStep.name"), language: "js", inputs: c.inputs === undefined ? undefined : strList(c.inputs, "defineCodeStep.inputs", 50), outputs: c.outputs === undefined ? undefined : strList(c.outputs, "defineCodeStep.outputs", 50), needs: c.needs === undefined ? undefined : strList(c.needs, "defineCodeStep.needs", 20), body }, ["name", "language", "inputs", "outputs", "needs", "body"]) };
}

function defineKit(k) {
  onlyKeys(k, ["id", "version", "label", "description", "includes", "sdk"], "defineKit");
  if (typeof k.id !== "string" || !KIT_ID_RE.test(k.id)) bad("defineKit.id", "An id is lowercase letters, digits and dashes");
  if (!Number.isInteger(k.version) || k.version < 1) bad("defineKit.version", "version is a whole number from 1");
  if (k.sdk !== undefined && k.sdk !== SDK_VERSION) bad("defineKit.sdk", `This compiler reads SDK version ${SDK_VERSION}`);
  if (!Array.isArray(k.includes) || !k.includes.length) bad("defineKit.includes", "A kit includes a list of definitions");
  return { $: "kit", id: k.id, version: k.version, ...(k.label !== undefined ? { label: str(k.label, "defineKit.label", { max: 120 }) } : {}), ...(k.description !== undefined ? { description: str(k.description, "defineKit.description") } : {}), includes: k.includes };
}

/** The table the evaluator calls into. Exactly these names are callable from a definition file. */
export const SDK = Object.freeze({
  defineKit, defineType, defineStage, defineTask, defineTemplate, defineRule, defineRole, defineFlow, defineView, defineCodeStep,
  ...Object.fromEntries(FIELD_KINDS.map((k) => [`defineField.${k}`, defineField[k]])),
  ...stepBuilders,
  expr: (/** @type {string} */ src) => flowsExpr(src),
});
export { NAME_RE };
