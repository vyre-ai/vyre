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
