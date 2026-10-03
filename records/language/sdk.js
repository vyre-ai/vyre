// @ts-check
// The Vyre SDK vocabulary: the define* functions a definition file may call. Each one checks its
// input against a fixed shape and returns plain data in canonical key order. The stored form is
// this data; the text form is a projection of it (print.js). Nothing here runs author code.

import { LanguageError } from "./errors.js";
import { parseExpr } from "./expr.js";

export const SDK_VERSION = 1;
const NAME_RE = /^[a-z][a-z0-9_]*$/;
const KIT_ID_RE = /^[a-z][a-z0-9-]*$/;

export const FIELD_KINDS = ["text", "number", "money", "date", "datetime", "boolean", "choice", "person", "link", "file", "address", "phones", "emails", "richtext", "actor", "sealed"];
const COMMON = ["label", "description", "required"];
/** Options each field kind accepts, besides the common ones. */
const FIELD_OPTS = {
  text: ["maxLength", "unique", "default"], number: ["min", "max", "integer", "default"], money: ["currency"], date: [], datetime: [],
  boolean: ["default"], choice: ["options", "default"], person: ["multiple"], link: ["to", "many"], file: ["multiple"], address: [],
  phones: [], emails: [], richtext: [], actor: [], sealed: ["class", "level"],
};
export const SEAL_CLASSES = ["us-ssn", "bank-account", "card-number", "tax-id", "passport", "secret", "free"];
export const SEAL_LEVELS = ["model", "model-and-people"];
export const TASK_HOW = ["assistant", "tailor", "person", "deterministic"];
export const FLOW_VERBS = ["find", "create", "update", "remove", "decide", "repeat", "wait", "ask", "assign", "call", "stage", "agent", "classify", "http"];
export const ROLE_KINDS = ["teammate", "role"];
export const TEMPLATE_KINDS = ["email", "letter", "document", "message"];
export const VIEW_TYPES = ["list", "board", "calendar", "page", "dashboard"];

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

/** @param {string} kind */
function fieldBuilder(kind) {
  return (/** @type {any[]} */ ...args) => {
    let main, opts;
    if (kind === "choice") { main = args[0]; opts = args[1] ?? {}; if (!Array.isArray(main)) bad("defineField.choice", "Give the list of choices first"); }
    else { opts = args[0] ?? {}; }
    onlyKeys(opts, [...COMMON, ...FIELD_OPTS[kind]], `defineField.${kind}`);
    const f = { kind, label: opts.label, description: opts.description, required: opts.required };
    if (f.label !== undefined) str(f.label, `defineField.${kind}.label`, { max: 120 });
    if (f.description !== undefined) str(f.description, `defineField.${kind}.description`);
    if (f.required !== undefined) bool(f.required, `defineField.${kind}.required`);
    switch (kind) {
      case "choice": f.options = strList(main, "defineField.choice options", 200); if (!f.options.length) bad("defineField.choice", "A choice needs at least one option"); if (new Set(f.options).size !== f.options.length) bad("defineField.choice", "Choices must be different"); if (opts.default !== undefined) { if (!f.options.includes(opts.default)) bad("defineField.choice.default", "The default must be one of the choices"); f.default = opts.default; } break;
      case "link": f.to = name(opts.to, "defineField.link.to"); if (opts.many !== undefined) f.many = bool(opts.many, "defineField.link.many"); break;
      case "sealed": if (!SEAL_CLASSES.includes(opts.class)) bad("defineField.sealed.class", `Class must be one of ${SEAL_CLASSES.join(", ")}`); f.class = opts.class; if (opts.level !== undefined) { if (!SEAL_LEVELS.includes(opts.level)) bad("defineField.sealed.level", `Level must be one of ${SEAL_LEVELS.join(", ")}`); f.level = opts.level; } break;
      case "text": if (opts.maxLength !== undefined) { if (!Number.isInteger(opts.maxLength) || opts.maxLength < 1 || opts.maxLength > 100000) bad("defineField.text.maxLength", "A whole number from 1 to 100000"); f.maxLength = opts.maxLength; } if (opts.unique !== undefined) f.unique = bool(opts.unique, "defineField.text.unique"); if (opts.default !== undefined) f.default = str(opts.default, "defineField.text.default"); break;
      case "number": for (const k of ["min", "max"]) if (opts[k] !== undefined) { if (typeof opts[k] !== "number") bad(`defineField.number.${k}`, "Expected a number"); f[k] = opts[k]; } if (opts.integer !== undefined) f.integer = bool(opts.integer, "defineField.number.integer"); if (opts.default !== undefined) { if (typeof opts.default !== "number") bad("defineField.number.default", "Expected a number"); f.default = opts.default; } break;
      case "money": if (opts.currency !== undefined) { if (!/^[A-Z]{3}$/.test(opts.currency)) bad("defineField.money.currency", "A three-letter currency code such as USD"); f.currency = opts.currency; } break;
      case "boolean": if (opts.default !== undefined) f.default = bool(opts.default, "defineField.boolean.default"); break;
      case "person": case "file": if (opts.multiple !== undefined) f.multiple = bool(opts.multiple, `defineField.${kind}.multiple`); break;
      default: break;
    }
    return { $: "field", ...ordered(f, ["kind", "label", "description", "required", "options", "default", "to", "many", "class", "level", "maxLength", "unique", "min", "max", "integer", "currency", "multiple"]) };
  };
}
const defineField = Object.fromEntries(FIELD_KINDS.map((k) => [k, fieldBuilder(k)]));

/** @param {any} t task input */
function defineTask(t) {
  onlyKeys(t, ["title", "doer", "checker", "how", "output", "template", "dependsOn", "dueOffset", "required", "description"], "defineTask");
  const out = { title: str(t.title, "defineTask.title", { max: 200 }), doer: str(t.doer, "defineTask.doer", { max: 100 }), checker: t.checker === undefined ? undefined : str(t.checker, "defineTask.checker", { max: 100 }), how: t.how, output: t.output, template: t.template === undefined ? undefined : name(t.template, "defineTask.template"), dependsOn: t.dependsOn === undefined ? undefined : strList(t.dependsOn, "defineTask.dependsOn", 50), dueOffset: t.dueOffset, required: t.required, description: t.description === undefined ? undefined : str(t.description, "defineTask.description") };
  if (!/^(teammate|role|person|assistant|actor):[a-z][a-z0-9_.-]*$/.test(out.doer) && out.doer !== "creator" && out.doer !== "owner") bad("defineTask.doer", 'A doer looks like "teammate:research", "role:attorney", "person:alex", "creator" or "owner"');
  if (out.checker !== undefined && !/^(teammate|role|person|assistant|actor):[a-z][a-z0-9_.-]*$/.test(out.checker) && out.checker !== "owner") bad("defineTask.checker", 'A checker looks like "role:attorney" or "person:alex"');
  if (out.how !== undefined && !TASK_HOW.includes(out.how)) bad("defineTask.how", `How must be one of ${TASK_HOW.join(", ")}`);
  if (out.output !== undefined) { onlyKeys(out.output, ["fields", "note", "sent", "decision", "file"], "defineTask.output"); const o = out.output; if (o.fields !== undefined) strList(o.fields, "defineTask.output.fields", 50); for (const k of ["note", "decision", "file"]) if (o[k] !== undefined) bool(o[k], `defineTask.output.${k}`); if (o.sent !== undefined && !["email", "message", "letter"].includes(o.sent)) bad("defineTask.output.sent", "sent is email, message or letter"); out.output = ordered(o, ["fields", "note", "sent", "decision", "file"]); }
  if (out.dueOffset !== undefined && !/^\d+[hdw]$/.test(out.dueOffset)) bad("defineTask.dueOffset", 'A due offset looks like "2d", "48h" or "1w"');
  if (out.required !== undefined) bool(out.required, "defineTask.required");
  return { $: "task", ...ordered(out, ["title", "description", "doer", "checker", "how", "output", "template", "dependsOn", "dueOffset", "required"]) };
}

/** @param {any[]} stages @param {any} [opts] */
function defineStage(stages, opts = {}) {
  if (!Array.isArray(stages) || stages.length < 2 || stages.length > 40) bad("defineStage", "A stage field needs a list of 2 to 40 stages");
  onlyKeys(opts, ["label", "description"], "defineStage");
  const seen = new Set();
  /** @type {any[]} */ const list = [];
  stages.forEach((s, i) => {
    const path = `defineStage[${i}]`;
    if (typeof s === "string") { str(s, path, { max: 80 }); if (seen.has(s)) bad(path, `Two stages are named ${s}`); seen.add(s); list.push({ name: s }); return; }
    onlyKeys(s, ["name", "tasks", "enter", "description"], path);
    const nm = str(s.name, `${path}.name`, { max: 80 }); if (seen.has(nm)) bad(path, `Two stages are named ${nm}`); seen.add(nm);
    const tasks = s.tasks === undefined ? undefined : (Array.isArray(s.tasks) ? s.tasks.map((t, j) => { if (!isObj(t) || t.$ !== "task") bad(`${path}.tasks[${j}]`, "Each entry in tasks must be a defineTask(...) call"); const { $, ...rest } = t; return rest; }) : bad(`${path}.tasks`, "tasks must be a list"));
    if (tasks) { const titles = new Set(); for (const t of tasks) { if (titles.has(t.title)) bad(`${path}.tasks`, `Two tasks in ${nm} are titled ${t.title}`); titles.add(t.title); for (const d of t.dependsOn ?? []) if (!titles.has(d) && !stagesBeforeHaveTitle(list, d)) bad(`${path}.tasks`, `Task "${t.title}" depends on "${d}", which is not an earlier task in this or a previous stage`); } }
    list.push(ordered({ name: nm, description: s.description === undefined ? undefined : str(s.description, `${path}.description`), enter: s.enter === undefined ? undefined : expr(s.enter, `${path}.enter`), tasks: tasks && tasks.length ? tasks : undefined }, ["name", "description", "enter", "tasks"]));
  });
  return { $: "field", ...ordered({ kind: "stage", label: opts.label, description: opts.description, stages: list }, ["kind", "label", "description", "stages"]) };
}
/** @param {any[]} done @param {string} title */
const stagesBeforeHaveTitle = (done, title) => done.some((s) => (s.tasks ?? []).some((/** @type {any} */ t) => t.title === title));

function defineRule(r) {
  onlyKeys(r, ["name", "require", "message", "compute", "into"], "defineRule");
  if ((r.require === undefined) === (r.compute === undefined)) bad("defineRule", "A rule has either require (a condition) or compute (with into: the field to fill)");
  const out = { name: r.name === undefined ? undefined : name(r.name, "defineRule.name"), require: r.require === undefined ? undefined : expr(r.require, "defineRule.require"), message: r.message === undefined ? undefined : str(r.message, "defineRule.message", { max: 300 }), compute: r.compute === undefined ? undefined : expr(r.compute, "defineRule.compute"), into: r.into === undefined ? undefined : name(r.into, "defineRule.into") };
  if (out.compute !== undefined && out.into === undefined) bad("defineRule", "A computed rule needs into: the field it fills");
  return { $: "rule", ...ordered(out, ["name", "require", "message", "compute", "into"]) };
}

function defineType(t) {
  onlyKeys(t, ["name", "label", "plural", "icon", "description", "fields", "rules", "title"], "defineType");
  const nm = name(t.name, "defineType.name");
  if (!isObj(t.fields) || !Object.keys(t.fields).length) bad(`defineType(${nm}).fields`, "A type needs at least one field");
  if (Object.keys(t.fields).length > 200) bad(`defineType(${nm}).fields`, "A type has at most 200 fields");
  const fields = [];
  let stages = 0;
  for (const [k, v] of Object.entries(t.fields)) {
    name(k, `defineType(${nm}).fields.${k}`);
    if (!isObj(v) || v.$ !== "field") bad(`defineType(${nm}).fields.${k}`, "Each field must be a defineField.<kind>(...) or defineStage(...) call");
    const { $, ...rest } = v; if (rest.kind === "stage") stages++;
    fields.push({ name: k, ...rest });
  }
  if (stages > 1) bad(`defineType(${nm})`, "A type has at most one stage field");
  const rules = (t.rules ?? []).map((/** @type {any} */ r, /** @type {number} */ i) => { if (!isObj(r) || r.$ !== "rule") bad(`defineType(${nm}).rules[${i}]`, "Each entry in rules must be a defineRule(...) call"); const { $, ...rest } = r; return rest; });
  const title = t.title === undefined ? undefined : name(t.title, `defineType(${nm}).title`);
  if (title && !fields.some((f) => f.name === title && ["text"].includes(f.kind))) bad(`defineType(${nm}).title`, "title must name a text field of this type");
  return { $: "type", ...ordered({ name: nm, label: t.label === undefined ? undefined : str(t.label, "defineType.label", { max: 120 }), plural: t.plural === undefined ? undefined : str(t.plural, "defineType.plural", { max: 120 }), icon: t.icon === undefined ? undefined : str(t.icon, "defineType.icon", { max: 60 }), description: t.description === undefined ? undefined : str(t.description, "defineType.description"), title, fields, rules: rules.length ? rules : undefined }, ["name", "label", "plural", "icon", "description", "title", "fields", "rules"]) };
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

function defineFlow(f) {
  onlyKeys(f, ["name", "on", "steps", "description"], "defineFlow");
  const out = { name: str(f.name, "defineFlow.name", { max: 120 }), description: f.description === undefined ? undefined : str(f.description, "defineFlow.description"), on: f.on, steps: f.steps };
  onlyKeys(out.on, ["event", "schedule", "manual", "where"], "defineFlow.on");
  const kinds = ["event", "schedule", "manual"].filter((k) => out.on[k] !== undefined);
  if (kinds.length !== 1) bad("defineFlow.on", "A flow starts from exactly one of event, schedule or manual");
  if (out.on.event !== undefined && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(out.on.event)) bad("defineFlow.on.event", 'An event looks like "payment.received" or "matter.stage_changed"');
  if (out.on.schedule !== undefined && (typeof out.on.schedule !== "string" || out.on.schedule.split(/\s+/).length !== 5)) bad("defineFlow.on.schedule", "A schedule is five cron fields");
  if (out.on.where !== undefined) expr(out.on.where, "defineFlow.on.where");
  if (!Array.isArray(out.steps) || !out.steps.length || out.steps.length > 100) bad("defineFlow.steps", "A flow has 1 to 100 steps");
  out.steps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    if (!isObj(s)) bad(`defineFlow.steps[${i}]`, "A step is an object");
    const verbs = Object.keys(s).filter((k) => FLOW_VERBS.includes(k));
    if (verbs.length !== 1) bad(`defineFlow.steps[${i}]`, `A step has exactly one verb of ${FLOW_VERBS.join(", ")}`);
    assertPlain(s, `defineFlow.steps[${i}]`, 0);
  });
  return { $: "flow", ...ordered(out, ["name", "description", "on", "steps"]) };
}
/** JSON-safe data only, bounded. @param {any} v @param {string} path @param {number} depth */
function assertPlain(v, path, depth) {
  if (depth > 12) bad(path, "Nested too deeply");
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) { if (typeof v === "string" && v.length > 20000) bad(path, "Text too long"); return; }
  if (Array.isArray(v)) { if (v.length > 500) bad(path, "List too long"); v.forEach((x, i) => assertPlain(x, `${path}[${i}]`, depth + 1)); return; }
  if (isObj(v)) { if (v.$ !== undefined) bad(path, "A definition cannot be nested inside a step"); for (const [k, x] of Object.entries(v)) { if (k === "__proto__") bad(path, "Not allowed"); assertPlain(x, `${path}.${k}`, depth + 1); } return; }
  bad(path, "Unsupported value");
}

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
  "defineField.text": defineField.text, "defineField.number": defineField.number, "defineField.money": defineField.money, "defineField.date": defineField.date,
  "defineField.datetime": defineField.datetime, "defineField.boolean": defineField.boolean, "defineField.choice": defineField.choice, "defineField.person": defineField.person,
  "defineField.link": defineField.link, "defineField.file": defineField.file, "defineField.address": defineField.address, "defineField.phones": defineField.phones,
  "defineField.emails": defineField.emails, "defineField.richtext": defineField.richtext, "defineField.actor": defineField.actor, "defineField.sealed": defineField.sealed,
});
export { NAME_RE };
