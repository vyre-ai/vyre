// @ts-check
// roles: a custom role's stored shape, its checks, and its expansion into grants. No new authorization model: a role is a named bundle of ordinary kernel grants (source `role:<id>`), built here from
// the fixed catalogue, then judged again by the kernel on assignment (it refuses any action outside the base role's bundle). Pure functions: no store, no kernel call, so each rule is tested alone.
import { ROLE_ACTIONS } from "../../kernel/grants/roles.js";
import { CAN, CAN_BY_ID, WHERE_KINDS, ACCESS_LEVELS, CUSTOM_BASES, RESERVED_IDS, TOOL_IDS } from "./catalogue.js";

const refuse = (/** @type {string} */ message, /** @type {string} */ code = "bad_input") => Object.assign(new Error(message), { code });
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const isObj = (/** @type {any} */ x) => x !== null && typeof x === "object" && !Array.isArray(x);
const list = (/** @type {string[]} */ xs) => xs.map(x => `"${x}"`).join(", ");

/** The id a label makes: lowercase words joined by dashes. */
export const slug = (/** @type {string} */ label) => String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31).replace(/-+$/, "");

/**
 * Check a role as typed and return it in stored form. `types` is the Space's record types ({ name, fields: [{ name }] }) so a type or field that does not exist is refused in words.
 * @param {any} input @param {{ types?: any[], now?: number }} [o]
 */
export function checkRole(input, o = {}) {
  if (!isObj(input)) throw refuse("A role is { label, base, can, where, data, hidden_fields, tools, ends }.");
  const now = o.now ?? Date.now();
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || label.length > 60) throw refuse("A role needs a name of 1 to 60 characters.");
  const id = input.id === undefined ? slug(label) : String(input.id);
  if (!ID_RE.test(id)) throw refuse("A role's id is lowercase letters, digits and dashes, starting with a letter (2 to 31 characters). Leave it out and it is made from the name.");
  if (RESERVED_IDS.includes(id)) throw refuse(`"${id}" is one of the built-in roles. Pick another name.`);
  const description = input.description === undefined ? "" : String(input.description).slice(0, 300);

  const base = input.base;
  if (!CUSTOM_BASES.includes(base)) throw refuse(base === "owner" || base === "admin" ? "A custom role starts from Member. Nothing above Member is a custom role: an Admin-based role would still count as an Admin for adding people and giving roles." : base === "guest" || base === "temp"
    ? "A custom role starts from Member or Admin. For someone who needs an end date, give this role an end date, or add them as a Guest."
    : `A custom role starts from Member.`);

  const can = Array.isArray(input.can) ? [...new Set(input.can.map(String))] : null;
  if (!can || !can.length) throw refuse("Pick at least one thing the role can do (can).");
  for (const c of can) {
    const e = CAN_BY_ID[/** @type {"view"} */ (c)];
    if (!Object.hasOwn(CAN_BY_ID, c) || !e) throw refuse(`"${c}" is not something a role can do. The choices are ${list(CAN.map(x => x.id))}.`);
    if (e.actions.some(a => !ROLE_ACTIONS[/** @type {"member"} */ (base)].includes(a))) throw refuse(`"${e.label}" is wider than a role that starts from Member. Take it out: a role that needs it is an Admin, which is a built-in role.`, "too_wide");
  }
  can.sort();

  const w = input.where === undefined ? { kind: "space" } : input.where;
  if (!isObj(w) || !WHERE_KINDS.includes(w.kind)) throw refuse(`where is { kind: ${list([...WHERE_KINDS])} }.`);
  const where = /** @type {{ kind: string, projects?: string[] }} */ ({ kind: w.kind });
  if (w.kind === "projects") {
    if (!Array.isArray(w.projects) || !w.projects.length || w.projects.length > 100 || w.projects.some((/** @type {any} */ p) => typeof p !== "string" || !p || p.length > 120)) throw refuse("Name the projects (where.projects): 1 to 100 project ids.");
    where.projects = [...new Set(/** @type {string[]} */ (w.projects))].sort();
  } else if (w.projects !== undefined) throw refuse(`where.projects is only for kind "projects".`);

  const typeFields = new Map((o.types || []).map(t => [String(t.name), new Set((t.fields || []).map((/** @type {any} */ f) => String(f.name)))]));
  /** @type {Record<string, string>} */ const data = {};
  if (input.data !== undefined) {
    if (!isObj(input.data)) throw refuse("data is { <type>: none | read | edit }.");
    for (const [t, lv] of Object.entries(input.data)) {
      if (!ACCESS_LEVELS.includes(/** @type {string} */ (lv))) throw refuse(`data.${t} is ${list([...ACCESS_LEVELS])}.`);
      if (o.types && !typeFields.has(t)) throw refuse(`There is no record type "${t}" in this Space. Check the type list (records.types).`);
      if (lv !== "none" && !can.includes("view")) throw refuse(`data.${t} gives access to ${t} records, so turn on "See things" (view) first.`);
      data[t] = /** @type {string} */ (lv);
    }
  }
  /** @type {Record<string, string[]>} */ const hidden = {};
  if (input.hidden_fields !== undefined) {
    if (!isObj(input.hidden_fields)) throw refuse("hidden_fields is { <type>: [field names] }.");
    for (const [t, fs] of Object.entries(input.hidden_fields)) {
      if (!Array.isArray(fs) || !fs.length) continue;
      if (!data[t] || data[t] === "none") throw refuse(`Say how much of ${t} the role may reach (data.${t}: read or edit) before hiding its fields.`);
      const names = [...new Set(fs.map(String))].sort();
      const have = typeFields.get(t);
      if (have) { const bad = names.find(f => !have.has(f)); if (bad) throw refuse(`${t} has no field "${bad}".`); if (names.length >= have.size) throw refuse(`A role cannot hide every field of ${t}. Set data.${t} to "none" instead.`); }
      hidden[t] = names;
    }
  }

  const tools = input.tools === undefined ? [] : Array.isArray(input.tools) ? [...new Set(input.tools.map(String))].sort() : null;
  if (!tools || tools.some(t => !TOOL_IDS.includes(t))) throw refuse(`tools are some of ${list([...TOOL_IDS])}.`);

  let ends = null;
  if (input.ends !== undefined && input.ends !== null) {
    if (!Number.isInteger(input.ends) || input.ends <= now) throw refuse("A role's end date (ends) is a time in the future, in milliseconds.");
    ends = input.ends;
  }
  return { id, label, description, base, can, where, data, hidden_fields: hidden, tools, ends };
}

/** The record actions a level gives on a type, never more than `can` allows. */
function levelActions(/** @type {string} */ level, /** @type {string[]} */ can) {
  if (level === "none") return [];
  const out = new Set(["records.read"]);
  if (level === "edit") for (const [c, as] of [["create", ["records.create"]], ["edit", ["records.update", "seal.put"]], ["delete", ["records.remove", "records.restore"]]]) if (can.includes(/** @type {string} */ (c))) for (const a of /** @type {string[]} */ (as)) out.add(a);
  return [...out].sort();
}
const isRecordAction = (/** @type {string} */ a) => a.startsWith("records.") || a.startsWith("seal.");
/** Actions that name a row with attributes (a project, a maker), so a where limit can judge them. The rest (memory, Flows, the drive, rules...) have none and are given for the whole Space. */
const isRowAction = (/** @type {string} */ a) => a.startsWith("tasks.") || a === "project.reach";

/**
 * Expand a stored role for one person into grant inputs the kernel makes (kernel/grants applyRole `custom`). Merges grants that say the same thing about the same place.
 * @param {any} role a checked role @param {{ space: string, person: string, types?: any[] }} who @returns {{ actions: string[], resource: { prefix: string, where?: any[], fields?: string[] }, conditions?: any }[]}
 */
export function expandRole(role, who) {
  const all = `vyre://${who.space}/*/*`;
  const can = /** @type {string[]} */ (role.can);
  const actions = [...new Set(can.flatMap(c => [...CAN_BY_ID[/** @type {"view"} */ (c)].actions]))].sort();
  const pred = role.where.kind === "projects" ? [{ attr: "project", op: "in", value: [...role.where.projects] }] : role.where.kind === "mine" ? [{ attr: "created_by", op: "eq", value: `person:${who.person}` }] : [];
  const cond = role.ends ? { conditions: { when: { expires: role.ends } } } : {};
  /** @type {Map<string, any>} */ const out = new Map();
  const add = (/** @type {string[]} */ as, /** @type {string} */ prefix, /** @type {any[]} */ where, /** @type {string[] | undefined} */ fields) => {
    if (!as.length) return;
    const key = JSON.stringify([prefix, where, fields || null]);
    const have = out.get(key);
    if (have) have.actions = [...new Set([...have.actions, ...as])].sort();
    else out.set(key, { actions: [...as].sort(), resource: { prefix, ...(where.length ? { where } : {}), ...(fields ? { fields } : {}) }, ...cond });
  };
  add(actions.filter(a => !isRecordAction(a) && !isRowAction(a)), all, [], undefined);
  add(actions.filter(isRowAction), all, pred, undefined);
  const hasData = Object.keys(role.data || {}).length > 0;
  // a record being made has no maker yet, so "only what they made" cannot judge a create: they may make one anywhere, and it is theirs afterwards
  const free = (/** @type {string} */ a) => role.where.kind === "mine" && a === "records.create";
  if (!hasData) { add(actions.filter(a => isRecordAction(a) && free(a)), all, [], undefined); add(actions.filter(a => isRecordAction(a) && !free(a)), all, pred, undefined); }
  else {
    const fieldsOf = new Map((who.types || []).map(t => [String(t.name), (t.fields || []).map((/** @type {any} */ f) => String(f.name))]));
    for (const [t, level] of Object.entries(/** @type {Record<string, string>} */ (role.data))) {
      const hide = role.hidden_fields[t];
      let fields;
      if (hide && hide.length) {
        const have = fieldsOf.get(t);
        if (!have) throw refuse(`Cannot hide fields of ${t}: the Space has no record type with that name.`);
        fields = have.filter((/** @type {string} */ f) => !hide.includes(f));
        if (!fields.length) throw refuse(`A role cannot hide every field of ${t}.`);
      }
      const la = levelActions(level, can);
      add(la.filter(free), `vyre://${who.space}/${t}/*`, [], fields);
      add(la.filter(a => !free(a)), `vyre://${who.space}/${t}/*`, pred, fields);
    }
  }
  const grants = [...out.values()];
  if (!grants.length) throw refuse("This role gives no access: pick at least one thing it can do and, if it names record types, one that is not \"none\".");
  const base = ROLE_ACTIONS[/** @type {"member"} */ (role.base)];
  for (const g of grants) { const bad = g.actions.find((/** @type {string} */ a) => !base.includes(a)); if (bad) throw refuse(`"${bad}" is wider than this role's base. Take it out.`, "too_wide"); }
  return grants;
}
