// @ts-check
// A session's processes (R031-95 2.4): the sandbox puts the agent in a session and process group of its own (bubblewrap's --new-session), so signalling the group of the process Vyre started reaches only the
// wrapper. To freeze, thaw or measure a session the whole tree under that process is walked by parent, on Linux from /proc and on macOS from ps. Pure over injected readers for the tests.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/** @typedef {{ pid: number, ppid: number, pgid: number, ticks: number, pages: number, pcpu: number, kb: number }} Proc */

/**
 * Every process now, as { pid, ppid, pgid, ticks (utime + stime), pages (rss) } on Linux, or { pid, ppid, pgid, pcpu, kb } on macOS.
 * @param {{ platform?: string, proc?: { pids(): string[], stat(pid: string): string | null }, ps?: () => string }} [o] @returns {Proc[]}
 */
export function allProcs(o = {}) {
  const platform = o.platform || process.platform;
  if (platform === "darwin") {
    const ps = o.ps || (() => { try { return execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,pcpu=,rss="], { encoding: "utf8", timeout: 3000 }); } catch { return ""; } });
    return ps().split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s*$/.exec(line)).filter(Boolean).map(m => ({ pid: Number(m?.[1]), ppid: Number(m?.[2]), pgid: Number(m?.[3]), ticks: 0, pages: 0, pcpu: Number(m?.[4]), kb: Number(m?.[5]) }));
  }
  const proc = o.proc || { pids: () => { try { return fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch { return []; } }, stat: (/** @type {string} */ pid) => { try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return null; } } };
  /** @type {Proc[]} */ const out = [];
  for (const pid of proc.pids()) {
    const s = proc.stat(pid); if (!s) continue;
    // the command name sits in parentheses and may hold spaces: the fields after it start two characters past the last ")"
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    out.push({ pid: Number(pid), ppid: Number(f[1]), pgid: Number(f[2]), ticks: Number(f[11]) + Number(f[12]), pages: Number(f[21]), pcpu: 0, kb: 0 });
  }
  return out;
}

/** The process and everything under it, by parent. @param {number} root @param {Proc[]} procs @returns {Proc[]} */
export function treeOf(root, procs) {
  const kids = new Map();
  for (const p of procs) { const l = kids.get(p.ppid); if (l) l.push(p); else kids.set(p.ppid, [p]); }
  const self = procs.find(p => p.pid === root);
  /** @type {Proc[]} */ const out = self ? [self] : [];
  for (let i = 0; i < out.length; i++) for (const c of kids.get(out[i].pid) || []) if (!out.includes(c)) out.push(c);
  return out;
}

/**
 * Send a signal to a session's whole tree, twice over so a child forked while the first pass ran is reached too. Gone processes are ignored.
 * @param {number} root @param {NodeJS.Signals} sig @param {{ procs?: () => Proc[], kill?: (pid: number, sig: NodeJS.Signals) => void }} [o] @returns {number} how many processes were signalled
 */
export function signalTree(root, sig, o = {}) {
  const procs = o.procs || (() => allProcs());
  const kill = o.kill || ((/** @type {number} */ pid, /** @type {NodeJS.Signals} */ s) => process.kill(pid, s));
  const seen = new Set();
  for (let pass = 0; pass < 2; pass++) for (const p of treeOf(root, procs())) { if (seen.has(p.pid)) continue; seen.add(p.pid); try { kill(p.pid, sig); } catch { /* gone */ } }
  return seen.size;
}
