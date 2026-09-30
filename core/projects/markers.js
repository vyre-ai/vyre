// @ts-check
// markers — a project is declared by one file, <home>/.vyre/project.json, and this is the only
// code that reads or writes it.
//
// The marker is the truth; the database only caches it. That is what lets a person move a
// project folder, edit the file by hand, or check it into the project's own repo, and have Vyre
// follow. Picks live in the marker for the same reason: a hand-made choice must survive any
// rebuild of the cache, and nothing automatic may ever remove one.
//
// Paths in the marker are relative to the home, so a project still works after the folder it
// lives in moves. They are resolved to absolute paths on the way in.

import fs from "node:fs";
import path from "node:path";
import { slugify, isProjectId, SLUG_RE } from "../../lib/project-id.js";

export const MARKER = path.join(".vyre", "project.json");

// Folders a walk for markers never enters: build output and dependencies are large, hold no
// projects, and made the first walk take seconds.
const SKIP = new Set(["node_modules", "dist", "build", "out", "target", "venv", "__pycache__"]);

/** @typedef {{ name: string, email?: string }} Person */
/** @typedef {{ slug: string, name: string, org: string|null, home: string, workspaces: string[],
 *   threads: string[], people: Person[], watchers: string[], avatar_seed: string, archived_at: number|null, error?: string }} Project */

// The canonical shape now lives in lib/project-id.js (any part may import a lib without a
// boundaries exception); re-exported here so `M.slugify` and existing callers keep working.
export { slugify, isProjectId, SLUG_RE };

/** A subagent's id is "<parent>/agent-<id>". It folds into its parent everywhere a person sees it. */
export const parentOf = id => { const s = String(id); const i = s.indexOf("/"); return i > 0 ? s.slice(0, i) : s; };

/**
 * A folder's real path when it exists, so a home typed through a symlink matches the folder a
 * shell or Claude Code reports, which is always the resolved one. On macOS every temp folder is
 * reached through /var but reported as /private/var, and a project in one never matched a
 * session in the other.
 */
export function real(p) {
  const abs = path.resolve(String(p));
  // A folder that does not exist (yet, or any more) still resolves through its nearest parent
  // that does, so a deleted session folder under a symlinked home still matches that home.
  let head = abs, rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(head), ...rest); } catch {}
    const up = path.dirname(head);
    if (up === head) return abs;
    rest.unshift(path.basename(head));
    head = up;
  }
}

/**
 * One project from its home folder, or null when the marker is missing or has no name.
 * @returns {Project|null}
 */
export function load(home) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(home, MARKER), "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || !raw.name) return null;
  const abs = real(home);
  const list = v => (Array.isArray(v) ? v : []);
  const slug = slugify(raw.slug || raw.name);
  return {
    slug,
    name: String(raw.name).trim(),
    org: raw.org ? String(raw.org) : null,
    home: abs,
    // The home is always a workspace: work done in it is work on the project.
    workspaces: [...new Set([abs, ...list(raw.workspaces).map(w => real(path.resolve(abs, String(w))))])],
    threads: [...new Set(list(raw.threads).map(t => parentOf(t)))],
    people: list(raw.people).filter(p => p && (p.name || p.email))
      .map(p => ({ name: String(p.name || p.email).trim(), ...(p.email ? { email: String(p.email).trim() } : {}) })),
    watchers: list(raw.watchers).map(String),
    // What the project's tile is drawn from (ADR 0043 section 6): the stored seed, else the slug,
    // the project's id. Never read back from the name, so a rename never redraws the tile. A
    // marker from before this field is not rewritten on read; it just defaults.
    archived_at: Number.isFinite(Number(raw.archived_at)) && Number(raw.archived_at) > 0 ? Number(raw.archived_at) : null,
    avatar_seed: typeof raw.avatar_seed === "string" && raw.avatar_seed ? raw.avatar_seed : slug,
  };
}

/**
 * Write a marker, merging onto what is there so a field this call does not name is never lost
 * (a person may have added keys Vyre does not know about). Written to a temp file and renamed,
 * so a crash mid-write cannot leave half a marker.
 */
export function write(home, fields) {
  const file = path.join(home, MARKER);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify({ ...prev, ...fields }, null, 2) + "\n");
  fs.renameSync(file + ".tmp", file);
  return load(home);
}

/** Workspaces as the marker stores them: relative to the home. */
export function relative(home, dirs) {
  return dirs.map(d => path.relative(home, path.resolve(d)) || ".");
}

/**
 * Every marker under the roots. Hidden folders are skipped (the marker's own .vyre folder is
 * read directly, never walked). Never throws: an unreadable folder is simply not searched.
 * @returns {Project[]}
 */
export function discover(roots, { maxDepth = 5 } = {}) {
  const found = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen.has(dir)) return;
    seen.add(dir);
    const p = load(dir);
    if (p) found.push(p);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(real(r), 0);
  return found;
}

/**
 * Two markers claiming one slug is a mistake worth refusing rather than merging silently. The
 * first one seen keeps the slug; the other carries an error and is left out of everything.
 * @param {Project[]} list
 */
export function flagClashes(list) {
  const bySlug = new Map();
  for (const p of list) {
    const first = bySlug.get(p.slug);
    if (first && first.home !== p.home) p.error = `slug "${p.slug}" is also used by ${first.home}`;
    else bySlug.set(p.slug, p);
  }
  return list;
}

/**
 * The project that owns a folder: the one with the deepest workspace containing it. Compared on
 * a path boundary, so "/w/harlow-site-old" is not inside "/w/harlow-site".
 *
 * A folder a person typed is resolved through symlinks first. A session's folder is not: Claude
 * Code records the real path already, and resolving every session's folder cost 2.6 seconds per
 * catalogue call on a 600-session index, since most of those folders no longer exist and each
 * one walked up its parents with a failing realpath at every step.
 * @param {string|null|undefined} cwd
 * @param {Project[]} list
 * @param {{ resolved?: boolean }} [opts] resolved: cwd is already a real path
 */
export function projectOf(cwd, list, { resolved = false } = {}) {
  if (!cwd) return null;
  const c = resolved ? path.resolve(String(cwd)) : real(cwd);
  let best = null, len = -1;
  for (const p of list) {
    if (p.error) continue;
    for (const w of p.workspaces) {
      if ((c === w || c.startsWith(w + path.sep)) && w.length > len) { best = p; len = w.length; }
    }
  }
  return best;
}
