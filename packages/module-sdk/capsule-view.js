// @ts-check
// The Capsule's `view:` entries in shows.capsule (ADR 0033: declarative first, code second).
// A module says what a command lists, opens and does; vyred reads it, calls the module's own
// tools, and the Capsule draws small fixed frames. Nothing from a module runs in the Capsule.
// This file only checks the declaration; core/capsule builds the frames.

/** SF Symbol names a module may name for an icon; `app:<bundle id>` is allowed too. A module supplies data, never style. */
export const ICONS = new Set([
  "envelope", "envelope.open", "calendar", "clock", "folder", "doc", "doc.text", "doc.on.doc", "note.text", "key", "lock", "lock.open",
  "person", "person.2", "person.crop.circle", "link", "magnifyingglass", "star", "bell", "bolt", "bookmark", "chevron.right", "cloud", "gear",
  "globe", "house", "tray", "paperplane", "pencil", "trash", "tag", "terminal", "arrow.up.right.square", "checkmark.circle", "exclamationmark.triangle",
  "list.bullet", "square.and.arrow.up", "photo", "play", "creditcard", "chart.bar", "briefcase", "building.2", "phone", "message", "bubble.left",
  "curlybraces", "hammer", "wand.and.stars", "sparkles", "shippingbox", "cart", "map", "mappin", "flag", "heart", "eye", "camera", "mic", "wifi",
  "battery.100", "square.stack", "rectangle.stack", "text.alignleft", "number", "dollarsign.circle", "percent", "wrench", "scissors", "printer",
]);

/** The fixed things a template may name; an unknown name fills as an empty string, never an error. */
export const TEMPLATE_ROW = ["id", "title", "subtitle", "accessory", "url", "icon", "group"];
export const TEMPLATE_FRONT = ["front.app", "front.selection"];

/** What a finished `do` may be. */
export const EFFECTS = ["open", "copy", "say", "ask", "push"];
export const FIELD_TYPES = ["text", "multiline", "choice", "bool", "number"];

const ID = /^[a-z][a-z0-9-]{0,30}$/;
const KEYWORD = /^[a-z0-9][a-z0-9 -]{0,29}$/i;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,19}$/;
const TOOL = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/;
const SHORTCUT = /^((cmd|shift)\+){1,2}[a-z0-9]$/;
const isObj = (/** @type {any} */ v) => v && typeof v === "object" && !Array.isArray(v);

/** @param {any} v */
const iconProblem = v => (typeof v === "string" && (ICONS.has(v) || /^app:[A-Za-z0-9][A-Za-z0-9.-]{2,120}$/.test(v)) ? "" : `icon ${JSON.stringify(v)} is not on the icon list (a system symbol name, or app:<bundle id>)`);

/**
 * @param {string} at @param {any} map
 * @param {string[]} keys the map's allowed keys
 * @param {string[]} out
 */
function checkMap(at, map, keys, out) {
  if (map === undefined) return;
  if (!isObj(map)) { out.push(`${at}.map must be an object of dotted paths`); return; }
  for (const [k, v] of Object.entries(map)) {
    if (!keys.includes(k)) out.push(`${at}.map.${k} is not one of ${keys.join(", ")}`);
    else if (k === "fields") {
      if (!Array.isArray(v) || v.some(f => !isObj(f) || typeof f.label !== "string" || typeof f.path !== "string")) out.push(`${at}.map.fields must be a list of { label, path }`);
    } else if (typeof v !== "string" || !/^[A-Za-z0-9_.$-]{1,120}$/.test(v)) out.push(`${at}.map.${k} must be a plain dotted path (no expressions)`);
  }
}

/**
 * @param {string} at @param {any} tool
 * @param {{ tools: Set<string>, allowed: Set<string>, firstParty: boolean }} c
 * @param {string[]} out
 */
function checkTool(at, tool, c, out) {
  if (typeof tool !== "string" || !TOOL.test(tool)) { out.push(`${at} must name a tool like module.verb`); return; }
  // An added module reaches its own tools, and the ones it listed in needs.tools; a first party module its own.
  if (!c.tools.has(tool) && !(c.allowed.has(tool))) out.push(`${at} "${tool}" is not one of this module's tools${c.firstParty ? "" : " or its needs.tools"}`);
}

/**
 * @param {string} at @param {any} a
 * @param {{ tools: Set<string>, allowed: Set<string>, firstParty: boolean, forms: Set<string> }} c
 * @param {string[]} out
 */
function checkAction(at, a, c, out) {
  if (!isObj(a)) { out.push(`${at} must be an object`); return; }
  if (typeof a.id !== "string" || !ID.test(a.id)) out.push(`${at}.id must be lowercase letters, digits and dashes`);
  if (typeof a.title !== "string" || !a.title || a.title.length > 60) out.push(`${at}.title needs up to 60 characters`);
  if (a.shortcut !== undefined && (typeof a.shortcut !== "string" || !SHORTCUT.test(a.shortcut))) out.push(`${at}.shortcut must be a Command or Shift chord like "cmd+r" or "cmd+shift+r"; Option and Control stay free`);
  for (const f of ["confirm", "outward"]) if (a[f] !== undefined && typeof a[f] !== "boolean") out.push(`${at}.${f} must be true or false`);
  const kinds = ["do", "tool", "form"].filter(k => a[k] !== undefined);
  if (kinds.length !== 1) { out.push(`${at} needs exactly one of do, tool or form`); return; }
  if (a.do !== undefined) {
    if (!isObj(a.do) || Object.keys(a.do).length !== 1 || !EFFECTS.includes(Object.keys(a.do)[0])) out.push(`${at}.do must be one of ${EFFECTS.join(", ")}`);
    else if (typeof Object.values(a.do)[0] !== "string") out.push(`${at}.do.${Object.keys(a.do)[0]} must be a string template`);
    if (a.outward) out.push(`${at}: outward is for a tool or a form; a do effect sends nothing`);
  }
  if (a.tool !== undefined) { checkTool(`${at}.tool`, a.tool, c, out); if (a.input !== undefined && !isObj(a.input)) out.push(`${at}.input must be an object`); }
  if (a.form !== undefined && (typeof a.form !== "string" || !c.forms.has(a.form))) out.push(`${at}.form "${a.form}" is not one of this command's forms`);
}

/**
 * @param {string} at @param {any} f
 * @param {{ tools: Set<string>, allowed: Set<string>, firstParty: boolean }} c
 * @param {string[]} out
 */
function checkForm(at, f, c, out) {
  if (!isObj(f)) { out.push(`${at} must be an object`); return; }
  if (typeof f.title !== "string" || !f.title) out.push(`${at}.title is required`);
  if (!Array.isArray(f.fields) || !f.fields.length || f.fields.length > 12) out.push(`${at}.fields needs 1 to 12 fields`);
  else {
    const names = new Set();
    for (const [i, x] of f.fields.entries()) {
      if (!isObj(x) || typeof x.name !== "string" || !/^[a-z][a-zA-Z0-9_]{0,30}$/.test(x.name)) { out.push(`${at}.fields[${i}].name must be a word`); continue; }
      if (names.has(x.name)) out.push(`${at}.fields "${x.name}" is declared twice`);
      names.add(x.name);
      if (typeof x.label !== "string" || !x.label) out.push(`${at}.fields "${x.name}" needs a label`);
      if (!FIELD_TYPES.includes(x.type)) out.push(`${at}.fields "${x.name}" type must be one of ${FIELD_TYPES.join(", ")}`);
      if (x.type === "choice" && (!Array.isArray(x.choices) || !x.choices.length || x.choices.length > 30 || x.choices.some((/** @type {any} */ v) => typeof v !== "string"))) out.push(`${at}.fields "${x.name}" needs choices (up to 30 strings)`);
    }
  }
  if (!isObj(f.submit)) { out.push(`${at}.submit is required`); return; }
  if (typeof f.submit.title !== "string" || !f.submit.title) out.push(`${at}.submit.title is required`);
  checkTool(`${at}.submit.tool`, f.submit.tool, c, out);
  if (f.submit.input !== undefined && !isObj(f.submit.input)) out.push(`${at}.submit.input must be an object`);
  if (f.submit.outward !== undefined && typeof f.submit.outward !== "boolean") out.push(`${at}.submit.outward must be true or false`);
}

/**
 * Check one `view:<id>` entry.
 * @param {string} key the manifest key, `view:<id>` @param {any} e
 * @param {{ tools: Set<string>, allowed: Set<string>, firstParty: boolean }} c
 * @returns {string[]}
 */
export function checkView(key, e, c) {
  /** @type {string[]} */ const out = [];
  const at = `shows.capsule "${key}"`;
  if (!ID.test(key.slice(5))) return [`${at}: the id after "view:" must be lowercase letters, digits and dashes`];
  if (!isObj(e)) return [`${at} must be an object`];
  if (typeof e.title !== "string" || !e.title || e.title.length > 60) out.push(`${at}.title needs up to 60 characters`);
  if (e.keywords !== undefined && (!Array.isArray(e.keywords) || e.keywords.length > 10 || e.keywords.some((/** @type {any} */ k) => typeof k !== "string" || !KEYWORD.test(k)))) out.push(`${at}.keywords must be up to 10 short words`);
  if (e.alias !== undefined && (typeof e.alias !== "string" || !ALIAS.test(e.alias))) out.push(`${at}.alias must be lowercase letters, digits and dashes, up to 20`);
  if (e.icon !== undefined) { const p = iconProblem(e.icon); if (p) out.push(`${at}.${p}`); }
  if (e.root !== undefined && typeof e.root !== "boolean") out.push(`${at}.root must be true or false`);
  if (e.arg !== undefined && (!isObj(e.arg) || typeof e.arg.name !== "string" || !/^[a-z][a-zA-Z0-9_]{0,30}$/.test(e.arg.name) || (e.arg.placeholder !== undefined && (typeof e.arg.placeholder !== "string" || e.arg.placeholder.length > 60)))) out.push(`${at}.arg must be { name, placeholder? }`);
  const forms = isObj(e.forms) ? e.forms : {};
  if (e.forms !== undefined && !isObj(e.forms)) out.push(`${at}.forms must be an object of forms`);
  const fc = { ...c, forms: new Set(Object.keys(forms)) };
  for (const [name, f] of Object.entries(forms)) { if (!ID.test(name)) out.push(`${at}.forms "${name}" must be lowercase letters, digits and dashes`); checkForm(`${at}.forms.${name}`, f, c, out); }
  if ((e.list === undefined) === (e.form === undefined)) out.push(`${at} needs exactly one of list or form`);
  if (e.form !== undefined && (typeof e.form !== "string" || !fc.forms.has(e.form))) out.push(`${at}.form "${e.form}" is not one of its forms`);
  if (e.list !== undefined) {
    const l = e.list, la = `${at}.list`;
    if (!isObj(l)) out.push(`${la} must be an object`);
    else {
      checkTool(`${la}.tool`, l.tool, c, out);
      if (l.input !== undefined && !isObj(l.input)) out.push(`${la}.input must be an object`);
      checkMap(la, l.map, ["rows", "id", "title", "subtitle", "accessory", "icon", "group", "url"], out);
      if (l.empty !== undefined && (typeof l.empty !== "string" || l.empty.length > 200)) out.push(`${la}.empty must be a short sentence`);
      if (l.detail !== undefined) {
        if (!isObj(l.detail)) out.push(`${la}.detail must be an object`);
        else { checkTool(`${la}.detail.tool`, l.detail.tool, c, out); checkMap(`${la}.detail`, l.detail.map, ["title", "body", "fields"], out); }
      }
      if (l.actions !== undefined) {
        if (!Array.isArray(l.actions) || l.actions.length > 12) out.push(`${la}.actions must be a list of up to 12 actions`);
        else { const ids = new Set(); for (const [i, a] of l.actions.entries()) { checkAction(`${la}.actions[${i}]`, a, fc, out); if (a && ids.has(a.id)) out.push(`${la}.actions "${a.id}" is declared twice`); ids.add(a && a.id); } }
      }
    }
  }
  return out;
}

/**
 * Check every `view:` key of a manifest's shows.capsule (the older results: and action: keys are checked by the schema).
 * @param {any} capsule shows.capsule @param {{ tools: Set<string>, needsTools: Set<string>, firstParty: boolean, moduleName: string }} c
 * @returns {string[]}
 */
export function checkCapsuleShows(capsule, c) {
  if (!isObj(capsule)) return [];
  /** @type {string[]} */ const out = [];
  const ids = new Set();
  for (const [key, entry] of Object.entries(capsule)) {
    if (!key.startsWith("view:")) continue;
    const allowed = c.firstParty ? new Set() : c.needsTools;
    out.push(...checkView(key, entry, { tools: c.tools, allowed, firstParty: c.firstParty }));
    if (ids.has(key)) out.push(`shows.capsule "${key}" is declared twice`);
    ids.add(key);
  }
  return out;
}
