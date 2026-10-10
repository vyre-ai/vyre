// @ts-check
// lib/publish/repo-source: which repo a deployment's source may name, and how it is cloned. Only a public https GitHub repo (github.com/<owner>/<name>, with an optional #branch) is cloned; the clone is
// shallow, takes no hooks, asks for no password and speaks no protocol but https. Pure text and argument lists, so the module that runs git and its tests agree.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;

/**
 * @param {string} ref `owner/name`, `owner/name#branch`, or `https://github.com/owner/name(.git)(#branch)`
 * @returns {{ ok: true, url: string, branch: string | null, owner: string, name: string } | { ok: false, error: string }}
 */
export function repoOf(ref) {
  const text = String(ref || "").trim();
  const [rest, branchRaw] = text.split("#");
  const branch = branchRaw === undefined ? null : branchRaw;
  const m = /^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(rest || "");
  if (!m) return { ok: false, error: "a repo is named owner/name, or https://github.com/owner/name, with an optional #branch; only GitHub repos are cloned" };
  const [, owner, name] = m;
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return { ok: false, error: "that is not a GitHub owner and repo name" };
  if (branch !== null && (!BRANCH.test(branch) || branch.split("/").includes("..") || branch.startsWith("-"))) return { ok: false, error: "that is not a branch name" };
  return { ok: true, url: `https://github.com/${owner}/${name}.git`, branch, owner, name };
}

/** The git arguments of the clone: shallow, one branch, no hooks, https only, nothing read from the machine's own git settings. @param {string} url @param {string | null} branch @param {string} dir */
export function cloneArgs(url, branch, dir) {
  return ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "credential.helper=", "-c", "core.fsmonitor=false", "clone", "--depth", "1", "--single-branch", "--no-tags", "--quiet", "--filter=blob:limit=5m", ...(branch ? ["--branch", branch] : []), "--", url, dir];
}

/** The most a clone may weigh on disk, in bytes: a public repo is read to be published, not mirrored. */
export const CLONE_MAX_BYTES = 300 * 1024 * 1024;

/** The environment git runs in: no prompt, no system or global settings, a home of its own. @returns {Record<string, string>} */
export function cloneEnv() {
  return { PATH: process.env.PATH || "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent", LANG: "C" };
}
