// @ts-check
// Where each setting lives. A store reads and writes one level (account or project) of one key,
// and never decides precedence: index.js does that. Keys keep the stores they had before this
// module existed (config.json, another module's tool, Claude Code's own files), so nothing moves.
//
//   values(key)          settings_values, this module's own table, for keys that had no home
//   config(path)         ~/.vyre/config.json, account only
//   tool(get, set)       another module's tool, called as the person who asked
//   claude(path)         Claude Code's settings files, so the terminal sees the same thing:
//                        account ~/.claude/settings.json, project <home>/.claude/settings.local.json

import fs from "node:fs";
import path from "node:path";
import * as config from "../config/index.js";

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

/** Read a JSON file, {} when it is missing. A broken file is an error: never write over it. @param {string} file */
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return {}; throw e; }
  try { return JSON.parse(text); } catch { throw Object.assign(new Error(`${file} is not valid JSON; fix it by hand first`), { code: "unreadable" }); }
}

/** @param {string} file @param {any} data */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * @typedef {{ db: import("node:sqlite").DatabaseSync, root: string, live: any, call: (tool: string, input: any, as?: string) => Promise<any>,
 *   claudeDir: () => string, projectHome: (slug: string) => Promise<string|null> }} Env
 * @typedef {"account"|"project"} Level
 * @typedef {{ kind: string, levels?: Level[], read(env: Env, level: Level, project: string|null, key: string): Promise<any>,
 *   write(env: Env, level: Level, project: string|null, key: string, value: any, as: string, by: string): Promise<void> }} Store
 */

const scopeOf = (/** @type {Level} */ level, /** @type {string|null} */ project) => (level === "project" ? `project:${project}` : "account");

/** This module's own table. @returns {Store} */
export const values = () => ({
  kind: "vyre",
  async read(env, level, project, key) {
    const row = /** @type {any} */ (env.db.prepare("SELECT value FROM settings_values WHERE scope = ? AND key = ?").get(scopeOf(level, project), key));
    return row ? JSON.parse(String(row.value)) : undefined;
  },
  async write(env, level, project, key, value, _as, by) {
    const scope = scopeOf(level, project);
    if (value === undefined) env.db.prepare("DELETE FROM settings_values WHERE scope = ? AND key = ?").run(scope, key);
    else env.db.prepare(`INSERT INTO settings_values (scope, key, value, by, at) VALUES (?,?,?,?,?)
      ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, by = excluded.by, at = excluded.at`).run(scope, key, JSON.stringify(value), by, Date.now());
  },
});

/** A key in config.json. Account only. @param {string} p @returns {Store} */
export const cfg = p => ({
  kind: "config", levels: ["account"],
  async read(env) {
    let user;
    try { user = JSON.parse(fs.readFileSync(config.paths(env.root).config, "utf8")); } catch { user = {}; }
    return dig(user, p);
  },
  async write(env, _level, _project, _key, value) {
    const keys = p.split(".");
    let user = {};
    try { user = JSON.parse(fs.readFileSync(config.paths(env.root).config, "utf8")); } catch {}
    // config.save merges one level deep and drops a second-level key set to null, so hand it the
    // whole section, already changed, with a removed second-level key spelled as null.
    if (keys.length === 1) return void config.save({ [p]: value === undefined ? null : value }, env.root, env.live);
    const top = put(user[keys[0]], keys.slice(1), value);
    if (!Object.keys(top).length) return void config.save({ [keys[0]]: null }, env.root, env.live);
    for (const k of Object.keys(user[keys[0]] || {})) if (!(k in top)) top[k] = null;
    config.save({ [keys[0]]: top }, env.root, env.live);
  },
});

/**
 * Another module's tool. get(level, project) gives {tool, input, pick(data)}; set gives
 * {tool, input}. The owning module keeps its validation and its events.
 * @param {{ levels?: Level[], get: (level: Level, project: string|null) => { tool: string, input: any, pick: (d: any) => any },
 *   set: (level: Level, project: string|null, value: any) => { tool: string, input: any } }} o
 * @returns {Store}
 */
export const tool = o => ({
  kind: "tool", levels: o.levels,
  async read(env, level, project) {
    const g = o.get(level, project);
    // Reading another module's settings is harmless, and its tool may be open to people only.
    const r = await env.call(g.tool, g.input, "local");
    if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code === "no_such_tool" ? "unavailable" : r.error.code });
    return g.pick(r.data);
  },
  async write(env, level, project, _key, value, as) {
    const s = o.set(level, project, value);
    const r = await env.call(s.tool, s.input, as);
    if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code === "no_such_tool" ? "unavailable" : r.error.code });
  },
});

/** The file a Claude Code setting lives in at this level. @param {Env} env @param {Level} level @param {string|null} project */
export async function claudeFile(env, level, project) {
  if (level === "account") return path.join(env.claudeDir(), "settings.json");
  const home = project ? await env.projectHome(project) : null;
  if (!home) throw Object.assign(new Error(`no project ${project}`), { code: "not_found" });
  return path.join(home, ".claude", "settings.local.json");
}

/** A key in Claude Code's settings files. @param {string} p @returns {Store} */
export const claude = p => ({
  kind: "claude",
  async read(env, level, project) { return dig(readJson(await claudeFile(env, level, project)), p); },
  async write(env, level, project, _key, value) {
    const file = await claudeFile(env, level, project);
    writeJson(file, put(readJson(file), p.split("."), value));
  },
});
