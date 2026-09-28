// @ts-check
// git — the mechanical half of code isolation (ADR 0031 section 8): finding a project's repo,
// giving a worktree-isolated teammate its own worktree and branch, and merging the project's
// branch into it before each request. Vyred runs every one of these, never the model, and never
// `git init`s on the person's behalf (team.add refuses isolation: worktree outside a real repo).
//
// No shell, no prompt, no network, a deadline: the same pattern core/switchboard/changes.js uses
// for `git diff --numstat` behind a push ask.
//
// And nothing the repo says to run (e2e and reviewer, slice A, HIGH). A teammate writes the
// repo's shared .git to commit, so it can plant hooks, set config that names programs, or add a
// .gitattributes naming a filter or merge driver. vyred's own git would then run that program as
// vyred's own child: outside Claude's permission floor, and, on a Mac, with vyred's ancestry, not
// claude's, so the socket would take it for the person. So every call:
//   - turns off what can be turned off from the command line, which beats any repo config:
//     hooks (core.hooksPath=/dev/null, and --no-verify on merge), signing and signature checks,
//     the global attributes file, fsmonitor, the pager and editors, ssh (protocol.allow=never);
//   - reads no system or global config (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null);
// and anything that runs git's content through a program named only in repo config (a filter, a
// diff textconv, a merge driver), or pulls in config from elsewhere (include, includeIf), or an
// alias, cannot be switched off by name from here, so checkout and merge refuse to run at all
// while the repo's own config has one, and say which (unsafeConfig).
//
// Revs and paths go after --end-of-options. Branch names come only from `symbolic-ref` on the
// person's own checkout and from a teammate's role, which team.add has already checked against
// its NAME pattern, so neither can start with "-" anyway.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_MS = 15_000;

/** Settings a repo's own config cannot override, since the command line wins. */
const OFF = ["protocol.allow=never", "core.fsmonitor=false", "core.hooksPath=/dev/null", "commit.gpgSign=false", "tag.gpgSign=false",
  "merge.verifySignatures=false", "core.attributesFile=/dev/null", "core.pager=cat", "core.editor=:", "sequence.editor=:", "core.sshCommand=false"]
  .flatMap(kv => ["-c", kv]);

/** Whoever made a merge vyred ran: vyred, not whoever last committed. Global config is off, so git would otherwise refuse to guess. */
const VYRED = { GIT_AUTHOR_NAME: "Vyre", GIT_AUTHOR_EMAIL: "vyre@localhost", GIT_COMMITTER_NAME: "Vyre", GIT_COMMITTER_EMAIL: "vyre@localhost" };

/**
 * Run git in `dir`. Never rejects.
 * @param {string} dir @param {string[]} args @param {{ ms?: number, env?: Record<string, string> }} [o]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>}
 */
export function git(dir, args, { ms = GIT_MS, env = {} } = {}) {
  return new Promise(resolve => {
    execFile("git", [...OFF, "-C", dir, ...args], {
      timeout: ms, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat", PAGER: "cat", LC_ALL: "C", GIT_ASKPASS: "", SSH_ASKPASS: "",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...env },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) }));
  });
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
 * real branch tip (reviewer, slice A, MEDIUM). Never applied to a plain sha or to "HEAD", and
 * never to `worktree add`'s own branch argument (see ensureWorktree: that one call resolves a
 * bare name through its own branch dwim, and a fully qualified name defeats it, checking out a
 * detached HEAD instead — a second, distinct MEDIUM the reviewer found once this fix landed).
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
  const r = await git(worktreeDir, ["merge", "--no-verify", "--no-edit", "-m", `merge ${base} for the next request`, "--end-of-options", B(base)], { env: VYRED });
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
