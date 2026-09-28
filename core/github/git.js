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

// GitHub's own charset for the two path segments in owner/name (reviewer, e5a612c0 review, LOW):
// bounded and specific enough that neither can smuggle a ".." or a "?" into an api.github.com
// path built from it (repoName's old `[^/\s]+` for owner let "../user" resolve to /user). name
// keeps its own explicit "." / ".." exclusion below since its charset (unlike owner's) allows dots.
const OWNER_CHARS = "[A-Za-z0-9-]{1,39}";
const NAME_CHARS = "[A-Za-z0-9._-]{1,100}";
const HTTPS_ORIGIN = new RegExp(`^https?://(?:[^@/\\s]+@)?github\\.com[:/](${OWNER_CHARS})/(${NAME_CHARS}?)(?:\\.git)?/?$`, "i");
const SSH_ORIGIN = new RegExp(`^(?:ssh://)?git@github\\.com[:/](${OWNER_CHARS})/(${NAME_CHARS}?)(?:\\.git)?/?$`, "i");

/** `owner/name`, or null when `name` is exactly "." or ".." (the charset above allows dots, unlike owner's). */
function ownerName(owner, name) {
  return name === "." || name === ".." ? null : `${owner}/${name}`;
}

/**
 * A git remote URL's `owner/name`, or null when it is not github.com at all. Reads https
 * (`https://github.com/owner/name(.git)`, with or without a userinfo prefix), ssh
 * (`git@github.com:owner/name(.git)`) and the `ssh://` long form, since a folder's own origin
 * may have been cloned any of those ways before Vyre ever saw it.
 * @param {string} url
 */
export function originFullName(url) {
  const s = String(url || "").trim();
  const https = HTTPS_ORIGIN.exec(s);
  if (https) return ownerName(https[1], https[2]);
  const ssh = SSH_ORIGIN.exec(s);
  if (ssh) return ownerName(ssh[1], ssh[2]);
  return null;
}

/**
 * A remote URL with any embedded credential, query string or fragment stripped, for anything
 * that shows a remote's URL to a person (reviewer, e5a612c0 review, MEDIUM: a folder cloned by
 * hand as `https://user:ghp_...@github.com/...` was sending that token straight back out through
 * `github.project.detect`). Only a `scheme://` URL can carry userinfo like that; the scp-like ssh
 * form (`git@host:path`) has no such syntax, so it is returned unchanged. Never throws: an
 * unparsable URL is returned as-is rather than dropped.
 * @param {string} url
 */
export function sanitizeRemoteUrl(url) {
  const s = String(url || "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch { return s; }
}

/** The URL a named remote points at, or null when the repo has no remote by that name. */
export async function remoteUrl(dir, name) {
  const r = await gitAsync(dir, ["remote", "get-url", safeSegment(name, "remote name")]);
  return r.ok ? r.stdout.trim() : null;
}

/** Every remote in `dir`: `[{ name, url }]`, in git's own listing order. Local-only, no network. `url` is exactly what git reports, not sanitized - callers that show it to a person use `sanitizeRemoteUrl` first (`github.project.detect` does). */
export async function listRemotes(dir) {
  const names = await gitAsync(dir, ["remote"]);
  if (!names.ok) return [];
  const out = [];
  for (const name of names.stdout.split("\n").map(s => s.trim()).filter(Boolean)) {
    const url = await remoteUrl(dir, name);
    if (url) out.push({ name, url });
  }
  return out;
}

/**
 * Whether `dir` is a git repository at all, and every remote it has (`[]` when it isn't a repo,
 * or is one with none). Local-only, no network, no token: this is what `github.project.detect`
 * reads per workspace, so a folder never needs to belong to `github_projects` for the person to
 * see what's already there.
 * @param {string} dir
 */
export async function folderGitState(dir) {
  const top = await gitAsync(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!top.ok || top.stdout.trim() !== "true") return { isRepo: false, remotes: [] };
  return { isRepo: true, remotes: await listRemotes(dir) };
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
 * Whether a session's worktree is safe to remove with no loss: no uncommitted change, no
 * untracked OR ignored file (a plain `git status --porcelain` skips ignored files, but a `.env`,
 * build output, a downloaded dataset or a local database in a session's worktree is exactly what
 * matters — the reviewer's MEDIUM on 58d0dd87), and no commit that isn't already on the default
 * branch or some remote (the user's binding rule: no auto-delete, ever, of anything that would
 * actually be lost).
 * @param {{ repoDir: string, dest: string, branch: string, defaultBranch: string }} p
 */
async function worktreeSafety({ repoDir, dest, branch, defaultBranch }) {
  const status = await gitAsync(dest, ["status", "--porcelain", "--ignored"]);
  const dirty = status.ok ? status.stdout.split("\n").map(l => l.trim()).filter(Boolean) : ["(could not read the worktree's status)"];
  // refs/heads/<name>: safeSegment already rules out a leading dash on the session branch, and
  // this is the belt-and-braces form regardless — a revision argument that cannot be read as an
  // option however it was produced (also covers defaultBranch, which comes from GitHub's API,
  // not safeSegment). `--end-of-options` was tried here too and reverted: once given, git treats
  // every later argument as non-option, including `--not` and `--remotes` themselves, so it
  // broke the very flags this call needs — the refs/heads/ prefix alone already makes the value
  // unable to start with `-`, which is the actual protection; there is nothing left for
  // --end-of-options to add once nothing here can be misread as an option in the first place.
  const rev = await gitAsync(repoDir, ["rev-list", `refs/heads/${branch}`, "--not", `refs/heads/${defaultBranch}`,
    "--remotes", "--pretty=oneline", "--abbrev-commit"]);
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
  // `git branch -d` takes the short branch name, not a full ref (refs/heads/<branch> is not
  // found under that spelling) - safeSegment already rules out a leading dash here, which is the
  // actual protection this call needs.
  const del = await gitAsync(repoDir, ["branch", "-d", branch]);
  return { removed: true, pruned: del.ok };
}
