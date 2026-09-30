// @ts-check
// core's own process table, for its verdict on its own peer (/v1/peer).
//
// ADR 0040 section 1: core never runs anything from a path the person's uid could put first.
// vyred's reader (core/daemon/peer.js) runs `ps` from PATH and `tmux` from VYRE_TMUX_BIN; core
// uses only peer.js's pure walks (insideClaude, loginOf) and hands them this table instead:
// /proc on Linux, /bin/ps by absolute path with an empty environment on a Mac, read once per
// verdict. No tmux at all: a login inside tmux is not a login terminal to core.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const PS = "/bin/ps";

/** A Linux tty_nr as `who` names it, or null. @param {number} nr */
function ttyName(nr) {
  if (!nr) return null;
  const major = (nr >> 8) & 0xfff, minor = (nr & 0xff) | ((nr >> 12) & 0xfff00);
  if (major >= 136 && major <= 143) return `pts/${minor + (major - 136) * 256}`;
  if (major === 4 && minor < 64) return `tty${minor}`;
  return null;
}

/**
 * @typedef {{ ppid: number, pgid: number, sid?: number, tty: string|null, started: string, args: string }} Proc
 * @returns {(pid: number) => Proc | null}
 */
export function procTable() {
  if (process.platform === "linux") return pid => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name is in parentheses and may hold spaces; the state follows it.
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      const ppid = Number(f[1]);
      return Number.isInteger(ppid) ? { ppid, pgid: Number(f[2]), sid: Number(f[3]), tty: ttyName(Number(f[4])), started: f[19], args } : null;
    } catch { return null; }
  };
  /** @type {Map<number, Proc>} */
  const rows = new Map();
  try {
    // lstart is five words ("Sun Sep 27 10:28:26 2026"), then the command line.
    const out = execFileSync(PS, ["-A", "-ww", "-o", "pid=,ppid=,pgid=,tty=,lstart=,args="], { encoding: "utf8", timeout: 4000, maxBuffer: 16 << 20, env: {} });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const t = m[4];
      const tty = t === "??" || t === "?" ? null : t.startsWith("tty") ? t : `tty${t}`;
      rows.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), tty, started: m[5], args: m[6] });
    }
  } catch {}
  return pid => rows.get(pid) || null;
}
