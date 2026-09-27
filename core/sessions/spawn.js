// @ts-check
// How every session process Vyre starts is spawned (ADR 0030, "Security"), by either driver.
//
// - Its own process group and session (detached), so a stop takes the whole tree, and the
//   daemon can refuse a person-only call from anything in that group or session, even after
//   the process that started it is gone (core/daemon peer check, threads.pids).
// - Under a subreaper where there is one (`tini -s` on the box): a model's Bash that detaches
//   (`nohup ... &`, `setsid`) reparents to tini, not to init, so its ancestry still leads to a
//   session process and the peer check still refuses it.
// - Optionally as another uid and gid (the box's session user, which cannot open vyred's socket).
// The pid, group and session are reported synchronously, before the process can run a tool.

import fs from "node:fs";
import { spawn } from "node:child_process";

/** tini on this machine, if any: the box image puts it in /usr/bin. */
export function findSubreaper() {
  if (process.platform !== "linux") return null;
  for (const p of ["/usr/bin/tini", "/sbin/tini", "/usr/local/bin/tini"]) { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {} }
  return null;
}

/**
 * @param {string} command @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string|undefined>, signal?: AbortSignal, subreaper?: string|null,
 *           uid?: number, gid?: number, onSpawn?: (g: { pid: number, pgid: number, sid: number }) => void }} o
 */
export function spawnSession(command, args, o = {}) {
  const posix = process.platform !== "win32";
  const [cmd, argv] = o.subreaper && posix ? [o.subreaper, ["-s", "--", command, ...args]] : [command, args];
  const child = spawn(cmd, argv, { cwd: o.cwd, env: /** @type {any} */ (o.env), signal: o.signal, stdio: ["pipe", "pipe", "pipe"],
    detached: posix, ...(typeof o.uid === "number" ? { uid: o.uid } : {}), ...(typeof o.gid === "number" ? { gid: o.gid } : {}) });
  // detached is setsid(): the child leads a new session and a new process group, both its pid.
  if (child.pid && o.onSpawn) { try { o.onSpawn({ pid: child.pid, pgid: child.pid, sid: child.pid }); } catch {} }
  return child;
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
