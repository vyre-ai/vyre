// @ts-check
// The watchdog (reviewer-2 R2, probes Z4 and Z5). The runner can die (a kill, a crash, a power cut) and then nobody would close the
// workspace: it would stay mounted and readable after a revoke. So when a workspace is opened, this small process is started
// outside the runner. It holds no key and does no work except one thing: it unmounts the workspace when the runner is gone, or
// when the wall-clock deadline in its file has passed. The runner moves the deadline forward on every lease renewal.
//
//   node watchdog.js <platform> <space dir> <runner pid> <deadline file> <generation> [driver]
//
// The file holds { gen, at }. A watchdog belongs to one opening of the workspace (its generation): when the runner opens it again
// the file carries a new generation and the old watchdog exits without touching the new mount.
//
// It exits once the workspace is no longer mounted. It never reports locked: the runner verifies with isMounted.

import fs from "node:fs";
import { driverFor } from "./workspace.js";

const POLL_MS = 3000;

/** @param {number} pid */
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; } };

/**
 * @param {{ driver: any, dir: string, pid: number, deadlineFile: string, gen?: string, now?: () => number, pollMs?: number, isAlive?: (pid: number) => boolean }} o
 * @returns {Promise<"unmounted"|"gone"|"superseded">}
 */
export async function watch(o) {
  const now = o.now || Date.now, up = o.isAlive || alive;
  for (;;) {
    if (!o.driver.isMounted(o.dir)) return "gone";
    let deadline = 0, gen = "";
    try { const j = JSON.parse(fs.readFileSync(o.deadlineFile, "utf8")); deadline = Number(j.at); gen = String(j.gen ?? ""); } catch { deadline = 0; }
    if (o.gen !== undefined && gen && gen !== o.gen) return "superseded";
    if (!up(o.pid) || now() >= deadline) {
      for (let i = 0; i < 20 && o.driver.isMounted(o.dir); i++) {
        try { await o.driver.unmount(o.dir); } catch {}
        if (o.driver.isMounted(o.dir)) await new Promise(r => setTimeout(r, Math.min(5000, 250 * (i + 1))));
      }
      return o.driver.isMounted(o.dir) ? "gone" : "unmounted";
    }
    await new Promise(r => setTimeout(r, o.pollMs ?? POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv.length >= 7) {
  const [, , platform, dir, pid, deadlineFile, gen, driverName] = process.argv;
  watch({ driver: driverFor(platform, { prefer: driverName === "fscrypt" ? "fscrypt" : "gocryptfs" }), dir, pid: Number(pid), deadlineFile, gen }).then(() => process.exit(0));
}
