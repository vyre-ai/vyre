// @ts-check
// A runner that died leaves its sessions' processes behind on a platform whose sandbox does not die with its parent (macOS): each session's process group is recorded when it starts and forgotten when it ends,
// and these two callers end the ones that outlived the runner: the next runner at start-up (all of them), and the watchdog the moment it sees its runner gone (that Space's only).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** When a process started, as the system tells it (a value to compare, not to read): a pid that has been reused is a different process with a different start. Empty when it cannot be told. @param {number} pid */
export function startedOf(pid) {
  if (process.platform === "linux") { try { const t = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return t.slice(t.lastIndexOf(")") + 2).split(" ")[19] || ""; } catch { return ""; } }
  try { return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).trim(); } catch { return ""; }   // in UTC: a change of time zone must not make a process look new
}

/**
 * Sessions a runner that died left running: each session's process group is recorded (run/<space>.<session>.pid) when it starts and forgotten when it ends, so a restarted runner finds the ones that
 * outlived it and ends them (only when the process is still the sandboxed agent that was recorded: a pid reused by something else is left alone). Returns how many it ended.
 * `only` limits it to one Space's sessions (their pid files begin with the Space's folder name): the watchdog of one Space's workspace ends that Space's orphans and nobody else's.
 * @param {string} base @param {string} [only] @returns {number}
 */
export function endOrphans(base, only = "") {
  let n = 0;
  const run = path.join(base, "run");
  let names = []; try { names = fs.readdirSync(run).filter(f => f.endsWith(".pid") && (!only || f.startsWith(only + "."))); } catch { return 0; }
  for (const f of names) {
    const file = path.join(run, f);
    try {
      const rec = JSON.parse(fs.readFileSync(file, "utf8"));
      const pid = Number(rec.pid); if (!Number.isInteger(pid) || pid < 2) throw new Error("bad");
      // still the process we recorded: alive, and the same start (a pid is reused; a process that merely has the number now is somebody else's)
      const started = startedOf(pid);
      const same = Boolean(started) && Boolean(rec.started) && String(rec.started) === started;   // a record that could not say when its process started is not obeyed
      if (same) { for (const sig of ["SIGTERM", "SIGKILL"]) { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } } n++; }
    } catch { /* not a record we can read */ }
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return n;
}

