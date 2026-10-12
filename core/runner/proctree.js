// @ts-check
// A session's processes (R031-95 2.4): the sandbox puts the agent in a session and process group of its own (bubblewrap's --new-session), so signalling the group of the process Vyre started reaches only the
// wrapper. To freeze, thaw or measure a session the whole tree under that process is walked by parent, on Linux from /proc and on macOS from ps. Pure over injected readers for the tests.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/** @typedef {{ pid: number, ppid: number, pgid: number, ticks: number, pages: number, pcpu: number, kb: number, state?: string }} Proc */

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
    out.push({ pid: Number(pid), ppid: Number(f[1]), pgid: Number(f[2]), ticks: Number(f[11]) + Number(f[12]), pages: Number(f[21]), pcpu: 0, kb: 0, state: f[0] });
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

/** The pids of everything under a process now (not the process itself), for a caller that wants to see them gone after it ended the first. @param {number} root @param {Proc[]} [procs] */
export function pidsUnder(root, procs = allProcs()) { return treeOf(root, procs).map(p => p.pid).filter(p => p !== root); }

/**
 * End a session's whole tree so that nothing escapes it. Signalling a tree that is still running leaks: a process forked between the snapshot and the signal is not in it, and once its parent is killed it is
 * re-parented away from the root, so the second pass of signalTree cannot find it either (the sandbox's second process outlived the reader on a loaded runner). Here every process found is first STOPPED, so none can
 * fork any more, the tree is read again until a pass finds nothing new, and only then is every one of them killed.
 * @param {number} root @param {{ procs?: () => Proc[], kill?: (pid: number, sig: NodeJS.Signals) => void, passes?: number, sleep?: (ms: number) => void }} [o] @returns {number} how many processes were ended
 */
export function killTree(root, o = {}) {
  const procs = o.procs || (() => allProcs());
  const kill = o.kill || ((/** @type {number} */ pid, /** @type {NodeJS.Signals} */ s) => process.kill(pid, s));
  const sleep = o.sleep || ((/** @type {number} */ ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait available: the next read is the wait */ } });
  // never signal this process or pid 1, whatever the walk reaches: a wrong root or a re-parented walk must not stop vyred itself
  if (!(root > 1) || root === process.pid) return 0;
  const seen = new Set();
  // A stop is a signal: it takes effect when the process next runs, which on a busy runner can be well after kill() returned. A process that was in the middle of forking when it was signalled still makes its child, so a
  // pass that ran at once saw nothing new and the tree was killed with the child missing (the sandbox's second process, left holding the test's pipes). The walk goes on until every process found has stopped (or is gone)
  // and a read after that finds nothing new. A state of undefined (macOS ps) counts as stopped: there the old pass count is all there is.
  const settled = (/** @type {string | undefined} */ st) => st === undefined || st === "T" || st === "t" || st === "Z" || st === "X";
  for (let pass = 0; pass < (o.passes ?? 8) + 200; pass++) {
    let fresh = 0, pending = 0;
    for (const p of treeOf(root, procs())) {
      if (p.pid <= 1 || p.pid === process.pid) continue;
      if (!seen.has(p.pid)) { seen.add(p.pid); fresh++; try { kill(p.pid, "SIGSTOP"); } catch { /* gone */ } }
      if (!settled(p.state)) pending++;
    }
    if (!fresh && !pending) break;
    if (pending) sleep(2);
  }
  for (const pid of seen) { try { kill(pid, "SIGKILL"); } catch { /* gone */ } }
  return seen.size;
}

/**
 * The pids listening on a loopback TCP port now (macOS: lsof). Empty when nothing listens or lsof cannot be run, so a caller that needs "the session's own" never says yes on a failure.
 * @param {number} port @param {{ lsof?: (port: number) => string }} [o] @returns {number[]}
 */
export function listenersOf(port, o = {}) {
  const lsof = o.lsof || ((/** @type {number} */ p) => { try { return execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", timeout: 3000 }); } catch { return ""; } });
  let out = ""; try { out = lsof(port); } catch { return []; }
  return out.split("\n").map(l => /^p(\d+)$/.exec(l)).filter(Boolean).map(m => Number(m?.[1]));
}

/**
 * Is a loopback port served by the session's own processes (the process Vyre started and everything under it)? A Mac lender has no shim to name the port to, so the preview asks this first: a port a dev
 * database, Vyre's own daemon or Docker listens on is not the chat's, and is refused. Every listener on the port must be the session's.
 * @param {number} root @param {number} port @param {{ lsof?: (port: number) => string, procs?: () => Proc[] }} [o]
 */
export function portIsSessions(root, port, o = {}) {
  const pids = listenersOf(port, o);
  if (!pids.length) return false;
  const mine = new Set(treeOf(root, (o.procs || (() => allProcs()))()).map(p => p.pid));
  return pids.every(p => mine.has(p));
}
