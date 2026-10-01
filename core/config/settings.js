// @ts-check
// Settings, the kernel part: the shape a module declares its settings in (module.json
// "settings"), how a value is checked, where it is kept, and which level wins. It holds no
// settings of its own. Each module declares its keys; the settings module (core/settings) serves
// them as tools, reading declarations only from running modules, so a module switched off takes
// its rows with it.
//
// A declaration:
//   { key: "<module>.<name>", group, label, help?, type, enum?, choices?, min?, max?, default?,
//     levels: any of "account", "project", "device", "session" (ADR 0035), apply: "live"|"session"|"restart",
//     advanced?, security?: "loosens", confirm?: true | { values: [...] }, loosens?: "<what>",
//     store?: StoreDecl }
// Stores (StoreDecl), all declarative so a module in <home>/modules can use them too:
//   omitted                  settings_values, one row per scope and key
//   { config: "a.b.c" }      ~/.vyre/config.json, account only
//   { claude: "a.b" }        Claude Code's settings files, so the terminal sees the same value:
//                            account ~/.claude/settings.json, project <home>/.claude/settings.local.json
//   { tool: { get: { tool, input, read }, set: { tool, input } } }
//                            the module's own tool. "$value" (a whole string) is the value,
//                            "$project" inside a string is the project's slug, "$session" the thread's.
// A narrower level wins: session > device > project > account > default. A device's value lives
// in the hub (no store); a session's lives with the thread, in the module's own tools.

import fs from "node:fs";
import path from "node:path";
import * as config from "./index.js";

export const TYPES = ["enum", "bool", "int", "number", "string", "list", "object", "model"];
const LEVELS = ["account", "project", "device", "session"];
const APPLY = ["live", "session", "restart"];

/**
 * Problems with a module's declared settings; empty means valid. A module from outside Vyre
 * (firstParty false, the default) keeps its settings inside its own rows: a person's change to a
 * setting carries the person's authority, so its store may not reach past the module (ADR 0033).
 * A tool store names only the module's own tools (called as the settings module, never the
 * person), a config.json path starts with "<module>.", and Claude Code's files are refused.
 * @param {string} module @param {any} list @param {{ firstParty?: boolean, tools?: any[] }} [opts]
 */
export function validateDecls(module, list, { firstParty = false, tools = [] } = {}) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ["settings must be a list"];
  // A manifest's tools are names or { name, reach, ... } entries; only the names matter here.
  tools = tools.map(t => (t && typeof t === "object" ? /** @type {any} */ (t).name : t));
  const out = [], seen = new Set();
  for (const d of list) {
    const k = d && d.key;
    if (typeof k !== "string" || !k.startsWith(module + ".") || !/^[a-z][a-z0-9_.-]*$/.test(k)) { out.push(`setting "${k}" must start with "${module}."`); continue; }
    if (seen.has(k)) out.push(`setting ${k} is declared twice`);
    seen.add(k);
    if (!TYPES.includes(d.type)) out.push(`setting ${k}: type must be one of ${TYPES.join(", ")}`);
    if (!Array.isArray(d.levels) || !d.levels.length || d.levels.some(l => !LEVELS.includes(l))) out.push(`setting ${k}: levels must be some of account, project, device and session`);
    // ADR 0035: a device's value changes how a surface looks, never what Claude may do, and a
    // session value is a thread's chip, which only a module's own tool store keeps.
    if (Array.isArray(d.levels) && d.levels.includes("device") && (d.confirm !== undefined || d.security !== undefined)) out.push(`setting ${k}: a setting with confirm or security may not be set per device`);
    if (Array.isArray(d.levels) && d.levels.includes("session") && !(d.store && typeof d.store === "object" && d.store.tool !== undefined)) out.push(`setting ${k}: the session level needs a store in this module's own tools`);
    // check and choicesFrom name one of the module's own tools, first-party or not.
    for (const f of ["check", "choicesFrom"]) {
      if (d[f] === undefined) continue;
      const t = d[f] && typeof d[f] === "object" ? d[f].tool : undefined;
      if (typeof t !== "string" || !t.startsWith(module + ".") || (tools.length && !tools.includes(t))) out.push(`setting ${k}: ${f}.tool must be one of ${module}'s own tools`);
    }
    if (d.choices !== undefined && !(Array.isArray(d.choices) && d.choices.every(n => typeof n === "number"))) out.push(`setting ${k}: choices is a list of numbers; a tool goes in choicesFrom`);
    if (Array.isArray(d.levels) && d.levels.includes("device") && d.store !== undefined) out.push(`setting ${k}: a device's value is kept in the hub, so a setting set per device has no store`);
    if (!APPLY.includes(d.apply)) out.push(`setting ${k}: apply must be live, session or restart`);
    if (typeof d.label !== "string" || !d.label) out.push(`setting ${k}: needs a label`);
    if (d.secret !== undefined && typeof d.secret !== "boolean") out.push(`setting ${k}: secret is true or false`);
    // Words for an enum's values, shown instead of the raw value: only values the enum has.
    if (d.labels !== undefined && (!d.labels || typeof d.labels !== "object" || Array.isArray(d.labels) || d.type !== "enum"
      || Object.entries(d.labels).some(([v, l]) => !(d.enum || []).includes(v) || typeof l !== "string" || !l))) out.push(`setting ${k}: labels names words for its enum's values`);
    const s = d.store;
    if (s !== undefined) {
      const kinds = s && typeof s === "object" ? Object.keys(s) : [];
      if (kinds.length !== 1 || !["config", "claude", "tool"].includes(kinds[0])) out.push(`setting ${k}: store is {config}, {claude} or {tool}`);
      else if (kinds[0] === "config" && d.levels.includes("project")) out.push(`setting ${k}: a config.json setting is account only`);
      else if (kinds[0] === "tool" && !(s.tool.get && s.tool.set && s.tool.get.tool && s.tool.set.tool)) out.push(`setting ${k}: a tool store needs get.tool and set.tool`);
      else if (!firstParty) {
        if (kinds[0] === "claude") out.push(`setting ${k}: only Vyre's own modules may keep a setting in Claude Code's files`);
        if (kinds[0] === "config" && !String(s.config).startsWith(module + ".")) out.push(`setting ${k}: a config.json path must start with "${module}."`);
        if (kinds[0] === "tool") for (const side of ["get", "set"]) if (!tools.includes(s.tool[side].tool)) out.push(`setting ${k}: store.tool.${side} must be one of ${module}'s own tools`);
      }
    }
  }
  return out;
}

/** Read a dotted path out of an object. @param {any} o @param {string} p */
export const dig = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);

/** A copy of o with a dotted path set, or removed when v is undefined. @param {any} o @param {string[]} keys @param {any} v */
function put(o, keys, v) {
  const out = o && typeof o === "object" && !Array.isArray(o) ? { ...o } : {};
  const [k, ...rest] = keys;
  if (!rest.length) { if (v === undefined) delete out[k]; else out[k] = v; return out; }
  out[k] = put(out[k], rest, v);
  if (v === undefined && out[k] && !Object.keys(out[k]).length) delete out[k];
  return out;
}

/**
 * "$value", "$project" and "$session" filled into a tool store's input. `target` is the level's own
 * name: a project's slug at project level, a thread at session level.
 * @param {any} t @param {any} value @param {string|null} target @param {string} [level]
 */
function fill(t, value, target, level = target ? "project" : "account") {
  if (t === "$value") return value === undefined ? null : value;
  if (typeof t === "string") return t.split("$project").join(level === "project" ? String(target ?? "") : "").split("$session").join(level === "session" ? String(target ?? "") : "");
  if (Array.isArray(t)) return t.map(x => fill(x, value, target, level));
  if (t && typeof t === "object") return Object.fromEntries(Object.entries(t).map(([k, v]) => [fill(k, value, target, level), fill(v, value, target, level)]));
  return t;
}

/** A JSON file, {} when missing. A broken file is an error: never write over it. @param {string} file */
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return {}; throw e; }
  try { return JSON.parse(text); } catch { throw Object.assign(new Error(`${file} is not valid JSON; fix it by hand first`), { code: "unreadable" }); }
}

/** Write atomically, keeping a copy of the file as it was before Vyre first touched it. @param {string} file @param {any} data */
function writeClaude(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.vyre-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

const fault = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * Check a value against its declaration. Strings from the CLI are read as the type. undefined
 * means "remove".
 * @param {any} d @param {any} v
 */
export function coerce(d, v) {
  const bad = (/** @type {string} */ m) => { throw fault("bad_input", `${d.key}: ${m}`); };
  if (v === null || v === undefined) return undefined;
  switch (d.type) {
    case "bool":
      if (typeof v === "boolean") return v;
      if (["true", "on", "yes"].includes(v)) return true;
      if (["false", "off", "no"].includes(v)) return false;
      return bad("expected true or false");
    case "int": case "number": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (String(v).trim() === "" || !Number.isFinite(n) || (d.type === "int" && !Number.isInteger(n))) return bad(`expected ${d.type === "int" ? "a whole number" : "a number"}`);
      if (d.min !== undefined && n < d.min) return bad(`at least ${d.min}`);
      if (d.max !== undefined && n > d.max) return bad(`at most ${d.max}`);
      if (d.choices && !d.choices.includes(n)) return bad(`one of ${d.choices.join(", ")}`);
      return n;
    }
    case "enum":
      if (!d.enum || !d.enum.includes(String(v))) return bad(`one of ${(d.enum || []).join(", ")}`);
      return String(v);
    case "model":
      if (!/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/.test(String(v))) return bad("an alias like opus, sonnet or haiku, or a model id");
      return String(v);
    case "string":
      if (typeof v !== "string" || v.length > 4000) return bad("expected text");
      return v;
    case "list": {
      const list = Array.isArray(v) ? v : String(v).split(",").map(s => s.trim()).filter(Boolean);
      if (list.length > 500 || list.some(x => typeof x !== "string" || x.length > 500)) return bad("expected a list of text");
      return list;
    }
    case "object": {
      let o = v;
      if (typeof v === "string") { try { o = JSON.parse(v); } catch { return bad("expected JSON"); } }
      if (!o || typeof o !== "object" || Array.isArray(o)) return bad("expected an object");
      return o;
    }
  }
  return bad("unknown type");
}

/**
 * Does changing this key to this value need an explicit confirm? `before` is the level's value
 * now, for a list whose confirm is { drops: true }: taking an entry out (a reset takes them all)
 * lets Claude do more, so it asks. v undefined is a reset, which asks only for drops.
 * @param {any} d @param {any} v @param {any} [before]
 */
export function needsConfirm(d, v, before) {
  if (d.confirm && d.confirm.drops && Array.isArray(before)) {
    const next = (Array.isArray(v) ? v : []).map(x => JSON.stringify(x));
    if (before.some(x => !next.includes(JSON.stringify(x)))) return true;
  }
  if (v === undefined) return false;
  if (d.security === "loosens" || d.confirm === true) return true;
  return Boolean(d.confirm && Array.isArray(d.confirm.values) && d.confirm.values.includes(v));
}

/**
 * @typedef {{ db: import("node:sqlite").DatabaseSync, root: string, live: any, claudeDir: () => string,
 *   projectHome: (slug: string) => Promise<string|null>, call: (tool: string, input: any, as?: string) => Promise<any> }} Env
 * @typedef {"account"|"project"|"device"|"session"} Level
 */

/** The file a Claude Code setting lives in at this level. @param {Env} env @param {Level} level @param {string|null} project */
async function claudeFile(env, level, project) {
  if (level === "account") return path.join(env.claudeDir(), "settings.json");
  const home = project ? await env.projectHome(project) : null;
  if (!home) throw fault("not_found", `no project ${project}`);
  return path.join(home, ".claude", "settings.local.json");
}

const scopeOf = (/** @type {Level} */ level, /** @type {string|null} */ target) => (level === "account" ? "account" : `${level}:${target}`);

/** Read one level of one key. @param {Env} env @param {any} d @param {Level} level @param {string|null} project */
export async function read(env, d, level, project) {
  const s = d.store;
  if (!s) {
    const row = /** @type {any} */ (env.db.prepare("SELECT value FROM settings_values WHERE scope = ? AND key = ?").get(scopeOf(level, project), d.key));
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  if (s.config) {
    let user = {};
    try { user = JSON.parse(fs.readFileSync(config.paths(env.root).config, "utf8")); } catch {}
    return dig(user, s.config);
  }
  if (s.claude) return dig(readJson(await claudeFile(env, level, project)), s.claude);
  const g = s.tool.get;
  // Reading a module's own settings is harmless, and its tool may be open to people only. A module
  // from outside Vyre is never read as a person: its tool sees the settings module.
  const r = await env.call(g.tool, fill(g.input || {}, undefined, project, level), d.firstParty ? "local" : undefined);
  if (r && r.error) throw fault(r.error.code === "no_such_tool" ? "unavailable" : r.error.code, r.error.message);
  return g.read ? dig(r.data, fill(g.read, undefined, project, level)) : r.data;
}

/**
 * Write one level of one key (undefined removes it). `as` is the person's caller label, for a
 * tool store: the owning module's tool sees the person, not this module.
 * @param {Env} env @param {any} d @param {Level} level @param {string|null} project @param {any} value @param {string} as @param {string} by
 */
export async function write(env, d, level, project, value, as, by) {
  const s = d.store;
  if (!s) {
    const scope = scopeOf(level, project);
    if (value === undefined) env.db.prepare("DELETE FROM settings_values WHERE scope = ? AND key = ?").run(scope, d.key);
    else env.db.prepare(`INSERT INTO settings_values (scope, key, value, by, at) VALUES (?,?,?,?,?)
      ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, by = excluded.by, at = excluded.at`).run(scope, d.key, JSON.stringify(value), by, Date.now());
    return;
  }
  if (s.config) {
    const keys = s.config.split(".");
    let user = {};
    try { user = JSON.parse(fs.readFileSync(config.paths(env.root).config, "utf8")); } catch {}
    if (keys.length === 1) return void config.save({ [keys[0]]: value === undefined ? null : value }, env.root, env.live);
    // config.save merges one level deep and drops a second-level key set to null: hand it the
    // whole section, already changed, with removed second-level keys spelled as null.
    const top = put(user[keys[0]], keys.slice(1), value);
    if (!Object.keys(top).length) return void config.save({ [keys[0]]: null }, env.root, env.live);
    for (const k of Object.keys(user[keys[0]] || {})) if (!(k in top)) top[k] = null;
    return void config.save({ [keys[0]]: top }, env.root, env.live);
  }
  if (s.claude) {
    const file = await claudeFile(env, level, project);
    return void writeClaude(file, put(readJson(file), s.claude.split("."), value));
  }
  const t = s.tool.set;
  // Only Vyre's own modules' tools hear the person; any other module's tool sees the settings module.
  const r = await env.call(t.tool, fill(t.input || {}, value, project, level), d.firstParty ? as : undefined);
  if (r && r.error) throw fault(r.error.code === "no_such_tool" ? "unavailable" : r.error.code, r.error.message);
}

/** Where a change would land, for the "what changes" line before a Claude Code file is written. @param {Env} env @param {any} d @param {Level} level @param {string|null} project */
export async function whereIs(env, d, level, project) {
  const s = d.store;
  if (!s) return "hub.json";
  if (s.config) return `config.json ${s.config}`;
  if (s.claude) return `${await claudeFile(env, level, project)} ${s.claude}`;
  return s.tool.set.tool;
}
