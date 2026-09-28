// @ts-check
// git: the mechanics behind github.project and github.session.worktree/.cleanup (ADR 0041).
// Every git call goes through lib/git-safe.js, with no exception.
//
// Cloning uses gitWithAskpass (lib/git-safe.js), the addition this workstream drafted, tested
// (lib/git-safe-askpass.test.js) and sent to sessions (git-safe.js's owner) for review as a
// self-contained new-file diff, since it has no clean path to build against a live git-safe.js on
// their own branch right now. It is not yet folded into main or reviewed there; this file is
// ready the moment it lands, unchanged. Worktrees need no token or network allowance at all: a
// worktree is a local git operation on a repo already on disk, so section 5 of the ADR was never
// blocked on this, and is fully implemented and tested below.

import fs from "node:fs";
import path from "node:path";
import { gitAsync, gitWithAskpass } from "../../lib/git-safe.js";

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });

/**
 * A path segment that is safe both as a single folder name (no `/`, so it can never become more
 * than one path component) and as the tail of a git branch name (no `..` anywhere, no leading
 * `.` or `-`, no trailing `.` — git's own check-ref-format rules, since this becomes `vyre/<id>`).
 */
export function safeSegment(s, what = "name") {
  let clean = String(s || "")
    .replace(/[^A-Za-z0-9._-]/g, "-") // no slash or anything else survives as a separator
    .replace(/\.{2,}/g, "-")          // no ".." anywhere, whatever produced it
    .replace(/^[.-]+/, "")            // git refs can't start with "." or look like a flag
    .replace(/\.+$/, "");             // git refs can't end with "."
  if (!clean) throw fail(`that ${what} has no safe form for a folder or branch`);
  return clean.slice(0, 100);
}

/** `<projectsDir>/<name>`, `<name>-2`, `<name>-3`, ... until one does not exist. */
export function freeFolder(projectsDir, name) {
  const base = safeSegment(name, "repo name");
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const dest = path.join(projectsDir, candidate);
    if (!fs.existsSync(dest)) return dest;
  }
}

/**
 * Clone a repo into a fresh folder under `projectsDir`, over https, with `token` as the password
 * (GitHub accepts any non-empty username with a PAT, so gitWithAskpass's fixed `x-access-token`
 * is used for every account). The same call works for a public or a private repo; the token is
 * never in the URL, an argv, an env var, or written to the clone's own remote config.
 * @param {{ projectsDir: string, name: string, url: string, token: string }} p
 */
export async function cloneRepo({ projectsDir, name, url, token }) {
  fs.mkdirSync(projectsDir, { recursive: true });
  const dest = freeFolder(projectsDir, name);
  const r = await gitWithAskpass(projectsDir, ["clone", "--no-recurse-submodules", "--", url, dest], { token, timeout: 120_000 });
  if (!r.ok) throw fail(`git clone failed: ${r.stderr.trim().slice(0, 300) || "no output"}`, "clone_failed");
  return { path: dest };
}

const EXCLUDE_LINE = ".sessions/";

/** Add `.sessions/` to the repo's own (never the person's committed) exclude file, once. */
function ensureExcluded(repoDir) {
  const file = path.join(repoDir, ".git", "info", "exclude");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  if (text.split("\n").some(l => l.trim() === EXCLUDE_LINE)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text && !text.endsWith("\n") ? `${text}\n${EXCLUDE_LINE}\n` : `${text}${EXCLUDE_LINE}\n`);
}

/**
 * A worktree and branch for one session: `<repoDir>/.sessions/<safe-id>` on `vyre/<safe-id>`.
 * No token needed; a worktree is a local git operation on a repo already cloned.
 * @param {{ repoDir: string, session: string, defaultBranch: string }} p
 */
export async function worktreeAdd({ repoDir, session, defaultBranch }) {
  const id = safeSegment(session, "session id");
  ensureExcluded(repoDir);
  const dest = path.join(repoDir, ".sessions", id);
  const branch = `vyre/${id}`;
  const r = await gitAsync(repoDir, ["worktree", "add", dest, "-b", branch, defaultBranch]);
  if (!r.ok) throw fail(`git worktree add failed: ${r.stderr.trim().slice(0, 300) || "no output"}`, "worktree_failed");
  return { path: dest, branch };
}

/**
 * Whether a session's worktree is safe to remove with no loss: no uncommitted changes, no
 * untracked files, and no commit that isn't already on the default branch or some remote (the
 * user's binding rule: no auto-delete, ever, of anything that would actually be lost).
 * @param {{ repoDir: string, dest: string, branch: string, defaultBranch: string }} p
 */
async function worktreeSafety({ repoDir, dest, branch, defaultBranch }) {
  const status = await gitAsync(dest, ["status", "--porcelain"]);
  const dirty = status.ok ? status.stdout.split("\n").map(l => l.trim()).filter(Boolean) : ["(could not read the worktree's status)"];
  const rev = await gitAsync(repoDir, ["rev-list", branch, "--not", defaultBranch, "--remotes", "--pretty=oneline", "--abbrev-commit"]);
  const commits = rev.ok ? rev.stdout.split("\n").filter(Boolean) : ["(could not check which commits are only on this branch)"];
  return { dirty, commits, safe: dirty.length === 0 && commits.length === 0 };
}

/**
 * Remove a session's worktree, but ONLY when it is provably safe: no uncommitted change, no
 * untracked file, and no commit that would be lost (everything on it is already on the default
 * branch or some remote). This is the user's binding rule, not a style choice: no auto-delete,
 * deletion is always previewed. When it is not safe, nothing is removed; the worktree and branch
 * are left exactly as they are, and the caller (`github.session.cleanup`) tells the person what
 * would be lost so they can decide by hand. `git worktree remove --force` and `git branch -D`
 * never appear in this path, on purpose: a plain (non-force) remove and a plain (non-force,
 * `-d`) branch delete both refuse on their own if anything here turns out to be wrong, which is
 * a second, independent backstop behind the check above, not a substitute for it.
 * @param {{ repoDir: string, session: string, defaultBranch: string }} p
 */
export async function worktreeRemove({ repoDir, session, defaultBranch }) {
  const id = safeSegment(session, "session id");
  const dest = path.join(repoDir, ".sessions", id);
  const branch = `vyre/${id}`;
  if (!fs.existsSync(dest)) return { removed: false, existed: false };
  const safety = await worktreeSafety({ repoDir, dest, branch, defaultBranch });
  if (!safety.safe) return { removed: false, needsConfirm: true, path: dest, branch, dirty: safety.dirty, commits: safety.commits };
  const rm = await gitAsync(repoDir, ["worktree", "remove", dest]);
  if (!rm.ok) throw fail(`git worktree remove failed even though nothing would be lost: ${rm.stderr.trim().slice(0, 300) || "no output"}`, "cleanup_failed");
  const del = await gitAsync(repoDir, ["branch", "-d", branch]);
  return { removed: true, pruned: del.ok };
}
