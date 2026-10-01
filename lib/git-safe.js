// @ts-check
// safe git: how vyred runs git in a folder someone else can write to (a project, a session's
// worktree, an agent's /work). A repo's own config and hooks are that someone's: core.fsmonitor
// runs on `ls-files`, `check-ignore` and `status`, textconv and ext-diff on `diff`, filter drivers
// on checkout and add, hooks on merge and commit. None of them may run as vyred. Every git vyred
// starts goes through these arguments and this environment (e2e, 28 Sep).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";

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
 * Never throws.
 * @param {string} dir @param {string[]} args @param {{ timeout?: number }} [o]
 * @returns {{ ok: boolean, stdout: string, stderr: string }}  stderr: git's own explanation of a failure
 */
export function gitSync(dir, args, { timeout = 5000 } = {}) {
  try {
    const r = spawnSync("git", argv(dir, args), { encoding: "utf8", timeout, killSignal: "SIGKILL", env: safeGitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return { ok: r.status === 0 && !r.error, stdout: String(r.stdout || ""), stderr: String(r.stderr || (r.error ? r.error.message : "")) };
  } catch (e) { return { ok: false, stdout: "", stderr: String(/** @type {Error} */ (e).message) }; }
}

/**
 * Run git in `dir`, asynchronously, the one way vyred does it. Never rejects.
 * @param {string} dir @param {string[]} args @param {{ timeout?: number }} [o]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>}
 */
export function gitAsync(dir, args, { timeout = 15_000 } = {}) {
  return new Promise(resolve => {
    try {
      execFile("git", argv(dir, args), { timeout, killSignal: "SIGKILL", env: safeGitEnv(), maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || (err ? err.message : "")) }));
    } catch (e) { resolve({ ok: false, stdout: "", stderr: String(/** @type {Error} */ (e).message) }); }
  });
}

/**
 * Run git in `dir` with a bearer-style token available for exactly one call (a clone, fetch or
 * push over https that needs auth), never over the wire any other way (ADR 0041 decision 4). Two
 * things this does that a plain gitAsync call never could:
 *
 * - `protocol.https.allow=always` on top of the inherited `protocol.allow=never`: https and
 *   nothing else — no `file`, `git`, `ext`, or a submodule's own transport — becomes reachable
 *   for this call only.
 * - `credential.helper=` (git's documented way to clear a configured helper list), so a
 *   successful auth is never handed to a keychain or store helper to remember (macOS ships one
 *   at system scope; many people set one globally too; a repo-local one is the residual risk
 *   GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL=devNull, both already forced by safeGitEnv, do not
 *   reach — see git-safe-askpass.test.js). `credential.interactive` is left alone: setting it to
 *   `false` (its "off" value, confusingly) makes git refuse rather than ask, which would defeat
 *   the askpass path entirely; `GIT_TERMINAL_PROMPT=0` (already forced by safeGitEnv) is what
 *   stops git from falling back to a raw terminal prompt, and does not affect GIT_ASKPASS.
 *
 * The token itself never touches an environment variable (readable by any same-uid process via
 * `ps eww`) or disk. `GIT_ASKPASS` points at a script, freshly written into a `0700` temp dir and
 * deleted the moment this call ends, that holds no token of its own: it reads one exactly once
 * from an inherited pipe (`GIT_ASKPASS_TOKEN_FD` names the fd; only the fd *number* is an env
 * var, never the value) and prints it to stdout, which is the whole askpass protocol. The pipe's
 * write end, held only in this process, gets the token and is closed (EOF) right after.
 * `credential.username` is fixed to `username` (default `x-access-token`, GitHub's own convention
 * for a PAT: any non-empty username works, and fixing it means git only ever prompts askpass for
 * the *password* — never twice, which matters since the token pipe can only be read once.
 * @param {string} dir @param {string[]} args
 * @param {{ token: string, username?: string, timeout?: number, stdin?: string }} o
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>}
 */
export function gitWithAskpass(dir, args, { token, username = "x-access-token", timeout = 120_000, stdin }) {
  return new Promise(resolve => {
    if (typeof token !== "string" || !token) { resolve({ ok: false, stdout: "", stderr: "gitWithAskpass needs a token" }); return; }
    let scriptDir;
    try {
      scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-askpass-"));
      fs.chmodSync(scriptDir, 0o700);
    } catch (e) { resolve({ ok: false, stdout: "", stderr: String(/** @type {Error} */ (e).message) }); return; }
    const cleanup = () => { try { fs.rmSync(/** @type {string} */ (scriptDir), { recursive: true, force: true }); } catch {} };
    let script;
    try {
      script = path.join(scriptDir, `a${crypto.randomBytes(6).toString("hex")}.sh`);
      // No token in this file, ever: it reads fd 3 (named by GIT_ASKPASS_TOKEN_FD) exactly once
      // and prints it, the whole askpass protocol. `cat` exits once the write end closes (EOF).
      fs.writeFileSync(script, `#!/bin/sh\nexec cat <&"$GIT_ASKPASS_TOKEN_FD"\n`, { mode: 0o700 });
    } catch (e) { cleanup(); resolve({ ok: false, stdout: "", stderr: String(/** @type {Error} */ (e).message) }); return; }

    const gitArgs = [...safeGitArgs(dir), "-c", "protocol.https.allow=always", "-c", "credential.helper=",
      "-c", `credential.username=${username}`, "-C", dir, ...args];
    const env = { ...safeGitEnv(), GIT_ASKPASS: script, GIT_ASKPASS_TOKEN_FD: "3" };

    let child;
    try {
      child = spawn("git", gitArgs, { env, stdio: ["pipe", "pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) { cleanup(); resolve({ ok: false, stdout: "", stderr: String(/** @type {Error} */ (e).message) }); return; }

    // git can exit (a disallowed protocol, a bad arg, not found, killed) before ever reading
    // stdin or fd 3 - before the askpass script even runs. Writing to either pipe once the read
    // end is gone is a plain ECONNRESET on the socket, which Node raises as an 'error' event; an
    // unhandled one is a process-level uncaughtException, not something the promise below ever
    // sees (sessions, reviewing a9d6a9ab, caught this: it would have crashed vyred itself, not
    // just failed one call). Both pipes get a swallowing handler before anything is written to
    // them, since writing to a pipe nobody will read is exactly what "the call ended early"
    // looks like at the fd level, not a bug to surface.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin ?? "");
    // The pipe's write end (fd 3 in the child) gets the token once, then EOF; nothing else ever
    // writes to it, and it is never read from again once the askpass script has consumed it.
    const tokenPipe = /** @type {import("node:net").Socket} */ (child.stdio[3]);
    tokenPipe.on("error", () => {});
    tokenPipe.end(token);

    let out = "", err = "", done = false;
    child.stdout?.on("data", d => { out += d; });
    child.stderr?.on("data", d => { err += d; });
    const timer = setTimeout(() => { if (!done) child.kill("SIGKILL"); }, timeout);
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); cleanup(); resolve({ ok, stdout: out, stderr: err }); };
    child.on("error", e => { err += String(/** @type {any} */ (e).message || e); finish(false); });
    child.on("close", code => finish(code === 0));
  });
}

/**
 * Two read-only questions that need the person's OWN git config and so cannot go through the safe
 * arguments (which force core.hooksPath off): which hooks folder git would use for a repo
 * (`git config --includes --get core.hooksPath`, global and system included), and git's own
 * version. Neither runs a hook, a filter or any command the repo names; GIT_* is stripped from the
 * environment so nothing redirects them.
 * @param {string[]} args one of ["--version"] or ["-C", dir, "config", "--includes", "--get", key]
 * @returns {{ ok: boolean, stdout: string }}
 */
export function gitRead(args) {
  const allowed = (args.length === 1 && args[0] === "--version")
    || (args.length === 6 && args[0] === "-C" && args[2] === "config" && args[3] === "--includes" && args[4] === "--get" && /^[A-Za-z][A-Za-z0-9.-]*$/.test(args[5]));
  if (!allowed) return { ok: false, stdout: "" };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => typeof v === "string" && !/^GIT_/.test(k)));
  try {
    const r = spawnSync("git", args, { encoding: "utf8", env, timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return { ok: r.status === 0 && !r.error, stdout: String(r.stdout || "") };
  } catch { return { ok: false, stdout: "" }; }
}
