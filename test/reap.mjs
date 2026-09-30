// @ts-check
// Killing what a test started, by exact marker: every process whose command line contains `marker` (a
// temp folder this test made, unique to it) gets its process group and then itself killed. Used by
// test/install-mac-server.test.js, whose fake launchctl and root installer start real vyred-like
// processes that outlive the script: a test must never leave one behind (82 were left on a person's
// Mac on 30 Sep), so every test reaps in t.after, and a final check fails the file if any survive.
import { execFileSync } from "node:child_process";

/** @param {string} marker @returns {{ pid: number, pgid: number, command: string }[]} */
export function processesWith(marker) {
  let out = "";
  try { out = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8", env: {} }); } catch { return []; }
  const found = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || !m[3].includes(marker)) continue;
    found.push({ pid, pgid: Number(m[2]), command: m[3] });
  }
  return found;
}

/** Kill everything with the marker: its group (when the group is not ours), then the process. @returns {number} how many were found */
export function reap(/** @type {string} */ marker) {
  const mine = (() => { try { return Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim()); } catch { return -1; } })();
  let n = 0;
  for (let round = 0; round < 3; round++) {
    const found = processesWith(marker);
    if (!found.length) break;
    n += found.length;
    for (const p of found) {
      for (const sig of /** @type {const} */ (["SIGTERM", "SIGKILL"])) {
        if (p.pgid > 1 && p.pgid !== mine) { try { process.kill(-p.pgid, sig); } catch { /* gone */ } }
        try { process.kill(p.pid, sig); } catch { /* gone */ }
      }
    }
  }
  return n;
}
