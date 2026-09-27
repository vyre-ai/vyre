// @ts-check
// Who is on the other end of vyred's socket: the peer's pid and its process ancestry.
//
// A caller label on the socket is only a claim, and a model's Bash can send "cli" as well as the
// user's terminal can. The person's own actions that take no proof (core/presence PERSON_ONLY)
// need something a model cannot fake: the kernel's word for which process connected. Node has no
// getsockopt, so a one-line perl (on every Mac, and perl-base is in every Debian image) reads it
// off the socket vyred hands it as fd 3: LOCAL_PEERPID on macOS, SO_PEERCRED on Linux.
//
// Then the ancestry: if any process above the caller is a running `claude`, or a process vyred
// started for a thread, the call comes from inside a Claude session, however it got there.
// Processes above vyred itself are not the caller's: a test run, or a vyred someone started from
// a terminal, shares them.

import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { claudeCommand } from "../switchboard/sessions.js";

const PERL = {
  darwin: 'open(my $s, "+<&=", 3) or exit 2; my $v = getsockopt($s, 0, 2) or exit 3; print unpack("i", $v);',
  linux: 'use Socket; open(my $s, "+<&=", 3) or exit 2; my $v = getsockopt($s, SOL_SOCKET, SO_PEERCRED) or exit 3; print((unpack("iii", $v))[0]);',
};

/** @type {WeakMap<object, Promise<number|null>>} */
const cache = new WeakMap();

/**
 * The pid of the process connected to this unix socket, or null when it cannot be read. A
 * keep-alive connection is asked once.
 * @param {import("node:net").Socket} socket
 * @returns {Promise<number|null>}
 */
export function peerPid(socket) {
  let p = cache.get(socket);
  if (!p) { p = readPeerPid(socket); cache.set(socket, p); }
  return p;
}

/** @param {import("node:net").Socket} socket @returns {Promise<number|null>} */
function readPeerPid(socket) {
  const script = PERL[/** @type {"darwin"|"linux"} */ (process.platform)];
  if (!script) return Promise.resolve(null);
  // The fd number, not the Socket: given a Socket, Node wraps its handle for the child and closes
  // it when the child exits, which resets the person's keep-alive connection.
  const fd = /** @type {any} */ (socket)._handle && /** @type {any} */ (socket)._handle.fd;
  if (!Number.isInteger(fd) || fd < 0) return Promise.resolve(null);
  return new Promise(resolve => {
    let out = "";
    const child = spawn("perl", ["-e", script], { stdio: ["ignore", "pipe", "ignore", fd] });
    const timer = setTimeout(() => child.kill(), 3000);
    child.stdout.on("data", d => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", code => {
      clearTimeout(timer);
      const pid = Number(out.trim());
      resolve(code === 0 && Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/**
 * A way to look up one process: its parent and command line, or null. On Linux, /proc/<pid>/stat
 * and cmdline. On macOS, one `ps -A` read up front (ps asks the kernel through sysctl), so a walk
 * costs one process however deep it goes.
 * pgid and sid (Linux) say which process group and session the process runs in: an orphan keeps
 * them when its parent ends, so a thread spawned as its own group still owns what it left behind.
 * @returns {(pid: number) => { ppid: number, args: string, pgid?: number, sid?: number } | null}
 */
export function processTable() {
  if (process.platform === "linux") return pid => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name is in parentheses and may hold spaces; the parent pid follows the state.
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(f[1]);
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      return Number.isInteger(ppid) ? { ppid, args, pgid: Number(f[2]), sid: Number(f[3]) } : null;
    } catch { return null; }
  };
  /** @type {Map<number, { ppid: number, args: string, pgid: number }>} */
  const rows = new Map();
  try {
    for (const line of execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,args="], { encoding: "utf8", timeout: 3000, maxBuffer: 16 << 20 }).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), args: m[4] });
    }
  } catch {}
  return pid => rows.get(pid) || null;
}

/**
 * The chain from pid up to init, pid first, and whether it got there. A process whose parent
 * ended is handed to init (or launchd), so a walk that cannot read a link is incomplete, never
 * "nobody above".
 * @param {number} pid @param {(pid: number) => { ppid: number, args: string } | null} look
 * @param {(pid: number) => boolean} [stop] a pid to stop at, counted as complete
 */
export function ancestry(pid, look, stop = () => false) {
  const chain = [];
  for (let cur = pid, n = 0; n < 128; n++) {
    if (cur <= 1) return { chain, complete: true };
    if (stop(cur)) return { chain, complete: true };
    const p = look(cur);
    if (!p) return { chain, complete: false };
    chain.push({ pid: cur, args: p.args });
    // In a container, a process entered from outside (docker exec) has parent 0.
    if (p.ppid === cur) return { chain, complete: false };
    cur = p.ppid;
  }
  return { chain, complete: false };
}

/**
 * Does this caller's process run inside a Claude session? Any ancestor that is a `claude`, or one
 * of `threads` (the processes vyred runs threads in), counts, so a model's shell is caught
 * whether it runs straight under claude, under a shell it started, or in a tmux or ssh it opened.
 * A person's shell under tmux or sshd has no claude above it. vyred's own process and its
 * ancestors are not the caller's. Unknown when the chain cannot be read to the top.
 * @param {number} pid
 * @param {{ threads?: number[], look?: (pid: number) => { ppid: number, args: string, pgid?: number, sid?: number } | null, self?: number }} [o]
 * @returns {{ inside: boolean, by?: number, unknown?: boolean }}
 */
export function insideClaude(pid, { threads = [], look = processTable(), self = process.pid } = {}) {
  // A thread vyred spawned as its own process group (or session) keeps whatever it leaves behind:
  // an orphan's parent becomes init, but its group and session stay the thread's.
  const own = look(pid);
  if (own) for (const g of [own.pgid, own.sid]) if (g && g > 1 && g !== process.pid && threads.includes(g)) return { inside: true, by: g };
  const mine = new Set(ancestry(self, look).chain.map(p => p.pid));
  const { chain, complete } = ancestry(pid, look, p => mine.has(p));
  for (const p of chain) if (threads.includes(p.pid) || claudeCommand(p.args)) return { inside: true, by: p.pid };
  if (!complete) return { inside: false, unknown: true };
  // The top of the chain, whose parent is init. An app, a terminal, sshd or a tmux server that
  // launchd, init or setsid started leads its own process group. One that does not was started
  // in a shell's group and outlived it (`nohup .. &`): whose shell that was, nobody can say now.
  const top = chain.length ? chain[chain.length - 1] : null;
  const row = top ? look(top.pid) : null;
  if (row && row.ppid <= 1 && row.pgid && row.pgid !== top.pid) return { inside: false, unknown: true };
  return { inside: false };
}
