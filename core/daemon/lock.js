// @ts-check
// lock: one vyred per home. The socket check in start() came too late (after every module had
// started) and keyed on the home's spelling: a home reached through a symlink got its own
// socket path when the spelled path was long, and two vyreds ran on one store. The lock is taken
// before anything opens the store, in the home's real folder, so every spelling of a home is one.
//
// A lock whose process is gone is stale and taken over. So is one left by a vyred from before a
// reboot or a container restart, where its pid may now belong to something else: the lock
// records the boot it was taken in, and a pid that is not a vyre process does not hold it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Locks this process holds, by path: a second start() on the same home in one process is refused too. */
const held = new Set();

/** When this machine booted, to the minute. */
const bootedAt = () => Math.round((Date.now() - os.uptime() * 1000) / 60_000);

/** Is `pid` running, and (when this can tell) a vyre process? */
function holds(pid) {
  try { process.kill(pid, 0); } catch (e) { if (/** @type {any} */ (e).code !== "EPERM") return false; }
  let cmd = "";
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); }
  catch { try { cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }); } catch {} }
  return !cmd || /vyre/i.test(cmd);
}

/** The home's real folder: every spelling of one home (a symlink, a trailing slash) is one. */
export function realHome(/** @type {string} */ root) {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

/**
 * Take the home's lock, or throw "vyred is already running" naming the pid. Returns release().
 * @param {string} root
 */
export function acquire(root) {
  const file = path.join(realHome(root), "vyred.lock");
  if (held.has(file)) throw new Error(`vyred is already running in this process (${file})`);
  const mine = JSON.stringify({ pid: process.pid, boot: bootedAt() });
  for (let tries = 0; tries < 3; tries++) {
    try {
      fs.writeFileSync(file, mine, { flag: "wx", mode: 0o600 });
      held.add(file);
      return () => {
        held.delete(file);
        try { if (fs.readFileSync(file, "utf8") === mine) fs.rmSync(file, { force: true }); } catch {}
      };
    } catch (e) {
      if (/** @type {any} */ (e).code !== "EEXIST") throw e;
    }
    let other = { pid: 0, boot: 0 };
    try { other = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const sameBoot = Math.abs(Number(other.boot) - bootedAt()) <= 1;
    if (other.pid && other.pid !== process.pid && sameBoot && holds(other.pid)) {
      throw new Error(`vyred is already running (pid ${other.pid}, home ${realHome(root)})`);
    }
    // Stale: its process is gone, or it is from before this boot. Take it over.
    fs.rmSync(file, { force: true });
  }
  throw new Error(`could not take ${file}`);
}
