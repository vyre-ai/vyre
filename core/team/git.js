// @ts-check
// git — the mechanical half of code isolation (ADR 0031 section 8): finding a project's repo,
// giving a worktree-isolated teammate its own worktree and branch, and merging the project's
// branch into it before each request. Vyred runs every one of these, never the model, and never
// `git init`s on the person's behalf (team.add refuses isolation: worktree outside a real repo).
//
// Every call goes through lib/git-safe.js's gitAsync (e2e, safe-git): no shell, no prompt, no
// network, no hooks or fsmonitor, no system or global config, every filter/diff/merge driver the
// repo names overridden, a repo's own gpg.program never run even to check a signature. That is
// the one place vyred starts git at all (test/safe-git.test.js walks the tree and fails on any
// other file that does).
//
// On top of that, and nothing the repo says to run (e2e and reviewer, slice A, HIGH): a teammate
// writes the repo's shared .git to commit, so it can pull in config from elsewhere (include,
// includeIf) or name an alias — neither is a driver git-safe.js can override by name, so checkout
// and merge refuse to run at all while the repo's own config has one, and say which (unsafeConfig).
//
// Revs and paths go after --end-of-options. Branch names come only from `symbolic-ref` on the
// person's own checkout and from a teammate's role, which team.add has already checked against
// its NAME pattern, so neither can start with "-" anyway.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitAsync } from "../../lib/git-safe.js";

const GIT_MS = 15_000;

/**
 * Whoever made a merge vyred ran: vyred, not whoever last committed. Global config is off, so git
 * would otherwise refuse to guess. `-c` options, not env: lib/git-safe.js's own environment is
 * deliberately narrow (it strips every GIT_* key before rebuilding it from scratch), and that is
 * a line worth keeping bright rather than punching a caller-supplied hole in for one identity —
 * these two config keys cover both GIT_AUTHOR_* and GIT_COMMITTER_* at once anyway. Must come
 * before the subcommand name in `args` (global git options, not merge/reset/commit options).
 */
const VYRE_IDENTITY = ["-c", "user.name=Vyre", "-c", "user.email=vyre@localhost"];

/**
 * Run git in `dir` through lib/git-safe.js. Never rejects.
 * @param {string} dir @param {string[]} args @param {{ ms?: number }} [o]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>}
 */
export function git(dir, args, { ms = GIT_MS } = {}) {
  return gitAsync(dir, args, { timeout: ms });
}

/** Repo config keys that name a program git would run on the repo's content, or pull in config from elsewhere. */
const UNSAFE = [/^filter\..+\.(smudge|clean|process)$/, /^diff\..+\.(textconv|command)$/, /^merge\..+\.driver$/, /^include\.path$/, /^includeif\./, /^alias\./];

/**
 * The repo config keys (local and per-worktree; system and global are never read) that checkout
 * or merge would act on and that vyred cannot switch off from the command line. Empty when safe.
 * @param {string} dir
 */
export async function unsafeConfig(dir) {
  const r = await git(dir, ["config", "--list", "--name-only", "--show-origin", "-z"]);
  if (!r.ok) return ["(could not read this repo's config)"];
  const parts = r.stdout.split("\0");
  const bad = [];
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const origin = parts[k], name = parts[k + 1].toLowerCase();
    if (origin.startsWith("command line:")) continue;
    if (UNSAFE.some(re => re.test(name))) bad.push(name);
  }
  return [...new Set(bad)];
}

const refuse = (bad, what) => ({ ok: false, stdout: "",
  stderr: `vyred will not ${what} here: this repo's own config names ${bad.join(", ")}, which git would run as vyred, outside every permission check. ` +
    "A teammate can write a repo's .git, so this is refused rather than trusted. Remove it from .git/config if you set it yourself." });

/** The repo root that owns `dir`, or null when it is not inside a git repo (or does not exist). Never `git init`s. */
export async function repoRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.stdout.trim() : null;
}

/**
 * The branch currently checked out at `dir`, or null (detached HEAD, an empty repo with no commit
 * yet). Reads the full ref and strips the `refs/heads/` prefix ourselves, rather than asking git
 * for `--short`: git's own shortening is ambiguity-aware, so a tag sharing the branch's short name
 * makes `--short` hand back `"heads/<name>"` instead of `"<name>"` to disambiguate — exactly the
 * tag-hijack shape (reviewer, slice A, MEDIUM), just leaking through here instead of a merge.
 */
export async function currentBranch(dir) {
  const r = await git(dir, ["symbolic-ref", "HEAD"]);
  if (!r.ok) return null;
  const ref = r.stdout.trim();
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

/** Where a role's worktree lives, and the branch it runs on: siblings of the repo, like `../vyre-<team>`. */
export const worktreePath = (repo, role) => path.join(path.dirname(repo), `${path.basename(repo)}-${role}`);
export const branchOf = role => `team/${role}`;

/**
 * A branch name, fully qualified as `refs/heads/<name>`, for every place vyred hands a branch or
 * base name to git as a revision. A bare name is ambiguous: gitrevisions' own disambiguation order
 * checks `refs/tags/<name>` *before* `refs/heads/<name>`, so a teammate's Bash (a worktree is not
 * a security boundary) can plant a tag named like the base branch — "main", say — and have every
 * merge and every diff range vyred computes quietly run against that tag's commit instead of the
 * real branch tip (reviewer, slice A, MEDIUM). Never applied to a plain sha or to "HEAD".
 */
export const B = name => `refs/heads/${name}`;

/** Does this branch already exist in the repo? */
async function hasBranch(repo, branch) {
  return (await git(repo, ["show-ref", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}`])).ok;
}

/** `dir`'s shared git dir, as an absolute real path, or null. */
async function commonDir(dir) {
  const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!r.ok) return null;
  try { return fs.realpathSync(r.stdout.trim()); } catch { return null; }
}

/**
 * Is the folder at `dir` really this repo's own worktree for `branch`, and not something else
 * that happens to sit at that path (the person's own unrelated `acme-design` beside `acme`, or a
 * folder a teammate made there first)? Reviewer, slice A, MEDIUM.
 */
export async function isOwnWorktree(repo, dir, branch) {
  if (!fs.existsSync(dir)) return false;
  const [mine, theirs] = await Promise.all([commonDir(repo), commonDir(dir)]);
  return Boolean(mine && theirs && mine === theirs && (await currentBranch(dir)) === branch);
}

/**
 * A role's worktree, made if it does not exist yet: its own branch, off `base`, never touching
 * the person's own checkout (a plain `git worktree add`, not a checkout in the repo's own folder).
 * A folder already there must be this repo's own worktree on this role's branch, or it is refused.
 * @param {string} repo @param {string} role @param {string} base
 */
export async function ensureWorktree(repo, role, base) {
  const dir = worktreePath(repo, role), branch = branchOf(role);
  if (fs.existsSync(dir)) {
    if (await isOwnWorktree(repo, dir, branch)) return { ok: true, dir, branch };
    return { ok: false, dir, branch, stderr: `${dir} already exists and is not this repo's own ${branch} worktree; move it aside, or pick another role` };
  }
  const bad = await unsafeConfig(repo);
  if (bad.length) return { dir, branch, ...refuse(bad, "check out a worktree") };
  // The re-add case (an existing branch) takes the bare `branch`, not `B(branch)`: unlike merge,
  // rev-parse and the rest of this file, `worktree add <dir> <name>` resolves a bare name through
  // its own branch dwim (refs/heads/<name> first, to check the branch out) before it is ever
  // treated as a generic revision, so a same-named tag can't hijack it here either way — but a
  // fully qualified refs/heads/<name> defeats that dwim outright and checks out a detached HEAD
  // instead (reviewer, slice A, MEDIUM, reproduced): isOwnWorktree then finds no branch at all,
  // and every request to a re-added teammate fails as "not its own worktree any more".
  const args = (await hasBranch(repo, branch))
    ? ["worktree", "add", "--end-of-options", dir, branch]
    : ["worktree", "add", "-b", branch, "--end-of-options", dir, B(base)];
  const r = await git(repo, args);
  return { ok: r.ok, dir, branch, stderr: r.stderr };
}

/**
 * Merge `base` into the branch checked out at a worktree. Vyred does this before every request,
 * never the model. A conflict is backed out at once (`merge --abort`), so the worktree is always
 * clean for the next attempt: the request that hit it just fails, with the conflict in its result.
 */
export async function mergeBaseIn(worktreeDir, base) {
  const bad = await unsafeConfig(worktreeDir);
  if (bad.length) return refuse(bad, "merge");
  const r = await git(worktreeDir, [...VYRE_IDENTITY, "merge", "--no-verify", "--no-edit", "-m", `merge ${base} for the next request`, "--end-of-options", B(base)]);
  if (!r.ok) await git(worktreeDir, ["merge", "--abort"]);
  return r;
}

/** Is `branch` ahead of `base` (real commits worth merging back)? */
export async function aheadOf(repo, branch, base) {
  const r = await git(repo, ["rev-list", "--count", "--end-of-options", `${B(base)}..${B(branch)}`]);
  return r.ok && Number(r.stdout.trim()) > 0;
}

/** `base..branch`, as the short shas a merge request names ("team/design a1b2c3d..9e8f7a6"). */
export async function shaRange(repo, branch, base) {
  const from = await git(repo, ["merge-base", "--end-of-options", B(base), B(branch)]);
  const to = await git(repo, ["rev-parse", "--verify", "--end-of-options", B(branch)]);
  if (!from.ok || !to.ok) return null;
  return { from: from.stdout.trim().slice(0, 7), to: to.stdout.trim().slice(0, 7) };
}

/**
 * The commit a ref currently names, or null. `ref` is used exactly as given — "HEAD", or a sha —
 * so a caller naming a branch must qualify it itself with `B()`; this does not do it for them.
 */
export async function headSha(dir, ref) {
  const r = await git(dir, ["rev-parse", "--verify", "--end-of-options", ref]);
  return r.ok ? r.stdout.trim() : null;
}

/**
 * The integrator's own worktree, reset to `mainSha` (section 8: "reset to main before each
 * merge"), discarding whatever it held from a previous attempt. Vyred's own act. No
 * `--end-of-options`: unlike the parse-options commands elsewhere in this file, `git reset`'s own
 * argument parser refuses that flag outright ("must come before non-option arguments") whatever
 * position it is given, so it cannot be added here — safe anyway, since `sha` is never raw
 * caller-controlled text: it is always a hash `headSha()` itself already read with `--verify`.
 */
export async function resetTo(worktreeDir, sha) {
  const bad = await unsafeConfig(worktreeDir);
  if (bad.length) return refuse(bad, "reset the integrator's worktree");
  return git(worktreeDir, ["reset", "--hard", sha]);
}

/**
 * Merge a teammate's own branch into the integrator's current checkout (already reset to main's
 * tip). Unlike mergeBaseIn, a conflict is left exactly as git leaves it (MERGE_HEAD, the
 * conflicted files with their markers): resolving it is the integrator's own session's job
 * (section 8, "resolves conflicts itself when it can, reading both sides"), not something to
 * clean up before it ever sees it.
 */
export function mergeBranchIn(worktreeDir, branch) {
  // --no-ff: a fast-forwardable merge (the common case — a teammate's branch with nothing new
  // from main since it forked) would otherwise silently move the ref with no merge commit at
  // all, so the result vyred reports ("Merged <branch> into <base>, a..b") and what team.merge
  // actually checks in (a real commit whose message names the merge) would both be a fiction.
  return unsafeConfig(worktreeDir).then(bad => bad.length ? refuse(bad, "merge")
    : git(worktreeDir, [...VYRE_IDENTITY, "merge", "--no-verify", "--no-edit", "--no-ff", "-m", `merge ${branch}`, "--end-of-options", B(branch)]));
}

/** True once every conflict marker from a failed merge is gone (the integrator's own edits resolved it, and it was `git add`ed). */
export async function stillConflicted(worktreeDir) {
  const r = await git(worktreeDir, ["diff", "--name-only", "--diff-filter=U"]);
  return r.ok && r.stdout.trim().length > 0;
}

/**
 * Move `ref` from `fromSha` to `toSha`, only if it still names `fromSha` right now: a
 * compare-and-swap (section 8), so a `ref` moved by anything else since vyred last read it (a
 * teammate's own Bash can write the shared .git; a worktree is not a security boundary) fails
 * this instead of being silently overwritten. `fromSha` must be a value vyred itself recorded,
 * never read fresh from the ref it is about to swap — that would defeat the whole check.
 */
export async function compareAndSwap(repo, ref, fromSha, toSha) {
  return (await git(repo, ["update-ref", `refs/heads/${ref}`, toSha, fromSha])).ok;
}

/** A project's own test command, guessed from what is in its repo. null when none is obvious: no tests are run, and a merge needs only a clean merge. */
export async function detectTestCommand(repo) {
  try { if (JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).scripts?.test) return "npm test"; } catch {}
  if (fs.existsSync(path.join(repo, "pytest.ini")) || fs.existsSync(path.join(repo, "setup.cfg"))) return "pytest";
  if (fs.existsSync(path.join(repo, "go.mod"))) return "go test ./...";
  if (fs.existsSync(path.join(repo, "Cargo.toml"))) return "cargo test";
  return null;
}

/**
 * Run a project's own test command in `dir`. No shell (the command is split on plain spaces, its
 * first word run directly): a project's test command is its own declared, editable setting, not
 * untrusted repo content, but this still never hands anything to `/bin/sh`.
 * @param {string} dir @param {string} command @param {number} [ms]
 */
export function runTests(dir, command, ms = 180_000) {
  const [cmd, ...args] = String(command).trim().split(/\s+/);
  return new Promise(resolve => {
    execFile(cmd, args, { cwd: dir, timeout: ms, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, CI: "1" } },
    (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) }));
  });
}
