// @ts-check
// lib/group-kill: signal one process GROUP, and never a group that is not one child's own.
//
// process.kill(-pid, sig) signals the process group `pid`. With pid 1 that is kill(-1): every process the user may signal, which on a CI runner is all six runners of the host (found on 18 Oct 2026: a preview
// supervisor test whose fake child had pid 1 ended every runner service on the machine). With pid 0 (a spawn that failed, `child.pid || 0`) it is kill(0): the caller's own group, which on a runner contains
// the runner service itself. Only a real child's pid, an integer above 1, names a group worth signalling.

/** Is this a pid whose group may be signalled: an integer above 1. @param {unknown} pid @returns {pid is number} */
export const groupPid = pid => typeof pid === "number" && Number.isInteger(pid) && pid > 1;

/**
 * Signal the process group of a child this process started. Returns false (and signals nothing) for a pid that is not a real group, and when the group is gone.
 * @param {unknown} pid @param {NodeJS.Signals | number} sig @returns {boolean}
 */
export function killGroup(pid, sig) {
  if (!groupPid(pid)) return false;
  try { process.kill(-pid, sig); return true; } catch { return false; }
}
