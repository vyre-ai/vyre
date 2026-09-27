// @ts-check
// envfiles: .env files as vault items, found across a project, and rewritten to references.
//
// One .env file becomes one `env-set` item, named after where it lives (harlow-intake/.env is
// `harlow-intake.env`, apps/web/.env.local under it is `harlow-intake-apps-web.env.local`). Only
// the variables detect.js calls secret go in; plain config (PORT, NODE_ENV, a public URL) stays in
// the file, because moving it would make the file unreadable for no gain (ADR 0028, decision 1).
//
// The rewrite replaces each imported line with `KEY=vault://item/KEY` and leaves every other line,
// comment and blank as it was, so `vyre vault run --env-file .env -- cmd` gives the program the
// same environment it had. It runs only after the import stored every value, and it never writes
// a copy of the old file: a backup of a plaintext .env is the leak this exists to end.
//
// Parsing and rewriting are pure. findEnvFiles and gitState touch the disk and nothing else.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classify } from "./detect.js";
import { isRef, templateRefs } from "./refs.js";

/**
 * @typedef {{ key: string, value: string, start: number, end: number, exported: boolean }} Entry
 *   one variable and the lines it spans, [start, end)
 * @typedef {{ key: string, secret: boolean, type: string, provider?: string, mode?: string, public?: true, expires?: number }} Var
 *   what the preview shows for one variable: never its value
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** @param {string} v */
const holdsRef = v => { try { return isRef(v) || templateRefs(v).length > 0; } catch { return true; } };
const safeKey = s => s.replace(/[^\x21-\x7e]/g, "?").slice(0, 64);

/** Directories a scan never enters: dependencies, build output, caches and version control. */
export const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".vercel", ".output", "target", "vendor", ".venv", "venv", "__pycache__", ".cache", "coverage", "Pods", ".gradle",
  ".terraform", "bower_components", ".yarn", ".pnpm-store", "DerivedData"]);
/** Files that document a .env rather than hold one. Listed, never imported. */
const TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;
const MAX_FILE = 1024 * 1024;

/** Is this file name a .env file (`.env`, `.env.local`, `prod.env`)? @param {string} base */
export const isEnvName = base => /^\.env(\..+)?$/i.test(base) || /^[^.].*\.env$/i.test(base);

/**
 * Every variable in a .env file with the lines it spans, for the rewrite. Same rules as the import
 * always had: `export` is allowed, double quotes take escapes and may run across lines, single
 * quotes are literal, an unquoted value loses a trailing ` # comment`, a later line wins.
 * @param {string} text
 * @returns {{ entries: Entry[], skipped: string[] }}
 */
export function envEntries(text) {
  /** @type {Map<string, Entry>} */
  const found = new Map();
  /** @type {string[]} */
  const skipped = [];
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n|\r/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^\s*(export\s+)?([^\s=#]+)\s*=\s*(.*)$/.exec(line);
    if (!m) { skipped.push(`line ${n + 1}: not NAME=value`); continue; }
    const key = m[2];
    const start = n;
    let rest = m[3];
    let value;
    if (rest.startsWith('"')) {
      // Double quotes: escapes, and the value may run across lines until the closing quote.
      let out = "";
      let i = 1;
      let closed = false;
      let j = n;
      for (;;) {
        for (; i < rest.length; i++) {
          const c = rest[i];
          if (c === "\\" && i + 1 < rest.length) {
            const e = rest[++i];
            out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === '"' ? '"' : e === "\\" ? "\\" : "\\" + e;
          } else if (c === '"') { closed = true; break; }
          else out += c;
        }
        if (closed || j + 1 >= lines.length) break;
        out += "\n";
        rest = lines[++j];
        i = 0;
      }
      if (!closed) { skipped.push(`${safeKey(key)}: no closing double quote`); continue; }
      n = j;
      value = out;
    } else if (rest.startsWith("'")) {
      const close = rest.indexOf("'", 1);
      if (close < 0) { skipped.push(`${safeKey(key)}: no closing single quote`); continue; }
      value = rest.slice(1, close);
    } else {
      value = rest.replace(/\s+#.*$/, "").trim();
      if (value.startsWith("#")) value = "";
    }
    if (!KEY.test(key)) { skipped.push(`${safeKey(key)}: not a usable variable name`); continue; }
    if (value === "") { skipped.push(`${key}: empty value`); continue; }
    if (found.has(key)) { skipped.push(`${key}: set more than once, the last one is kept`); found.delete(key); }
    found.set(key, { key, value, start, end: n + 1, exported: Boolean(m[1]) });
  }
  return { entries: [...found.values()], skipped };
}

/**
 * The item name for a .env file: its folder (relative to the scan root's parent, so the project
 * name leads) joined with dashes, then the file name without its leading dot. A bare file name
 * (no folder) is just the file name without its dot.
 * @param {string} [file] @param {string} [root] a scanned folder; the file's own folder by default
 */
export function envItemName(file, root) {
  if (!file) return "env";
  // A bare file name has no folder to name it after.
  if (!path.isAbsolute(file) && !root) { const b = path.basename(file).replace(/^\./, "").replace(/[^A-Za-z0-9._-]+/g, "-"); return ITEM.test(b) ? b : "env"; }
  const abs = path.resolve(file);
  const base = path.basename(abs);
  const dir = path.dirname(abs);
  const top = root ? path.resolve(root) : dir;
  const from = path.dirname(top === abs ? dir : top);
  const rel = path.relative(from, dir).split(path.sep).filter(Boolean);
  const where = rel.map(s => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "")).filter(Boolean).join("-");
  const file_ = base.startsWith(".") ? base.slice(1) : base;
  let name = (where ? `${where}${base.startsWith(".") ? "." : "-"}` : "") + file_.replace(/[^A-Za-z0-9._-]+/g, "-");
  name = name.replace(/^[^A-Za-z0-9]+/, "");
  if (name.length > 128) name = name.slice(name.length - 128).replace(/^[^A-Za-z0-9]+/, "");
  return ITEM.test(name) ? name : "env";
}

/**
 * One .env file read into an env-set item holding its secret variables, and what the preview
 * shows about every variable. `item` is null when nothing in the file is secret.
 * @param {string} text
 * @param {{ file?: string, root?: string }} [where]
 */
export function readEnv(text, { file, root } = {}) {
  const { entries, skipped } = envEntries(text);
  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {Var[]} */
  const vars = [];
  /** @type {string[]} */
  const kept = [];
  for (const e of entries) {
    // A reference (or a template holding one) is already in the vault: it stays as it is.
    if (holdsRef(e.value)) { vars.push({ key: e.key, secret: false, type: "ref" }); kept.push(e.key); continue; }
    const c = classify(e.key, e.value);
    vars.push({ key: e.key, ...c });
    if (c.secret) fields[e.key] = e.value;
    else kept.push(e.key);
  }
  const name = envItemName(file, root);
  const shown = file ? (root ? path.relative(path.dirname(path.resolve(root)), path.resolve(file)) : path.basename(file)) : ".env";
  const n = Object.keys(fields).length;
  const tags = ["env", ...new Set(vars.filter(v => v.secret && v.provider).map(v => /** @type {string} */ (v.provider)))];
  const item = n ? { name, kind: /** @type {const} */ ("env-set"), description: `from ${shown} · ${n} value${n === 1 ? "" : "s"}`, fields, hosts: [], tags } : null;
  return { item, vars, kept, skipped, entries };
}

/**
 * The file with each variable in `keys` replaced by a reference to `item`. Everything else,
 * comments, blank lines, plain config and the line endings, is left as it was.
 * @param {string} text @param {string} item @param {Iterable<string>} keys
 */
export function rewriteEnv(text, item, keys) {
  const want = new Set(keys);
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const lines = text.replace(/^﻿/, "").split(/\r?\n|\r/);
  const { entries } = envEntries(text);
  // Bottom up, so a multi-line value collapsing to one line leaves earlier spans where they were.
  for (const e of [...entries].sort((a, b) => b.start - a.start)) {
    if (!want.has(e.key)) continue;
    lines.splice(e.start, e.end - e.start, `${e.exported ? "export " : ""}${e.key}=vault://${item}/${e.key}`);
  }
  return bom + lines.join(eol);
}

/**
 * Every .env file under `root` (or `root` itself when it is a file). Symlinks are not followed,
 * dependency and build folders are skipped, and the walk stops at `depth` and `limit`.
 * @param {string} root
 * @param {{ depth?: number, limit?: number }} [opts]
 * @returns {{ files: string[], templates: string[], large: string[], truncated: boolean }}
 */
export function findEnvFiles(root, { depth = 6, limit = 200 } = {}) {
  const abs = path.resolve(root);
  const st = fs.lstatSync(abs);
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const templates = [];
  /** @type {string[]} */ const large = [];
  if (st.isFile()) return { files: [abs], templates, large, truncated: false };
  let truncated = false;
  /** @param {string} dir @param {number} d */
  const walk = (dir, d) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of list) {
      if (truncated) return;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (d < depth && !SKIP_DIRS.has(ent.name)) walk(p, d + 1); continue; }
      if (!ent.isFile() || !isEnvName(ent.name)) continue;
      if (TEMPLATE.test(ent.name)) { templates.push(p); continue; }
      let size = 0;
      try { size = fs.statSync(p).size; } catch { continue; }
      if (size > MAX_FILE) { large.push(p); continue; }
      if (files.length >= limit) { truncated = true; return; }
      files.push(p);
    }
  };
  walk(abs, 0);
  return { files, templates, large, truncated };
}

/**
 * Whether git tracks the file (its values are then in history, whatever the vault does) and
 * whether it is ignored. null when the file is not in a git work tree or git is missing.
 * @param {string} file
 * @returns {{ tracked: boolean, ignored: boolean } | null}
 */
export function gitState(file) {
  const dir = path.dirname(file);
  /** @param {string[]} args */
  const ok = args => {
    try { execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", timeout: 3000 }); return true; } catch { return false; }
  };
  if (!ok(["rev-parse", "--is-inside-work-tree"])) return null;
  return { tracked: ok(["ls-files", "--error-unmatch", "--", path.basename(file)]), ignored: ok(["check-ignore", "-q", "--", path.basename(file)]) };
}
