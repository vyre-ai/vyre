// @ts-check
// A runner that died leaves its sessions' processes behind on a platform whose sandbox does not die with its parent (macOS): each session's process group is recorded when it starts and forgotten when it ends,
// and these two callers end the ones that outlived the runner: the next runner at start-up (all of them), and the watchdog the moment it sees its runner gone (that Space's only).
import fs from "node:fs";
import path from "node:path";

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
      let cmd = ""; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { cmd = ""; }
      const stat = (() => { try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return ""; } })();
      const started = stat ? stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] : "";
      // still the process we recorded: alive, and (where /proc says) the same start time
      const same = process.platform === "linux" ? Boolean(stat) && (!rec.started || String(rec.started) === started) : (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
      void cmd;
      if (same) { for (const sig of ["SIGTERM", "SIGKILL"]) { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } } n++; }
    } catch { /* not a record we can read */ }
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return n;
}

