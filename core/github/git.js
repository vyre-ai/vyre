// @ts-check
// git: the mechanics behind github.project and github.session.worktree/.cleanup (ADR 0041).
// Every git call goes through lib/git-safe.js, with no exception.
//
// Cloning is blocked on two things this file deliberately does NOT work around, both owned by
// sessions (git-safe.js's owner) and flagged to them before any code landed here:
//   1. git-safe.js's SAFE_GIT_ARGS sets `protocol.allow=never`, so no transport at all is
//      permitted today, not even https for a public repo. That is correct for git-safe's stated
//      job (running git safely inside a folder someone else can write to) and wrong for a clone,
//      which is inherently a network operation; it needs a variant that allows exactly `https`
//      and nothing else (never `file`, `git`, `ext`, or a submodule's own transport).
//   2. A private repo additionally needs a token in front of that clone/fetch/push, safely (never
//      in the remote URL, never handed to a credential helper) — the `gitWithAskpass` addition
//      ADR 0041 proposes.
// Until sessions builds and reviews that addition, cloneRepo refuses plainly rather than
// attempting a call that would just fail on "transport not allowed", or worse, working around
// git-safe's protocol block from outside it. Worktrees need neither: they are a local git
// operation on a repo already on disk, so section 5 of the ADR is not blocked on this, and is
// fully implemented and tested below.

import fs from "node:fs";
import path from "node:path";
import { gitAsync } from "../../lib/git-safe.js";

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
 * Clone a repo into a fresh folder under `projectsDir`. Blocked today for every repo, public or
 * private, until git-safe.js gains a network-allowing (and, for a private repo, token-carrying)
 * clone path — see the file header. Refuses immediately rather than attempting a call that would
 * only fail on git's own "transport not allowed".
 * @param {{ projectsDir: string, name: string, url: string, private: boolean }} p
 */
export async function cloneRepo({ projectsDir, name, url, private: isPrivate }) {
  throw fail(
    `cloning is blocked on git-safe.js's pending network-allow addition (ADR 0041 decision 4)` +
    `${isPrivate ? ", plus its askpass addition for a private repo's token" : ""}; ` +
    `neither has landed yet`,
    "blocked",
  );
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
 * Remove a session's worktree. The branch stays (a session's work is never deleted by ending the
 * session) unless it has zero commits ahead of the default branch, the safe case to prune.
 * @param {{ repoDir: string, session: string, defaultBranch: string }} p
 */
export async function worktreeRemove({ repoDir, session, defaultBranch }) {
  const id = safeSegment(session, "session id");
  const dest = path.join(repoDir, ".sessions", id);
  const branch = `vyre/${id}`;
  const rm = await gitAsync(repoDir, ["worktree", "remove", "--force", dest]);
  if (!rm.ok && fs.existsSync(dest)) throw fail(`git worktree remove failed: ${rm.stderr.trim().slice(0, 300) || "no output"}`, "cleanup_failed");
  const ahead = await gitAsync(repoDir, ["rev-list", "--count", `${defaultBranch}..${branch}`]);
  let pruned = false;
  if (ahead.ok && Number(ahead.stdout.trim()) === 0) {
    const del = await gitAsync(repoDir, ["branch", "-D", branch]);
    pruned = del.ok;
  }
  return { removed: true, pruned };
}
