// @ts-check
// safe git: how vyred runs git in a folder someone else can write to (a project, a session's
// worktree, an agent's /work). A repo's own config and hooks are that someone's: core.fsmonitor
// runs on `ls-files`, `check-ignore` and `status`, textconv and ext-diff on `diff`, filter drivers
// on checkout and add, hooks on merge and commit. None of them may run as vyred. Every git vyred
// starts goes through these arguments and this environment (e2e, 28 Sep).

import os from "node:os";
import { execFile, spawnSync } from "node:child_process";

/**
 * Put before git's own arguments: no fsmonitor, no hooks, no network, no pager, no external diff
 * or textconv driver. Command-line settings win over the repo's config and anything it includes.
 */
export const SAFE_GIT_ARGS = Object.freeze([
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never",
  "-c", "core.pager=cat", "-c", "diff.external=", "-c", "core.sshCommand=false",
  "-c", "log.showSignature=false", "-c", "gpg.program=false", "-c", "gpg.ssh.program=false",
  "-c", "gpg.x509.program=false",
]);

/**
 * The environment for git: vyred's own, without anything that points git elsewhere, and no global
 * or system config (a user's ~/.gitconfig could name the same commands), no prompts, no pager.
 * @param {NodeJS.ProcessEnv} [base]
 */
export function safeGitEnv(base = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === "string" && !/^GIT_/.test(k)) env[k] = v;
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_ASKPASS: "", SSH_ASKPASS: "", LC_ALL: "C",
  });
}

/**
 * Filter, diff and merge drivers are named by the repo itself (`filter.<name>.clean` in its config, used by its
 * .gitattributes), so no fixed argument turns them all off. Read the names the repo defines
 * (reading config runs nothing) and override each one: clean and smudge become cat, the
 * long-running process driver is unset, none is required, a diff driver's textconv is cat and its
 * external command unset, and a merge driver fails (so a merge stops rather than runs it). `status` and a worktree `diff` run
 * clean filters; checkout runs smudge. Returns SAFE_GIT_ARGS plus those overrides.
 * @param {string} dir
 * @returns {string[]}
 */
export function safeGitArgs(dir) {
  const out = [...SAFE_GIT_ARGS];
  let names = [];
  try {
    const r = spawnSync("git", [...SAFE_GIT_ARGS, "-C", dir, "config", "--name-only", "--get-regexp", "^(filter|diff|merge)\\."],
      { encoding: "utf8", timeout: 3000, env: safeGitEnv(), stdio: ["ignore", "pipe", "ignore"] });
    names = String(r.stdout || "").split("\n").map(k => /^(filter|diff|merge)\.(.+)\.[^.]+$/.exec(k.trim())).filter(Boolean)
      .map(m => [/** @type {RegExpExecArray} */ (m)[1], /** @type {RegExpExecArray} */ (m)[2]]);
  } catch {}
  const seen = new Set();
  for (const [kind, n] of names) {
    if (seen.has(`${kind}.${n}`)) continue;
    seen.add(`${kind}.${n}`);
    if (kind === "filter") out.push("-c", `filter.${n}.clean=cat`, "-c", `filter.${n}.smudge=cat`, "-c", `filter.${n}.process=`, "-c", `filter.${n}.required=false`);
    if (kind === "diff") out.push("-c", `diff.${n}.textconv=cat`, "-c", `diff.${n}.command=`);
    if (kind === "merge") out.push("-c", `merge.${n}.driver=false`);
  }
  return out;
}

/** Subcommands that print diffs: they also get --no-ext-diff and --no-textconv. */
const DIFFS = new Set(["diff", "log", "show", "diff-tree", "diff-index", "diff-files"]);

/** The full argv for one git call in `dir`: the safe settings, the repo's own drivers overridden, then the call. */
function argv(dir, args) {
  const a = [...args];
  if (DIFFS.has(a[0])) a.splice(1, 0, "--no-ext-diff", "--no-textconv");
  return [...safeGitArgs(dir), "-C", dir, ...a];
}

/**
 * Run git in `dir`, synchronously, the one way vyred does it: no shell, no prompt, a deadline.
 * Never throws. `env` is merged in on top of the safe environment (never as its base, which would
 * strip a caller's own GIT_* keys back out) — for a caller's own author identity on a commit or
 * merge vyred makes, never to relax anything safeGitEnv/safeGitArgs turned off.
 * @param {string} dir @param {string[]} args @param {{ timeout?: number, env?: Record<string, string> }} [o]
 * @returns {{ ok: boolean, stdout: string, stderr: string }}  stderr: git's own explanation of a failure
 */
export function gitSync(dir, args, { timeout = 5000, env } = {}) {
  try {
    const r = spawnSync("git", argv(dir, args), { encoding: "utf8", timeout, killSignal: "SIGKILL", env: { ...safeGitEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return { ok: r.status === 0 && !r.error, stdout: String(r.stdout || ""), stderr: String(r.stderr || (r.error ? r.error.message : "")) };
  } catch (e) { return { ok: false, stdout: "", stderr: String(/** @type {Error} */ (e).message) }; }
}

/**
 * Run git in `dir`, asynchronously, the one way vyred does it. Never rejects. `env`: see gitSync.
 * @param {string} dir @param {string[]} args @param {{ timeout?: number, env?: Record<string, string> }} [o]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>}
 */
export function gitAsync(dir, args, { timeout = 15_000, env } = {}) {
  return new Promise(resolve => {
    try {
      execFile("git", argv(dir, args), { timeout, killSignal: "SIGKILL", env: { ...safeGitEnv(), ...env }, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || (err ? err.message : "")) }));
    } catch (e) { resolve({ ok: false, stdout: "", stderr: String(/** @type {Error} */ (e).message) }); }
  });
}
