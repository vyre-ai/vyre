// @ts-check
// Discovery: the MCP servers Claude Code already knows about, read (never written) from its own
// config, so a server the person set up for Claude Code shows up in Vyre without a manual
// `vyre connect add` (docs/design/mcp-native.md, gap 1).
//
// Three places name a server, same shape in all three: `{"mcpServers": {name: {...}}}`.
// - A project's `.mcp.json` (checked in, walked from cwd up to the filesystem root, same as a
//   person's own `claude` would find it: the nearest one per directory, all of them collected).
// - The user's `~/.claude.json`, top level: servers added with `--scope user`.
// - The same file's `projects["<abs project path>"].mcpServers`: `--scope local`, one project only.
// A plugin's own `.mcp.json` (named by its manifest, `${CLAUDE_PLUGIN_ROOT}` resolved to the
// plugin's own directory) is read the same way, listed separately so the caller can label it.
//
// This module never edits these files and never starts a server: it only reads and normalizes,
// and never a value: `normalize()` keeps env and header NAMES only, plus `hasSecrets`, never what
// they hold. Adding a discovered server still goes through `mcp.add`, which is how a value gets
// into the vault as a grant, never a bare env var copied out of someone's `.mcp.json`.
//
// Which home: never `os.homedir()` directly. `core/config`'s `claudeJson`/`claudeHome` decide
// whether `root` is the person's real `~/.vyre` (their real `~/.claude.json` and `~/.claude/
// plugins/`) or anything else (a fixture folder, empty until something puts one there).
//
// The path walk (home file, `.claude/settings*.json`-style directories from cwd to root, a
// project's `.mcp.json`) mirrors `core/harness/rules.js`'s `ccFile`/`hardLinked`, which walks the
// same set defensively (refusing a write to one). Kept separate on purpose: that file belongs to
// the floor and changing it for a second reason risks widening what it refuses; the walk itself is
// small enough that duplicating it here is cheaper than a shared dependency neither module needs
// otherwise. If the floor moves this walk into its own export later, this file should switch to it.

import fs from "node:fs";
import path from "node:path";
import { claudeHome, claudeJson } from "../config/dialogs.js";

export const TRANSPORTS = ["stdio", "http", "sse"];
/** A discovered name may collide with an already-added one; both are kept, told apart by source. */
export const SOURCES = ["user", "project", "local", "plugin"];

/**
 * One entry of a `mcpServers` object, normalized to the hub's own shape (core/mcp/hub.js `add`),
 * MINUS every value: `env` and `headers` in a person's `.mcp.json` or `.claude.json` are exactly
 * where a bearer token or an API key lives in plain text, so this keeps only their NAMES
 * (`envNames`, `headerNames`) and a `hasSecrets` flag (e2e review, 2026-09-28). No tool, event or
 * log built on this file's output may ever carry a value; adding a discovered server still goes
 * through `mcp.add`, which is how a value gets into the vault as a grant.
 * An entry this cannot make sense of (no command and no url, or an explicit unknown `type`) is
 * dropped, not thrown: one bad entry in a person's `.mcp.json` should not hide the rest.
 * @param {string} name @param {any} v
 * @returns {{ name: string, transport: string, command?: string, args?: string[], cwd?: string,
 *   envNames?: string[], url?: string, headerNames?: string[], hasSecrets?: boolean } | null}
 */
function normalize(name, v) {
  if (!v || typeof v !== "object") return null;
  const type = typeof v.type === "string" ? v.type : (typeof v.url === "string" ? "http" : "stdio");
  if (!TRANSPORTS.includes(type)) return null;
  if (type === "stdio") {
    if (typeof v.command !== "string" || !v.command) return null;
    /** @type {any} */
    const out = { name, transport: "stdio", command: v.command };
    if (Array.isArray(v.args)) out.args = v.args.filter(a => typeof a === "string");
    if (typeof v.cwd === "string") out.cwd = v.cwd;
    if (v.env && typeof v.env === "object") {
      const names = Object.entries(v.env).filter(([, x]) => typeof x === "string").map(([k]) => k);
      if (names.length) { out.envNames = names; out.hasSecrets = true; }
    }
    return out;
  }
  if (typeof v.url !== "string" || !v.url) return null;
  /** @type {any} */
  const out = { name, transport: type, url: v.url };
  if (v.headers && typeof v.headers === "object") {
    const names = Object.entries(v.headers).filter(([, x]) => typeof x === "string").map(([k]) => k);
    if (names.length) { out.headerNames = names; out.hasSecrets = true; }
  }
  return out;
}

const take = (obj, out) => {
  if (!obj || typeof obj !== "object") return;
  for (const [name, v] of Object.entries(obj)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
    const n = normalize(name, v);
    if (n) out.push(n);
  }
};

/**
 * Parse one config file's text for its top-level `mcpServers`. Bad JSON or a missing key answers
 * an empty list, never throws: a config file a person is mid-edit on should not break discovery.
 * With `project` (an absolute path), reads only that project's `projects[project].mcpServers`
 * instead, for a `~/.claude.json`-shaped file's local scope; the two are never merged by this
 * function, so a caller that wants both calls it twice.
 * @param {string} text @param {string} [project]
 */
export function parseServers(text, project) {
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  if (!doc || typeof doc !== "object") return [];
  const out = [];
  if (project) take(doc.projects && typeof doc.projects === "object" ? doc.projects[project] && doc.projects[project].mcpServers : null, out);
  else take(doc.mcpServers, out);
  return out;
}

/** Read one file's servers, or an empty list if it is missing, unreadable or not a file. */
function readServers(file, project) {
  try {
    if (!fs.statSync(file).isFile()) return [];
  } catch { return []; }
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  return parseServers(text, project);
}

/**
 * Every `.mcp.json` from `cwd` up to the filesystem root: the project's own and any ancestor's,
 * nearest first, deduplicated by real path (a symlinked ancestor is not walked twice).
 * @param {string} cwd
 */
function projectFiles(cwd) {
  const out = [];
  const seen = new Set();
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    let real = d;
    try { real = fs.realpathSync.native(d); } catch { /* not there: still worth trying its .mcp.json */ }
    if (!seen.has(real)) { seen.add(real); out.push(path.join(d, ".mcp.json")); }
    if (d === path.dirname(d)) break;
  }
  return out;
}

/**
 * Every subdirectory of `<claudeHome>/plugins/` that ships its own `.mcp.json` at its root: a
 * folder name and its file, or none if the plugins folder does not exist. This is a guess at
 * where a plugin's MCP config lives (nothing else in this repo parses a plugin manifest yet); a
 * caller may pass its own `plugins` list to `discover()` instead once that is pinned down.
 * @param {string} dir `claudeHome(root, env)`
 */
function scanPlugins(dir) {
  const base = path.join(dir, "plugins");
  let names;
  try { names = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  return names.filter(e => e.isDirectory()).map(e => ({ name: e.name, mcpFile: path.join(base, e.name, ".mcp.json") }))
    .filter(p => { try { return fs.statSync(p.mcpFile).isFile(); } catch { return false; } });
}

/**
 * Every MCP server named in Claude Code's own config, deduplicated by name within a source (a
 * nearer `.mcp.json` wins over a further one; user, local and each plugin are separate sources so
 * the same name in two places is not silently dropped).
 *
 * `root` is the Vyre home, read through `core/config`'s `claudeJson`/`claudeHome` (e2e review,
 * 2026-09-28): only a person's own `~/.vyre` reads their real `~/.claude.json` and `~/.claude/
 * plugins/`; a dev world, a demo, a temp home or a test gets `<root>/claude.json` and
 * `<root>/claude/plugins/`, empty until a fixture puts something there. This file never calls
 * `os.homedir()` itself. Whoever wires this into a tool must pass the CALLER'S VERIFIED PROJECT
 * for `cwd` (the Switchboard's project for the session, never a path an input names), so an agent
 * cannot point discovery at a project it does not run in.
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, cwd?: string, plugins?: { name: string, mcpFile: string }[] }} [o]
 *   `cwd` defaults to `process.cwd()` (a caller wiring this into a tool must override it); `plugins`
 *   defaults to `scanPlugins(claudeHome(root, env))`, pass `[]` to skip plugin discovery outright.
 * @returns {{ source: string, plugin?: string, path: string, server: ReturnType<typeof normalize> }[]}
 */
export function discover({ root, env = process.env, cwd = process.cwd(), plugins } = {}) {
  const found = [];
  const push = (source, file, list, extra) => {
    const seen = new Set();
    for (const server of list) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      found.push({ source, path: file, server, ...(extra || {}) });
    }
  };
  const jsonFile = claudeJson(root, env);
  push("user", jsonFile, readServers(jsonFile));
  push("local", jsonFile, readServers(jsonFile, path.resolve(cwd)));
  const perFile = new Map();
  for (const file of projectFiles(cwd)) if (!perFile.has(file)) perFile.set(file, readServers(file));
  for (const [file, list] of perFile) push("project", file, list);
  for (const p of plugins ?? scanPlugins(claudeHome(root, env))) push("plugin", p.mcpFile, readServers(p.mcpFile), { plugin: p.name });
  return found;
}

/**
 * `discover()`'s rows against what the hub already has (`mcp.servers`' names): a row per
 * discovered server not yet added, `{ source, plugin?, path, server }`. Present servers are left
 * out entirely (this never suggests "re-add" for one already there under a different source).
 * @param {ReturnType<typeof discover>} rows @param {string[]} known
 */
export function undiscovered(rows, known) {
  const have = new Set(known);
  return rows.filter(r => !have.has(r.server.name));
}
