// @ts-check
// How every session process Vyre starts is spawned (ADR 0030, "Security"), by either driver.
//
// - Its own process group and session (detached), so a stop takes the whole tree, and the
//   daemon can refuse a person-only call from anything in that group or session, even after
//   the process that started it is gone (core/daemon peer check, threads.pids).
// - Under a subreaper where there is one (`tini -s` on the box): a model's Bash that detaches
//   (`nohup ... &`, `setsid`) reparents to tini, not to init, so its ancestry still leads to a
//   session process and the peer check still refuses it.
// - With an account (o.account, ADR 0030 phase 2), the spawner runs it as that account's own uid
//   instead, in that uid's private HOME, so one account's sign-in and processes are out of every
//   other's reach. Without a spawner an account changes nothing here (a Mac has one user).
// - On the box, as uid vyre-agent through the spawner (core/spawner, ADR 0032 part 3), which
//   cannot open vyred's socket or read its home: vyred itself has no right to change uid. The
//   spawner runs it under `tini -s` in its own group and session, and passes the API key on fd 3.
// The pid, group and session are reported before the process can run a tool: at once for a
// direct spawn, and for the spawner as soon as it answers, before anything is written to stdin.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { windowsShellGuard } from "../../lib/agent-sandbox.js";
import { available as spawnerHere, spawnAsAgent } from "../spawner/client.js";

/** tini on this machine, if any: the box image puts it in /usr/bin. */
export function findSubreaper() {
  if (process.platform !== "linux") return null;
  for (const p of ["/usr/bin/tini", "/sbin/tini", "/usr/local/bin/tini"]) { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {} }
  return null;
}

/** Do sessions start through the spawner here (sessions.spawner "on", Linux, its socket there)? */
export const usesSpawner = () => process.env.VYRE_SESSIONS_SPAWNER === "on" && process.platform === "linux" && spawnerHere();

/**
 * @param {string} command @param {string[]} args
 * An API key never goes in the environment: Claude Code passes its environment to every tool it
 * runs, so a session's Bash would read it (measured: scripts/sessions-proof/env-leak.mjs). It is
 * written once to a pipe on fd 3 instead (CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR), which Claude Code
 * reads at start and its tools never inherit. A setup token (CLAUDE_CODE_OAUTH_TOKEN) Claude Code
 * already keeps from its tools.
 * @param {{ cwd?: string, env?: Record<string, string|undefined>, signal?: AbortSignal, subreaper?: string|null,
 *           uid?: number, gid?: number, account?: { uid: number, shared?: boolean }, seed?: Record<string, string>, onSpawn?: (g: { pid: number, pgid: number, sid: number }) => void, sandboxSpawn?: (command: string, args: string[], env: Record<string, string|undefined>, cwd?: string, opts?: any) => any }} o
 */
export function spawnSession(command, args, o = {}) {
  // On Windows (no session sandbox in 0.3) an agent process gets no shell tool, or does not start (reviewer-2 ENG-1; lib/agent-sandbox.js).
  if (!o.sandboxSpawn) args = windowsShellGuard(command, args, /** @type {any} */ (o).platform);
  // A session confined by the runner's home sandbox (lib/agent-sandbox.js): the prepared spawner plans and launches this process under the same rules, its group
  // recorded for the peer check. The subreaper and the uid split are the unconfined path's; the sandbox replaces them here.
  if (o.sandboxSpawn) {
    const child = o.sandboxSpawn(command, args, o.env || {}, o.cwd, o.signal ? { signal: o.signal } : undefined);
    if (child.pid && o.onSpawn) { try { o.onSpawn({ pid: child.pid, pgid: child.pid, sid: child.pid }); } catch {} }
    return child;
  }
  // With sessions.spawner "on" (VYRE_SESSIONS_SPAWNER=on) and a spawner here. vyre-agent cannot
  // open vyred's socket, so the session reaches Vyre on its own one (VYRE_SOCKET in o.env).
  if (o.spawner === true || (o.spawner !== false && usesSpawner())) return viaSpawner(command, args, o);
  if (o.seed && o.env && o.env.HOME) seedFiles(o.env.HOME, o.seed);
  const posix = process.platform !== "win32";
  const [cmd, argv] = o.subreaper && posix ? [o.subreaper, ["-s", "--", command, ...args]] : [command, args];
  const env = { ...(o.env || {}) };
  const key = env.ANTHROPIC_API_KEY;
  if (key) { delete env.ANTHROPIC_API_KEY; env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR = "3"; }
  const child = spawn(cmd, argv, { cwd: o.cwd, env: /** @type {any} */ (env), signal: o.signal, stdio: key ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    detached: posix, ...(typeof o.uid === "number" ? { uid: o.uid } : {}), ...(typeof o.gid === "number" ? { gid: o.gid } : {}) });
  if (key && child.stdio[3]) { const fd = /** @type {any} */ (child.stdio[3]); fd.on("error", () => {}); fd.end(String(key)); }
  // detached is setsid(): the child leads a new session and a new process group, both its pid.
  if (child.pid && o.onSpawn) { try { o.onSpawn({ pid: child.pid, pgid: child.pid, sid: child.pid }); } catch {} }
  return child;
}

/**
 * Put a provider's config files in a HOME (relative paths only), mode 0600, replacing what is there:
 * written again at every start, so nothing the agent edited last time is read this time. Where the
 * spawner runs the session it writes them itself, as the account's uid.
 * @param {string} home @param {Record<string, string>} files
 */
export function seedFiles(home, files) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [rel, text] of Object.entries(files)) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`seed path ${rel} must stay inside the HOME`);
    const file = path.join(home, rel);
    // No part of the path below HOME may be a symlink (an agent can plant ~/.codex as a link to somewhere else, and this runs
    // as whoever starts the session): each folder is made and checked with lstat, and the file is opened with O_NOFOLLOW.
    let dir = home;
    for (const part of path.dirname(rel).split(/[\\/]/).filter(x => x && x !== ".")) {
      dir = path.join(dir, part);
      let st = null;
      try { st = fs.lstatSync(dir); } catch {}
      if (!st) { fs.mkdirSync(dir, { mode: 0o700 }); st = fs.lstatSync(dir); }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`seed path ${rel}: ${path.relative(home, dir)} is not a plain folder`);
    }
    try { const st = fs.lstatSync(file); if (st.isSymbolicLink() || !st.isFile()) fs.rmSync(file, { force: true, recursive: false }); else fs.rmSync(file, { force: true }); } catch {}
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
  }
}

/** Does any process of this group still run? @param {number} pgid */
export function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
}

/** Signal a whole group, else the one process. @param {import("node:child_process").ChildProcess|null} child @param {NodeJS.Signals} sig */
export function killGroup(child, sig) {
  const pid = child && child.pid;
  if (!pid) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, sig); } catch { try { child?.kill(sig); } catch {} }
}

/** A command as an absolute path: the spawner starts only the programs it allows, by path. */
function absolute(command, env) {
  if (path.isAbsolute(command)) return command;
  // The caller's PATH first, then the places the image installs the provider CLIs, so a PATH an account's environment narrowed cannot hide them.
  for (const dir of [...String((env && env.PATH) || process.env.PATH || "").split(":"), "/usr/local/bin", "/usr/bin"]) {
    if (!dir) continue;
    const p = path.join(dir, command);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return command;
}

/**
 * An agent's folder under vyred's home is out of vyre-agent's reach: it works in the same place
 * in its own home instead (VYRE_HOME/agents/<name> -> <agent home>/agents/<name>).
 * @param {string|undefined} cwd
 */
export function agentCwd(cwd, { vyreHome = process.env.VYRE_HOME || "", agentHome = process.env.VYRE_AGENT_HOME || "/home/vyre-agent" } = {}) {
  if (!cwd || !vyreHome) return cwd;
  const rel = path.relative(path.resolve(vyreHome), path.resolve(cwd));
  const [first, name, ...rest] = rel.split(path.sep);
  if (rel.startsWith("..") || first !== "agents" || !name) return cwd;
  return path.join(agentHome, "agents", name, ...rest);
}

/**
 * The same session started through the spawner. What comes back looks like a ChildProcess at
 * once (stdin, stdout, stderr, pid once known, kill, "spawn", "exit", "close" and "error"), as the
 * Agent SDK's spawnClaudeCodeProcess and the runner expect. Nothing written to stdin reaches the
 * process before onSpawn has its pid, group and session. kill goes to the spawner, which signals
 * the whole group: vyred cannot signal another uid's processes itself.
 */
function viaSpawner(command, args, o) {
  const proc = /** @type {any} */ (new EventEmitter());
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(proc, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr], pid: undefined, exitCode: null, signalCode: null, killed: false });
  /** @type {any} */ let handle = null;
  /** @type {NodeJS.Signals | null} */ let pending = null;
  proc.kill = (/** @type {NodeJS.Signals} */ sig = "SIGTERM") => { proc.killed = true; if (handle) handle.kill(sig); else pending = sig; return true; };
  if (o.signal) o.signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
  const env = { ...(o.env || {}) };
  const key = env.ANTHROPIC_API_KEY;
  if (key) { delete env.ANTHROPIC_API_KEY; env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR = "3"; }
  spawnAsAgent([absolute(command, env), ...args], { env, cwd: agentCwd(o.cwd, o.account ? { agentHome: path.join(process.env.VYRE_ACCOUNTS_HOME || "/home/acct", String(o.account.uid)) } : {}), ...(key ? { fd3: String(key) } : {}), ...(o.account ? { account: o.account.uid, shared: o.account.shared } : {}), ...(o.seed ? { seed: o.seed } : {}), ...(o.spawnerSocket ? { socket: o.spawnerSocket } : {}) }).then(h => {
    handle = h;
    proc.pid = h.pid;
    // The spawner starts it detached: it leads a new group and session, both its pid.
    if (o.onSpawn) { try { o.onSpawn({ pid: h.pid, pgid: h.pid, sid: h.pid }); } catch {} }
    if (pending) h.kill(pending);
    // "exit" once the process has ended and its output has all arrived (or a moment after).
    let ended = false, gone = /** @type {any} */ (null);
    const finish = () => { if (!gone || proc.exitCode !== null || proc.signalCode !== null) return; proc.exitCode = gone.code; proc.signalCode = gone.signal;
      proc.emit("exit", gone.code, gone.signal); proc.emit("close", gone.code, gone.signal); };
    h.stdout.on("end", () => { ended = true; finish(); });
    h.on("exit", (code, signal) => { gone = { code, signal }; if (ended) finish(); else setTimeout(finish, 1000).unref(); });
    h.on("error", e => proc.emit("error", e));
    h.stdout.pipe(stdout);
    h.stderr.pipe(stderr);
    stdin.pipe(h.stdin).on("error", () => {});
    proc.emit("spawn");
  }).catch(e => { setImmediate(() => proc.emit("error", e)); });
  return proc;
}
