// @ts-check
// What a session uses on this computer now (R031-95 2.4): the processor and the memory of its whole process group, the numbers the person's limits are measured against and the list in Settings shows.
// Linux reads /proc and works out the processor from the group's CPU time between two samples; macOS asks ps, whose percent is already a recent average. Pure over injected readers, so a test feeds it a fake /proc.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const TICKS = 100;   // CLK_TCK is 100 on every Linux Vyre runs on

/**
 * @param {{ platform?: string, now?: () => number, proc?: { pids(): string[], stat(pid: string): string | null }, ps?: () => string, pageKb?: number }} [o]
 * @returns {{ sample(pgid: number): { cpuPercent: number, memoryMb: number }, forget(pgid: number): void }}
 */
export function createUsage(o = {}) {
  const platform = o.platform || process.platform;
  const now = o.now || Date.now;
  const proc = o.proc || { pids: () => { try { return fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch { return []; } }, stat: (/** @type {string} */ pid) => { try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return null; } } };
  const ps = o.ps || (() => { try { return execFileSync("/bin/ps", ["-A", "-o", "pgid=,pcpu=,rss="], { encoding: "utf8", timeout: 3000 }); } catch { return ""; } });
  const pageKb = o.pageKb || 4;
  /** @type {Map<number, { ticks: number, at: number }>} */ const last = new Map();
  return {
    sample(pgid) {
      if (platform === "darwin") {
        let cpu = 0, kb = 0;
        for (const line of ps().split("\n")) { const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s*$/.exec(line); if (m && Number(m[1]) === pgid) { cpu += Number(m[2]); kb += Number(m[3]); } }
        return { cpuPercent: Math.round(cpu), memoryMb: Math.round(kb / 1024) };
      }
      let ticks = 0, pages = 0;
      for (const pid of proc.pids()) {
        const s = proc.stat(pid); if (!s) continue;
        // the command name sits in parentheses and may hold spaces: the fields after it start two characters past the last ")"
        const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
        if (Number(f[2]) !== pgid) continue;   // field 5 of stat is the process group
        ticks += Number(f[11]) + Number(f[12]);   // utime and stime
        pages += Number(f[21]);   // rss in pages
      }
      const t = now(), prev = last.get(pgid);
      last.set(pgid, { ticks, at: t });
      const cpu = prev && t > prev.at && ticks >= prev.ticks ? ((ticks - prev.ticks) / TICKS) / ((t - prev.at) / 1000) * 100 : 0;
      return { cpuPercent: Math.round(cpu), memoryMb: Math.round(pages * pageKb / 1024) };
    },
    forget(pgid) { last.delete(pgid); },
  };
}
