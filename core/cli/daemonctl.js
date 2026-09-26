// @ts-check
// Starting and stopping vyred from the terminal. Commands that need vyred call `ensureUp`, so
// `vyre` in any terminal just works: it starts the daemon when it is not running.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as config from "../config/index.js";
import { REPO, ping } from "../daemon/index.js";

/** @returns {Promise<{ ok: boolean, started?: boolean, pid?: number, log?: string }>} */
export async function ensureUp() {
  const p = config.ensure();
  if (await ping(p.socket)) return { ok: true, started: false };
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

/** @returns {Promise<{ ok: boolean, wasRunning: boolean, pid?: number }>} */
export async function stop() {
  const p = config.paths();
  let pid = 0;
  try { pid = Number(fs.readFileSync(p.pid, "utf8")); } catch {}
  if (!pid || !(await ping(p.socket))) return { ok: true, wasRunning: false };
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!(await ping(p.socket))) return { ok: true, wasRunning: true, pid };
  }
  return { ok: false, wasRunning: true, pid };
}
