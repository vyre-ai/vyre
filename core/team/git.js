// @ts-check
// git — the mechanical half of code isolation (ADR 0031 section 8): finding a project's repo,
// giving a worktree-isolated teammate its own worktree and branch, and merging the project's
// branch into it before each request. Vyred runs every one of these, never the model, and never
// `git init`s on the person's behalf (team.add refuses isolation: worktree outside a real repo).
//
// No shell, no prompt, no network, a deadline: the same pattern core/switchboard/changes.js uses
// for `git diff --numstat` behind a push ask.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_MS = 15_000;

/**
 * Run git in `dir`. Never rejects.
 * @param {string} dir @param {string[]} args @param {number} [ms]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>}
 */
export function git(dir, args, ms = GIT_MS) {
  return new Promise(resolve => {
    execFile("git", ["-c", "protocol.allow=never", "-c", "core.fsmonitor=false", "-C", dir, ...args], {
      timeout: ms, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat", PAGER: "cat", LC_ALL: "C", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) }));
  });
}

/** The repo root that owns `dir`, or null when it is not inside a git repo (or does not exist). Never `git init`s. */
export async function repoRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.stdout.trim() : null;
}

/** The branch currently checked out at `dir`, or null (detached HEAD, an empty repo with no commit yet). */
export async function currentBranch(dir) {
  const r = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

/** Where a role's worktree lives, and the branch it runs on: siblings of the repo, like `../vyre-<team>`. */
export const worktreePath = (repo, role) => path.join(path.dirname(repo), `${path.basename(repo)}-${role}`);
export const branchOf = role => `team/${role}`;

/** Does this branch already exist in the repo? */
async function hasBranch(repo, branch) {
  return (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
}

/**
 * A role's worktree, made if it does not exist yet: its own branch, off `base`, never touching
 * the person's own checkout (a plain `git worktree add`, not a checkout in the repo's own folder).
 * @param {string} repo @param {string} role @param {string} base
 */
export async function ensureWorktree(repo, role, base) {
  const dir = worktreePath(repo, role), branch = branchOf(role);
  if (fs.existsSync(dir)) return { ok: true, dir, branch };
  const args = (await hasBranch(repo, branch)) ? ["worktree", "add", dir, branch] : ["worktree", "add", dir, "-b", branch, base];
  const r = await git(repo, args);
  return { ok: r.ok, dir, branch, stderr: r.stderr };
}

/**
 * Merge `base` into the branch checked out at a worktree. Vyred does this before every request,
 * never the model. A conflict is backed out at once (`merge --abort`), so the worktree is always
 * clean for the next attempt: the request that hit it just fails, with the conflict in its result.
 */
export async function mergeBaseIn(worktreeDir, base) {
  const r = await git(worktreeDir, ["merge", "--no-edit", "-m", `merge ${base} for the next request`, base]);
  if (!r.ok) await git(worktreeDir, ["merge", "--abort"]).catch(() => {});
  return r;
}

/** Is `branch` ahead of `base` (real commits worth merging back)? */
export async function aheadOf(repo, branch, base) {
  const r = await git(repo, ["rev-list", `${base}..${branch}`, "--count"]);
  return r.ok && Number(r.stdout.trim()) > 0;
}

/** `base..branch`, as the short shas a merge request names ("team/design a1b2c3d..9e8f7a6"). */
export async function shaRange(repo, branch, base) {
  const from = await git(repo, ["merge-base", base, branch]);
  const to = await git(repo, ["rev-parse", branch]);
  if (!from.ok || !to.ok) return null;
  return { from: from.stdout.trim().slice(0, 7), to: to.stdout.trim().slice(0, 7) };
}
