// @ts-check
// Definition text -> stored form. Parse (source only), evaluate the SDK calls (pure data), then
// check the whole kit against itself. The stored form is JSON and is the source of truth.

import { parse, parseSafely } from "./parse.js";
import { SDK, SDK_VERSION } from "./sdk.js";
import { LanguageError } from "./errors.js";
import { parseExpr, exprNames } from "./expr.js";
import { stageNamesOf } from "../../kernel/expr/conditions.js";
import { print } from "./print.js";
import { compileFlow } from "../../kernel/flows/compile.js";
import { CORE_TYPES as CORE_DEFS } from "../core-types.js";
import { FIELD_ORDER } from "./sdk.js";
const CORE_BY_NAME = new Map(CORE_DEFS.map((t) => [t.name, t]));

/** Types a Kit may link to without defining them: the core record types every Space has. */
export const CORE_TYPES = Object.freeze(["note", "template", "playbook", "team-member", "contact", "contact_point", "organization", "communication", "participant", "event", "project", "session-summary", "task"]);

/**
 * A Kit may add fields to a core type (a Kit's `contact` carries the fields its practice needs). The stored type is the whole thing: the core fields first, then
 * the Kit's own, so an installer defines one complete type and nothing core is ever removed. A Kit field that repeats a core field's name must be the same kind
 * (then it is the core field); a different kind is an error.
 * @param {any} t
 */
/** A core field written in the order the language writes a stored field, so a stored kit prints and reads back the same. @param {any} f */
const inOrder = (f) => ({ name: f.name, ...Object.fromEntries(FIELD_ORDER.filter((k) => f[k] !== undefined).map((k) => [k, f[k]])) });
function mergeCoreType(t) {
  const core = CORE_BY_NAME.get(t.name);
  if (!core) return t;
  for (const f of t.fields) { const c = core.fields.find((/** @type {any} */ x) => x.name === f.name); if (c && c.kind !== f.kind) throw new LanguageError("invalid_definition", `${t.name}.${f.name} is already a core ${c.kind} field; a Kit adds new fields to a core type, it does not change core ones`, { path: `type ${t.name}.${f.name}` }); }
  const have = new Set(core.fields.map((/** @type {any} */ f) => f.name));
  const merged = { ...t, label: core.label, ...(core.icon ? { icon: core.icon } : {}), fields: [...core.fields.map(inOrder), ...t.fields.filter((/** @type {any} */ f) => !have.has(f.name))] };
  return Object.fromEntries(["name", "label", "icon", "kind", "fields", "stages", "stage_sets", "rules", "role"].filter((k) => /** @type {any} */ (merged)[k] !== undefined).map((k) => [k, /** @type {any} */ (merged)[k]]));
}
/** Roles every Space has. */
export const CORE_ROLES = Object.freeze(["owner", "admin", "member"]);

/**
 * @typedef {{ kind: "kit", sdk: number, id: string, version: number, label?: string, description?: string,
 *   types: any[], templates: any[], roles: any[], flows: any[], views: any[], codeSteps: any[] }} StoredKit
 */

/** @param {import("./parse.js").Program} program @returns {StoredKit} */
export function evaluate(program) {
  const imported = new Set(program.imports);
  /** @type {Map<string, any>} */ const env = new Map();
  /** @param {import("./parse.js").Node} n @returns {any} */
  const ev = (n) => {
    switch (n.type) {
      case "Str": case "Num": case "Bool": return n.value;
      case "Null": return null;
      case "Array": return n.items.map(ev);
      case "Object": { /** @type {Record<string, any>} */ const o = {}; for (const p of n.props) { if (Object.prototype.hasOwnProperty.call(o, p.key)) throw new LanguageError("invalid_definition", `The key "${p.key}" appears twice`, { line: p.line, col: p.col }); o[p.key] = ev(p.value); } return o; }
      case "Ref": { if (!env.has(n.name)) throw new LanguageError("unknown_reference", `"${n.name}" is not defined above this line`, { line: n.line, col: n.col }); return env.get(n.name); }
      case "Call": {
        const root = n.callee.split(".")[0];
        if (!imported.has(root)) throw new LanguageError("unknown_function", `"${root}" is not imported from @vyre/sdk`, { line: n.line, col: n.col });
        const fn = Object.prototype.hasOwnProperty.call(SDK, n.callee) ? /** @type {any} */ (SDK)[n.callee] : undefined;
        if (!fn) throw new LanguageError("unknown_function", `"${n.callee}" is not part of the SDK`, { line: n.line, col: n.col });
        const args = n.args.map(ev);
        try { return fn(...args); } catch (e) { if (e instanceof LanguageError && e.line === undefined) throw new LanguageError(e.code, e.message.replace(/ \(at .*\)$/, "") + ` [${e.path ?? n.callee}]`, { line: n.line, col: n.col }); throw e; }
      }
    }
  };
  for (const c of program.consts) { if (env.has(c.name)) throw new LanguageError("invalid_definition", `"${c.name}" is defined twice`, { line: c.value.line, col: c.value.col }); env.set(c.name, ev(c.value)); }
  if (!program.defaultExport) throw new LanguageError("missing_kit", "The file must end with export default defineKit({ ... })");
  const kit = ev(program.defaultExport);
  if (!kit || kit.$ !== "kit") throw new LanguageError("missing_kit", "The default export must be a defineKit({ ... }) call", { line: program.defaultExport.line, col: program.defaultExport.col });

  /** @type {StoredKit} */
  const out = { kind: "kit", sdk: SDK_VERSION, id: kit.id, version: kit.version, ...(kit.label ? { label: kit.label } : {}), ...(kit.description ? { description: kit.description } : {}), types: [], templates: [], roles: [], flows: [], views: [], codeSteps: [] };
  const bucket = { type: "types", template: "templates", role: "roles", flow: "flows", view: "views", code: "codeSteps" };
  const seen = new Set();
  for (const d of kit.includes) {
    if (!d || typeof d !== "object" || !(d.$ in bucket)) throw new LanguageError("invalid_definition", "defineKit.includes may list only definitions made with the SDK", { path: "defineKit.includes" });
    if (d.$ === "kit") throw new LanguageError("invalid_definition", "A kit cannot include another kit yet", { path: "defineKit.includes" });
    const key = `${d.$}:${d.name}`;
    if (seen.has(key)) throw new LanguageError("invalid_definition", `${d.$} "${d.name}" is included twice`, { path: "defineKit.includes" });
    seen.add(key);
    const { $, ...rest } = d;
    /** @type {any} */ (out)[/** @type {any} */ (bucket)[d.$]].push(rest);
  }
  out.types = out.types.map(mergeCoreType);
  return checkKit(out);
}

/**
 * Cross-checks inside one kit: references resolve, expressions name real fields, sealed fields stay
 * out of expressions and merge fields. Returns the kit.
 * @param {StoredKit} kit @returns {StoredKit}
 */
export function checkKit(kit) {
  const err = (path, msg) => { throw new LanguageError("invalid_definition", msg, { path }); };
  const typeNames = new Set(kit.types.map((t) => t.name));
  const roleNames = new Map(kit.roles.map((r) => [r.name, r]));
  const templateNames = new Set(kit.templates.map((t) => t.name));
  const sealedNames = new Set(kit.types.flatMap((t) => t.fields.filter((/** @type {any} */ f) => f.kind === "sealed").map((/** @type {any} */ f) => f.name)));
  /** @param {string} path @param {string} src @param {any} type */
  const checkExpr = (path, src, type) => {
    for (const nm of exprNames(parseExpr(src))) {
      const f = type.fields.find((/** @type {any} */ x) => x.name === nm);
      if (!f) err(path, `The expression names "${nm}", which is not a field of ${type.name}`);
      if (f.kind === "sealed") err(path, `The field "${nm}" is sealed and cannot be used in an expression`);
    }
  };
  for (const t of kit.types) {
    const fieldNames = new Set();
    for (const f of t.fields) {
      if (fieldNames.has(f.name)) err(`type ${t.name}`, `Field "${f.name}" appears twice`);
      fieldNames.add(f.name);
      if (f.kind === "link" && f.to !== undefined && !typeNames.has(f.to) && !CORE_TYPES.includes(f.to)) err(`type ${t.name}.${f.name}`, `Refers to "${f.to}", which is neither defined in this kit nor a core type (${CORE_TYPES.join(", ")})`);
    }
    for (const [i, r] of (t.rules ?? []).entries()) checkExpr(`type ${t.name}.rules[${i}]`, r.require, t);
    const stageField = t.fields.find((/** @type {any} */ f) => f.kind === "stage");
    for (const f of t.fields) for (const k of ["visible_if", "required_if"]) {
      if (f[k] === undefined) continue;
      checkExpr(`type ${t.name}.${f.name}.${k}`, f[k], t);
      if (exprNames(parseExpr(f[k])).has(f.name)) err(`type ${t.name}.${f.name}.${k}`, `${k} cannot name the field it is on`);
      if (f.required && k === "required_if") err(`type ${t.name}.${f.name}`, "A field is required, or required_if something, not both");
    }
    if (stageField && JSON.stringify(stageNamesOf(t)) !== JSON.stringify(stageField.options)) err(`type ${t.name}`, "The stage field's options must be the stages of the type and of its stage sets, each name once");
    for (const [i, set] of (t.stage_sets ?? []).entries()) {
      if (!stageField) err(`type ${t.name}.stage_sets[${i}]`, "stage_sets need a stage field");
      checkExpr(`type ${t.name}.stage_sets[${i}].when`, set.when, t);
      if (exprNames(parseExpr(set.when)).has(stageField.name)) err(`type ${t.name}.stage_sets[${i}].when`, "A stage set is picked by the record's other fields, not by its stage");
    }
    for (const s of [...(t.stages ?? []), ...(t.stage_sets ?? []).flatMap((/** @type {any} */ x) => x.stages)]) {
      if (s.enter_if !== undefined) { checkExpr(`type ${t.name} stage ${s.name}.enter_if`, s.enter_if, t); if (exprNames(parseExpr(s.enter_if)).has(stageField?.name)) err(`type ${t.name} stage ${s.name}.enter_if`, "A stage's entry condition reads the record's other fields, not its stage"); }
      for (const task of s.tasks ?? []) {
        const at = `type ${t.name} stage ${s.name} task "${task.title}"`;
        for (const who of [task.doer, task.checker].filter(Boolean)) {
          const [k, nm] = String(who).split(":");
          if (k === "teammate") { const r = roleNames.get(nm); if (!r || r.kind !== "teammate") err(at, `${who} is not a teammate role defined in this kit`); }
          else if (k === "role" && !roleNames.has(nm) && !CORE_ROLES.includes(nm)) err(at, `${who} is not a role defined in this kit`);
        }
        if (task.template && !templateNames.has(task.template)) err(at, `Uses template "${task.template}", which is not in this kit`);
        if (task.output.kind === "fields") for (const fn of [].concat(task.output.target ?? [])) { const f = t.fields.find((/** @type {any} */ x) => x.name === fn); if (!f) err(at, `Output names "${fn}", which is not a field of ${t.name}`); if (f.kind === "sealed") err(at, `Output names the sealed field "${fn}"`); }
      }
    }
  }
  for (const r of kit.roles) for (const [i, g] of r.grants.entries()) {
    const target = g.read ?? g.write ?? g.create ?? g.remove; const [tn, fn] = target.split(".");
    const t = kit.types.find((x) => x.name === tn);
    if (!t && !CORE_TYPES.includes(tn)) err(`role ${r.name}.grants[${i}]`, `${tn} is not a type in this kit or a core type`);
    if (t && fn && fn !== "*" && !t.fields.some((/** @type {any} */ f) => f.name === fn)) err(`role ${r.name}.grants[${i}]`, `${tn} has no field "${fn}"`);
    if (t && g.where) checkExpr(`role ${r.name}.grants[${i}]`, g.where, t);
  }
  for (const tpl of kit.templates) for (const text of [tpl.subject ?? "", tpl.body]) for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    const path = m[1]; const last = path.replace(/^sealed:/, "").split(".").pop() ?? "";
    if (!path.startsWith("sealed:") && sealedNames.has(last)) err(`template ${tpl.name}`, `{{${path}}} reads a sealed field; write {{sealed:${path}}} so the value is filled by Vyre and never shown to a model`);
  }
  for (const v of kit.views) {
    const t = kit.types.find((x) => x.name === v.of); if (!t) err(`view ${v.name}`, `${v.of} is not a type in this kit`);
    if (v.groupBy) { const f = t.fields.find((/** @type {any} */ x) => x.name === v.groupBy); if (!f || !["stage", "choice"].includes(f.kind)) err(`view ${v.name}`, "groupBy must be a stage or choice field"); }
    if (v.dateField) { const f = t.fields.find((/** @type {any} */ x) => x.name === v.dateField); if (!f || !["date", "datetime"].includes(f.kind)) err(`view ${v.name}`, "dateField must be a date field"); }
    if (v.filter) checkExpr(`view ${v.name}`, v.filter, t);
  }
  const catalog = {
    space: "kit", types: Object.fromEntries(kit.types.map((t) => [t.name, t])),
    actions: { "records.read": { risk: "read" }, "records.create": { risk: "write" }, "records.update": { risk: "write" }, "records.remove": { risk: "outward.delete" }, "ask.request": { risk: "write" }, "model.call": { risk: "read" }, "http.request": { risk: "outward.send" }, "fn.run": { risk: "write" }, "email.send": { risk: "outward.send" }, "email.draft": { risk: "write" } },
    roles: [...CORE_ROLES, ...kit.roles.filter((r) => r.kind === "role").map((r) => r.name)],
    teammates: kit.roles.filter((r) => r.kind === "teammate").map((r) => r.name),
    templates: kit.templates.map((t) => t.name),
  };
  for (const fl of kit.flows) { const r = compileFlow(fl, catalog); if (!r.ok) err(`flow ${fl.name}`, r.errors.map((e) => `${e.path || "flow"}: ${e.message}`).join("; ")); }
  return kit;
}

/** @param {string} source @returns {StoredKit} */
export function compile(source) { return evaluate(parse(source)); }
/** Same, with the parse in a worker that has a memory ceiling and a time limit. @param {string} source */
export async function compileSafely(source) { return evaluate(await parseSafely(source)); }

/**
 * Check a stored kit that did not come from text (the visual builder): print it and compile the
 * text, so one set of rules judges both forms. Returns the canonical stored form.
 * @param {any} stored
 */
export function validateStored(stored) { return compile(print(stored)); }
