// @ts-check
// Starting and stopping vyred from the terminal. Commands that need vyred call `ensureUp`, so
// `vyre` in any terminal just works: it starts the daemon when it is not running.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as config from "../config/index.js";
import { REPO, ping } from "../daemon/index.js";

/** @returns {Promise<{ ok: boolean, started?: boolean, pid?: number, log?: string, error?: string }>} */
export async function ensureUp() {
  // Inside a session Vyre started (VYRE_SOCKET, its own socket): that vyred is running or the
  // session is ending. Never start a second vyred from inside a session.
  if (process.env.VYRE_SOCKET && process.env.VYRE_THREAD) {
    return await ping(process.env.VYRE_SOCKET) ? { ok: true, started: false } : { ok: false, started: false, error: "vyred is not answering this session's socket" };
  }
  const p = config.ensure();
  if (await ping(p.socket)) return { ok: true, started: false };
  // In the server's container a supervisor owns vyred (the loop under the spawner, core/daemon/loop.sh)
  // and brings it back 2 s after it exits. A `vyre` run with docker exec in that gap must not start
  // a second vyred of its own: that one lacks the spawner, makes the loop's vyred exit "already
  // running" until the loop gives up, and dies with the exec. Wait for the supervisor's instead.
  if (process.env.VYRE_SUPERVISOR === "docker") {
    const wait = Number(process.env.VYRE_UP_WAIT_MS) || 20_000;
    for (let t = 0; t < wait; t += 200) {
      await new Promise(r => setTimeout(r, 200));
      if (await ping(p.socket)) return { ok: true, started: false };
    }
    return { ok: false, started: false, error: "vyred is not answering in its container: docker compose -p vyre logs vyre" };
  }
  const log = path.join(p.logs, "vyred.out");
  const fd = fs.openSync(log, "a");
  const child = spawn(process.execPath, [path.join(REPO, "core", "daemon", "main.js")], {
    detached: true, stdio: ["ignore", fd, fd], env: process.env,
  });
  child.unref();
  // A first start makes the store and starts every module: about 3s on an idle Mac, and past 5s
  // on a busy one, where a shorter wait said "did not start" about a vyred that was starting.
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await ping(p.socket)) return { ok: true, started: true, pid: child.pid };
    if (child.exitCode !== null) break;
  }
  return { ok: false, log };
}

/** Is this pid a live process? (EPERM means it is.) @param {number} pid */
function running(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
}

/**
 * Stop this home's vyred. Only a pid that is Vyre's own: the pid file's, and when the caller
 * read vyred's health first, that one too. A pid file left by a crash names a process that may
 * be anything by now, so a mismatch stops nothing.
 * @param {{ pid?: number }} [expect]
 * @returns {Promise<{ ok: boolean, wasRunning: boolean, pid?: number, why?: string }>}
 */
export async function stop(expect = {}) {
  const p = config.paths();
  let pid = 0;
  try { pid = Number(fs.readFileSync(p.pid, "utf8")); } catch {}
  if (!pid || !(await ping(p.socket))) return { ok: true, wasRunning: false };
  if (expect.pid && expect.pid !== pid) return { ok: false, wasRunning: true, pid, why: `vyred answers as pid ${expect.pid} but ${p.pid} says ${pid}; stopped nothing` };
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    // The socket goes quiet first: vyred still stops its modules and closes its store, and its lock
    // is held until the process ends. A new vyred started in that gap finds the lock taken and
    // exits, so a restart waits for the process itself (node 22 on a busy Linux runner, 30 Sep).
    if (!(await ping(p.socket)) && !running(pid)) return { ok: true, wasRunning: true, pid };
  }
  return { ok: false, wasRunning: true, pid };
}
