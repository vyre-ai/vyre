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
  } catch {
    // Fails CLOSED, never the raw input (reviewer, 5b1c69f1 review, LOW): WHATWG URL can throw on
    // a value that still has a real userinfo prefix to leak, an out-of-range port being the
    // reviewer's own repro (`http://u:p@github.com:99999/o/r`). A userinfo prefix has a fixed
    // shape even when the rest of the URL doesn't parse, so strip it with a regex instead, and
    // cut anything from a `?` or `#` too, the same two things the happy path also strips.
    return s.replace(/\/\/[^/@]*@/, "//").split(/[?#]/)[0];
  }
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
  // Unarchive: the session's worktree was removed but its branch (and any commits on it) stays, so
  // an existing branch is checked out as it is, never reset to the default branch. A worktree that
  // is still there is returned as it is.
  if (fs.existsSync(dest)) return { path: dest, branch };
  const have = await gitAsync(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const r = await gitAsync(repoDir, have.ok
    ? ["worktree", "add", dest, branch]
    : ["worktree", "add", dest, "-b", branch, defaultBranch]);
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
export async function worktreeRemove({ repoDir, session, defaultBranch, deleted = false }) {
  const id = safeSegment(session, "session id");
  const dest = path.join(repoDir, ".sessions", id);
  const branch = `vyre/${id}`;
  if (!fs.existsSync(dest)) return { removed: false, existed: false };
  if (deleted) {
    // The chat was deleted: keep its work under the undo ref (uncommitted changes as one marked
    // commit first), then remove the worktree. Ignored files (.env, build output) are the one thing
    // a commit does not keep, so they still stop the removal and are handed to a person.
    const ig = await gitAsync(dest, ["ls-files", "--others", "--ignored", "--exclude-standard"]);
    const ignored = ig.ok ? ig.stdout.split("\n").map(l => l.trim()).filter(Boolean) : ["(could not read the worktree's ignored files)"];
    if (ignored.length) return { removed: false, needsConfirm: true, path: dest, branch, dirty: ignored, commits: [] };
    await saveDirty(dest);
    const ahead = await gitAsync(dest, ["rev-list", "--count", `refs/heads/${defaultBranch}..HEAD`]);
    const saved = Number(ahead.stdout.trim()) > 0 ? await saveTip(repoDir, dest, id) : null;
    const rm = await gitAsync(repoDir, ["worktree", "remove", dest]);
    if (!rm.ok) throw fail(`git worktree remove failed: ${rm.stderr.trim().slice(0, 300) || "no output"}`, "cleanup_failed");
    const del = await gitAsync(repoDir, ["branch", "-d", branch]);
    return { removed: true, pruned: del.ok, ...(saved ? { saved_as: saved.ref } : {}) };
  }
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

/**
 * A repo's own idea of its default branch, for a repo that never went through `github.project`
 * (0.2, charter "projects work with or without GitHub" - a local-only or hand-cloned repo has no
 * `github_projects` row to read a `default_branch` from). Prefers `origin/HEAD` (what a real
 * GitHub/GitLab clone already reports); a repo with no remote falls back to whatever branch is
 * currently checked out (a fresh `git init`'s first branch). Local-only, no network.
 * @param {string} repoDir
 */
export async function defaultBranchOf(repoDir) {
  const origin = await gitAsync(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (origin.ok) return origin.stdout.trim().replace(/^origin\//, "");
  const head = await gitAsync(repoDir, ["symbolic-ref", "--short", "HEAD"]);
  return head.ok ? head.stdout.trim() : null;
}

// Common secret shapes, checked against the *added* lines of an outgoing push before it's ever
// sent (0.2, reviewer's M8/H0a fix on the review of plans/github.md). Not exhaustive; a real,
// useful floor, not a promise nothing ever gets through. A future pass can also match known vault
// values by hash (the reviewer's own suggestion), once vault exposes that; this file doesn't
// invent an API vault hasn't shipped.
const SECRET_PATTERNS = [
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |)PRIVATE KEY-----/ },
  { name: "a secret-looking assignment", re: /\b(?:SECRET|API_KEY|ACCESS_KEY|ACCESS_TOKEN|PASSWORD|PRIVATE_KEY)\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{16,}["']?/i },
];

/**
 * Scan only the lines a push would actually add (`branch` minus `defaultBranch`) for a known
 * secret shape, before the push happens. Returns the first hit (`{ pattern, file, line }`), or
 * null. Local-only, no network: reads git's own diff.
 * @param {{ repoDir: string, branch: string, defaultBranch: string }} p
 */
export async function scanOutgoing({ repoDir, branch, defaultBranch }) {
  const diff = await gitAsync(repoDir, ["diff", "--unified=0", `refs/heads/${defaultBranch}...refs/heads/${branch}`]);
  if (!diff.ok) return null; // can't diff (no such branch, no such default) - the push call itself will fail plainly next
  let file = null, line = 0;
  for (const l of diff.stdout.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(6).replace(/^b\//, ""); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (l.startsWith("+++") || !l.startsWith("+")) continue;
    for (const p of SECRET_PATTERNS) if (p.re.test(l)) return { pattern: p.name, file: file || "(unknown file)", line };
    line++;
  }
  return null;
}

/**
 * Where a token-carrying push may go: the repo's own repo on github.com, built from Vyre's own
 * record (`fullName`, from the project's github_projects row), never read from `.git/config`,
 * which an agent's shell can edit (`remote set-url`, `pushurl`, `url.<x>.insteadOf`). Config that
 * could still redirect or observe the connection is refused, or overridden on the command line
 * (command-line settings beat the repo's own), before the token is handed over.
 * @param {string} repoDir @param {string} url
 * @returns {Promise<string | null>} why not, or null when the destination is exactly `url`
 */
async function pushTargetProblem(repoDir, url) {
  // The repo's own config (local and per-worktree scopes: the ones a shell in the repo can write;
  // the person's global config is not read at all) may not carry anything that reaches the
  // network path: http.* (curloptResolve, sslCAInfo, proxy, extraHeader...), credential.*, url.*
  // rewrites, protocol.*, core.gitProxy, core.askPass.
  for (const scope of ["--local", "--worktree"]) {
    const cfg = await gitAsync(repoDir, ["config", scope, "--name-only", "--get-regexp", "."]);
    for (const key of cfg.ok ? cfg.stdout.split("\n").map(k => k.trim().toLowerCase()).filter(Boolean) : []) {
      if (/^(https?|credential|url|protocol)\./.test(key) || key === "core.gitproxy" || key === "core.askpass") {
        return `this repo's own git config sets ${key.replace(/^(url\.).*(\.[a-z]+)$/, "$1...$2")}, which could send the token somewhere other than GitHub; remove it and try again`;
      }
    }
  }
  const got = await gitAsync(repoDir, ["ls-remote", "--get-url", url]);
  if (!got.ok || got.stdout.trim() !== url) return "the push address does not resolve to the project's own GitHub repo";
  return null;
}

/** Config that could send a github.com connection through someone else, forced off for a push. */
const NO_DETOURS = ["-c", "http.proxy=", "-c", "https.proxy=", "-c", "http.https://github.com/.proxy=", "-c", "http.sslVerify=true",
  "-c", "http.curloptResolve=", "-c", "http.sslCAInfo=", "-c", "http.sslCAPath=", "-c", "http.extraHeader=", "-c", "credential.https://github.com.helper="];

/**
 * Push a session's own branch, and only that branch, to the same name on the project's own repo
 * (`https://github.com/<fullName>.git`, built here from the project's record, never `origin` and
 * never anything from `.git/config`) - an explicit refspec, never `--force` (not even
 * with-lease), and never anything but this one branch. Runs `scanOutgoing` first and refuses on
 * a hit unless `allowSecret` (the caller decides who may set it; see github.session.push). A
 * non-fast-forward remote (someone else pushed to the same branch) is reported, never
 * overwritten (reviewer's M2). fd-3 token only, the same isolation `cloneRepo` already has.
 * `base` is a test seam; the tool never passes it.
 * @param {{ repoDir: string, session: string, defaultBranch: string, token: string, fullName: string, allowSecret?: boolean, base?: string }} p
 */
export async function pushSession({ repoDir, session, defaultBranch, token, fullName, allowSecret = false, base = "https://github.com" }) {
  const branch = `vyre/${safeSegment(session, "session id")}`;
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(String(fullName || "")) || /(^|\/)\.\.?$/.test(fullName)) throw fail("the project's recorded repo name is not owner/name", "bad_input");
  if (!allowSecret) {
    const hit = await scanOutgoing({ repoDir, branch, defaultBranch });
    if (hit) return { pushed: false, blocked: "secret", ...hit };
  }
  const url = `${base}/${fullName}.git`;
  const bad = await pushTargetProblem(repoDir, url);
  if (bad) throw fail(`not pushing: ${bad}`, "remote_changed");
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  const r = await gitWithAskpass(repoDir, [...NO_DETOURS, "push", "--", url, refspec], { token, timeout: 120_000 });
  if (r.ok) {
    // Keep "is this commit on a remote" (worktree cleanup's safety check) true after a push by URL.
    const sha = await gitAsync(repoDir, ["rev-parse", `refs/heads/${branch}`]);
    if (sha.ok) await gitAsync(repoDir, ["update-ref", `refs/remotes/origin/${branch}`, sha.stdout.trim()]);
    return { pushed: true, branch };
  }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(r.stderr)) {
    return { pushed: false, blocked: "non_fast_forward", detail: r.stderr.trim().slice(0, 300) };
  }
  throw fail(`git push failed: ${r.stderr.trim().slice(0, 300) || "no output"}`, "push_failed");
}

/** File names never swept into the starting commit of a project Vyre turns into a repo. */
const KEEP_OUT = [".env", ".env.*", "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*", ".sessions/"];
const IDENT = ["-c", "user.name=Vyre", "-c", "user.email=vyre@localhost", "-c", "commit.gpgsign=false"];

/**
 * Make a folder a git repo with one starting commit, so a session gets its own worktree and branch
 * (undo and isolation) with no GitHub involved. Local only, no network, no token, no remote.
 * - Not a repo: `git init -b main`, then a starting commit of what is there, minus secret-looking
 *   files (listed in `left_out`, and kept out through the repo's own .git/info/exclude, never a
 *   committed file).
 * - A repo with no commit yet: the same starting commit.
 * - A repo that already has commits: nothing changes (`already: true`).
 * @param {string} dir
 */
export async function localInit(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw fail(`${dir} is not a folder`, "not_found");
  const state = await folderGitState(dir);
  // A folder inside someone else's repo is not this project's repo: only its own top counts.
  if (state.isRepo) {
    const top = await gitAsync(dir, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(dir)) {
      throw fail(`${dir} is inside another git repo (${top.stdout.trim()}); a project's home has to be its own folder`, "nested_repo");
    }
  }
  const before = state.isRepo ? await gitAsync(dir, ["rev-parse", "--verify", "HEAD"]) : { ok: false };
  if (before.ok) return { already: true, branch: await defaultBranchOf(dir), left_out: [] };
  if (!state.isRepo) {
    const r = await gitAsync(dir, ["init", "-q", "-b", "main"]);
    if (!r.ok) throw fail(`git init failed: ${r.stderr.trim().slice(0, 300)}`, "init_failed");
  }
  const file = path.join(dir, ".git", "info", "exclude");
  let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch {}
  const have = new Set(text.split("\n").map(l => l.trim()));
  const add = KEEP_OUT.filter(l => !have.has(l));
  if (add.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text && !text.endsWith("\n") ? text + "\n" : text}${add.join("\n")}\n`);
  }
  const a = await gitAsync(dir, ["add", "-A"]);
  if (!a.ok) throw fail(`git add failed: ${a.stderr.trim().slice(0, 300)}`, "init_failed");
  const c = await gitAsync(dir, [...IDENT, "commit", "-q", "--allow-empty", "-m", "Start of project"]);
  if (!c.ok) throw fail(`git commit failed: ${c.stderr.trim().slice(0, 300)}`, "init_failed");
  const ig = await gitAsync(dir, ["ls-files", "--others", "--ignored", "--exclude-standard"]);
  const left_out = ig.ok ? ig.stdout.split("\n").filter(Boolean).filter(f => !f.startsWith(".sessions/")).slice(0, 50) : [];
  return { already: false, branch: "main", left_out };
}

const wtPath = (repoDir, session) => path.join(repoDir, ".sessions", safeSegment(session, "session id"));
const isSha = s => typeof s === "string" && /^[0-9a-f]{7,40}$/i.test(s);

/**
 * A session branch's own commits, newest first: `[{ sha, subject }]`, everything on it that is not
 * on the default branch. Read only. `dirty` is whether the worktree has uncommitted changes.
 * @param {{ repoDir: string, session: string, defaultBranch: string }} p
 */
export async function sessionHistory({ repoDir, session, defaultBranch }) {
  const dest = wtPath(repoDir, session);
  if (!fs.existsSync(dest)) throw fail(`no worktree for session ${session}`, "not_found");
  const log = await gitAsync(dest, ["log", "--format=%H%x09%s", `refs/heads/${defaultBranch}..HEAD`]);
  if (!log.ok) throw fail(`git log failed: ${log.stderr.trim().slice(0, 300)}`, "failed");
  const commits = log.stdout.split("\n").filter(Boolean).map(l => { const [sha, ...s] = l.split("\t"); return { sha, subject: s.join("\t") }; });
  const st = await gitAsync(dest, ["status", "--porcelain"]);
  return { commits, dirty: st.ok ? st.stdout.split("\n").filter(Boolean).length : 0 };
}

const WIP = "vyre: unsaved changes (kept by undo)";

/** Commit whatever is uncommitted in a session's worktree (tracked or new, not ignored) as one marked commit. True when there was something. */
async function saveDirty(dest) {
  const st = await gitAsync(dest, ["status", "--porcelain"]);
  if (!st.ok || !st.stdout.trim()) return false;
  const a = await gitAsync(dest, ["add", "-A"]);
  if (!a.ok) throw fail(`could not keep the unsaved changes first, so nothing was undone: ${a.stderr.trim().slice(0, 200)}`, "failed");
  const c = await gitAsync(dest, [...IDENT, "commit", "-q", "-m", WIP]);
  if (!c.ok) throw fail(`could not keep the unsaved changes first, so nothing was undone: ${c.stderr.trim().slice(0, 200)}`, "failed");
  return true;
}

/** Save `HEAD` under refs/vyre/undone/<id>/<n> and return that ref and n. */
async function saveTip(repoDir, dest, id) {
  const head = (await gitAsync(dest, ["rev-parse", "HEAD"])).stdout.trim();
  const n = (await gitAsync(repoDir, ["for-each-ref", "--format=%(refname)", `refs/vyre/undone/${id}/`])).stdout.split("\n").filter(Boolean).length + 1;
  const ref = `refs/vyre/undone/${id}/${n}`;
  const save = await gitAsync(repoDir, ["update-ref", ref, head]);
  if (!save.ok) throw fail(`could not save the current state first, so nothing was undone: ${save.stderr.trim().slice(0, 200)}`, "failed");
  return { ref, n, head };
}

/**
 * Undo a session's commits back to `to` (a commit already on the session branch, default: where the
 * session started, the default branch's tip it was cut from). Nothing is deleted: uncommitted
 * changes are first committed as one marked commit, the tip is saved as refs/vyre/undone/<session>/<n>,
 * and `sessionRedo` puts everything back (the unsaved changes as uncommitted again). No refusal.
 * @param {{ repoDir: string, session: string, defaultBranch: string, to?: string }} p
 */
export async function sessionUndo({ repoDir, session, defaultBranch, to }) {
  const dest = wtPath(repoDir, session);
  const id = safeSegment(session, "session id");
  if (!fs.existsSync(dest)) throw fail(`no worktree for session ${session}`, "not_found");
  const hadDirty = await saveDirty(dest);
  const h = await sessionHistory({ repoDir, session, defaultBranch });
  if (!h.commits.length) throw fail("this session has no commits to undo", "nothing_to_undo");
  let target, undone = h.commits.length;
  if (to != null) {
    if (!isSha(to)) throw fail("to must be a commit id from the session's history", "bad_input");
    const inList = h.commits.find(c => c.sha.startsWith(to.toLowerCase()));
    if (!inList) throw fail("that commit is not on this session's branch", "bad_input");
    target = `${inList.sha}^`;
    undone = h.commits.indexOf(inList) + 1;
  } else {
    target = `${h.commits[h.commits.length - 1].sha}^`;
  }
  const { ref, n } = await saveTip(repoDir, dest, id);
  const reset = await gitAsync(dest, ["reset", "--hard", "-q", target]);
  if (!reset.ok) throw fail(`git reset failed: ${reset.stderr.trim().slice(0, 300)}`, "failed");
  const now = (await gitAsync(dest, ["rev-parse", "HEAD"])).stdout.trim();
  return { undone: hadDirty ? undone - 1 : undone, saved_as: ref, n, head: now, kept_unsaved: hadDirty };
}

/**
 * Put back what the latest (or numbered) undo took off: fast-forwards the session branch to the saved
 * tip, only when the branch has not moved on since (else refused, nothing changes).
 * @param {{ repoDir: string, session: string, n?: number }} p
 */
export async function sessionRedo({ repoDir, session, n }) {
  const dest = wtPath(repoDir, session);
  const id = safeSegment(session, "session id");
  if (!fs.existsSync(dest)) throw fail(`no worktree for session ${session}`, "not_found");
  const refs = (await gitAsync(repoDir, ["for-each-ref", "--format=%(refname)", `refs/vyre/undone/${id}/`])).stdout.split("\n").filter(Boolean);
  const nums = refs.map(r => Number(r.split("/").pop())).sort((a, b) => a - b);
  const pick = n ?? nums[nums.length - 1];
  if (!pick || !nums.includes(pick)) throw fail("nothing to redo", "nothing_to_redo");
  const st = await gitAsync(dest, ["status", "--porcelain"]);
  if (st.ok && st.stdout.trim()) throw fail("the session has uncommitted changes; undo or commit them first", "dirty");
  const m = await gitAsync(dest, ["merge", "--ff-only", "-q", `refs/vyre/undone/${id}/${pick}`]);
  if (!m.ok) throw fail("the session has moved on since that undo, so it cannot be put back cleanly; its saved commits are still kept", "diverged");
  // The marked commit was only a way to keep unsaved work: bring it back as uncommitted changes.
  const subj = (await gitAsync(dest, ["log", "-1", "--format=%s"])).stdout.trim();
  const restored = subj === WIP && (await gitAsync(dest, ["reset", "-q", "--mixed", "HEAD^"])).ok;
  return { redone: pick, restored_unsaved: restored, head: (await gitAsync(dest, ["rev-parse", "HEAD"])).stdout.trim() };
}
