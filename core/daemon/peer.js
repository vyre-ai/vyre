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
  return new Promise(resolve => {
    let out = "";
    const child = spawn("perl", ["-e", script], { stdio: ["ignore", "pipe", "ignore", socket] });
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
 * One process: its parent and command line. /proc on Linux, ps elsewhere.
 * @param {number} pid @returns {{ ppid: number, args: string } | null}
 */
export function proc(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name is in parentheses and may hold spaces; the parent pid follows the state.
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      return { ppid, args };
    }
    const out = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const m = /^(\d+)\s+(.*)$/s.exec(out);
    return m ? { ppid: Number(m[1]), args: m[2] } : null;
  } catch { return null; }
}

/** The chain from pid up to init, pid first. @param {number} pid @param {typeof proc} [look] */
export function ancestry(pid, look = proc) {
  const chain = [];
  for (let cur = pid, n = 0; cur > 1 && n < 64; n++) {
    const p = look(cur);
    if (!p) break;
    chain.push({ pid: cur, args: p.args });
    if (p.ppid === cur) break;
    cur = p.ppid;
  }
  return chain;
}

/**
 * Does this caller's process run inside a Claude session? Any ancestor that is a `claude`, or one
 * of `threads` (the processes vyred runs threads in), counts. vyred's own process and its
 * ancestors do not.
 * @param {number} pid
 * @param {{ threads?: number[], look?: typeof proc, self?: number }} [o]
 * @returns {{ inside: boolean, by?: number }}
 */
export function insideClaude(pid, { threads = [], look = proc, self = process.pid } = {}) {
  const mine = new Set(ancestry(self, look).map(p => p.pid));
  for (const p of ancestry(pid, look)) {
    if (mine.has(p.pid)) break;
    if (threads.includes(p.pid) || claudeCommand(p.args)) return { inside: true, by: p.pid };
  }
  return { inside: false };
}

/**
 * The terminal a process runs in, as `who` names it ("ttys003", "pts/3"), or null for none. The
 * kernel's word, like the pid: a double-forked or setsid'd process has none, whatever it says.
 * @param {number} pid @returns {string|null}
 */
export function controllingTty(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const nr = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[4]);
      if (!nr) return null;
      const major = (nr >> 8) & 0xfff, minor = (nr & 0xff) | ((nr >> 12) & 0xfff00);
      if (major >= 136 && major <= 143) return `pts/${minor + (major - 136) * 256}`;
      if (major === 4 && minor < 64) return `tty${minor}`;
      return null;
    }
    const out = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    return !out || out === "??" || out === "?" ? null : out.startsWith("tty") || out.startsWith("pts") ? out : `tty${out}`;
  } catch { return null; }
}

/**
 * One process with its terminal and start time: what binds a window to one login, not to a tty
 * number the next login may reuse. /proc on Linux (start in clock ticks since boot), ps elsewhere.
 * @param {number} pid @returns {{ ppid: number, tty: string|null, started: string, args: string } | null}
 */
export function procInfo(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      return { ppid: Number(f[1]), tty: controllingTty(pid), started: f[19], args };
    }
    // lstart is five words ("Sun Sep 27 10:28:26 2026"), then the command line.
    const out = execFileSync("ps", ["-o", "ppid=,tty=,lstart=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const m = /^(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/s.exec(out);
    if (!m) return null;
    const t = m[2];
    const tty = t === "??" || t === "?" ? null : t.startsWith("tty") || t.startsWith("pts") ? t : `tty${t}`;
    return { ppid: Number(m[1]), tty, started: m[3], args: m[4] };
  } catch { return null; }
}

/**
 * The login a process runs in: its terminal, and the topmost ancestor on that same terminal (the
 * login shell, or `login` on a Mac) with its start time. A new tab or ssh login that gets the same
 * tty number has a new leader, so a window keyed on this never passes to it.
 * @param {number} pid @param {typeof procInfo} [look]
 * @returns {{ tty: string, leader: number, started: string, key: string } | null}
 */
export function loginOf(pid, look = procInfo) {
  const me = look(pid);
  if (!me || !me.tty) return null;
  let leader = pid, started = me.started;
  for (let cur = me.ppid, n = 0; cur > 1 && n < 64; n++) {
    const p = look(cur);
    if (!p || p.tty !== me.tty) break;
    leader = cur; started = p.started;
    if (p.ppid === cur) break;
    cur = p.ppid;
  }
  return { tty: me.tty, leader, started, key: `${me.tty}#${leader}@${started}` };
}

const TMUX = /^(?:\S*\/)?tmux(?::\s|\s|$)/;

/**
 * For a process in a tmux pane: the pids of the tmux clients attached to that pane's session, or
 * null when it is not in tmux or the server cannot be asked. The pane's own terminal is tmux's pty,
 * which no login lists; the person is wherever the clients run. The server is found in the
 * process's own ancestry (tmux's server is the pane shell's parent), never from its environment.
 * @param {number} pid
 * @param {{ look?: typeof procInfo, env?: (pid: number) => Record<string, string>, tmux?: (socket: string, args: string[]) => string }} [o]
 * @returns {number[] | null}
 */
export function tmuxClients(pid, { look = procInfo, env = environ, tmux = runTmux } = {}) {
  // Up to the tmux server: the pane's shell is its child.
  let pane = null, server = null;
  for (let cur = pid, n = 0; cur > 1 && n < 64; n++) {
    const p = look(cur);
    if (!p) return null;
    const parent = look(p.ppid);
    if (parent && TMUX.test(parent.args) && !parent.tty) { pane = cur; server = p.ppid; break; }
    if (p.ppid === cur) return null;
    cur = p.ppid;
  }
  if (!pane || !server) return null;
  // TMUX=<socket>,<server pid>,<session>; trusted only when it names the server found above.
  const [socket, spid] = String(env(pane).TMUX || "").split(",");
  if (!socket || Number(spid) !== server) return null;
  try {
    const session = tmux(socket, ["list-panes", "-a", "-F", "#{pane_pid} #{session_id}"])
      .split("\n").map(l => l.trim().split(" ")).find(([p]) => Number(p) === pane)?.[1];
    if (!session) return null;
    return tmux(socket, ["list-clients", "-F", "#{client_pid} #{session_id}"])
      .split("\n").map(l => l.trim().split(" ")).filter(([, s]) => s === session).map(([p]) => Number(p)).filter(Boolean);
  } catch { return null; }
}

/** A process's environment at its start: /proc on Linux, `ps eww` on a Mac (same user only). */
function environ(pid) {
  try {
    const raw = process.platform === "linux"
      ? fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
      : execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).split(/\s+/);
    return Object.fromEntries(raw.filter(s => /^[A-Z_][A-Z0-9_]*=/.test(s)).map(s => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
  } catch { return {}; }
}

/** @param {string} socket @param {string[]} args */
function runTmux(socket, args) {
  return execFileSync(process.env.VYRE_TMUX_BIN || "tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 2000 });
}
