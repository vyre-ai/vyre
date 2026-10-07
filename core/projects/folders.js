// @ts-check
// folders: the path helpers the projects module needs. A project is no longer declared by a marker file: it is a Project record in Records, and the folders on THIS computer that belong to it are
// rows of the per-machine table `projects_folders` (core/projects/projects.js). What is left here is shape: slugs, real paths, and which project's folder a path is in.

import fs from "node:fs";
import path from "node:path";
import { slugify, isProjectId, SLUG_RE } from "../../lib/project-id.js";

/** @typedef {{ name: string, email?: string }} Person */
/** @typedef {{ slug: string, name: string, org: string|null, home: string, workspaces: string[],
 *   threads: string[], people: Person[], watchers: string[], avatar_seed: string, archived_at: number|null, error?: string }} Project */

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

/** Folders relative to a home. */
export function relative(home, dirs) {
  return dirs.map(d => path.relative(home, path.resolve(d)) || ".");
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
