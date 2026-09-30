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
import path from "node:path";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { claudeCommand } from "../switchboard/sessions.js";

// The child gets vyred's own connection as fd 3, and a file's O_NONBLOCK is shared by every copy of
// it. On macOS libuv clears it for the child, which left vyred's socket blocking: the next large
// write stalled vyred's whole event loop behind a slow reader, and deadlocked when the reader was
// vyred itself (an in-process client). So each script sets it back first, before anything else.
const NONBLOCK = 'use Fcntl; open(my $s, "+<&=", 3) or exit 2; fcntl($s, F_SETFL, fcntl($s, F_GETFL, 0) | O_NONBLOCK) or exit 4;';
const PERL = {
  darwin: `${NONBLOCK} my $v = getsockopt($s, 0, 2) or exit 3; print unpack("i", $v);`,
  linux: `use Socket; ${NONBLOCK} my $v = getsockopt($s, SOL_SOCKET, SO_PEERCRED) or exit 3; print((unpack("iii", $v))[0]);`,
};
/** Whether this platform can say who is on a socket at all (peerPid is null there, not a failure). */
export const canReadPeers = Boolean(PERL[/** @type {"darwin"|"linux"} */ (process.platform)]);

/** @type {WeakMap<object, Promise<number|null>>} */
const cache = new WeakMap();

/**
 * The pid of the process connected to this unix socket, or null when it cannot be read. A
 * keep-alive connection is asked once -- but only once it has an answer: a busy machine can make
 * the kernel read itself slow (rc.2's real find, 28 Sep: at test-concurrency 4, the perl helper's
 * timeout tripped and the person's own CLI was refused). A transient miss is not cached, so the
 * next call on this same connection asks again instead of being stuck refused for its whole life;
 * a real answer, once read, is the kernel's and does not change for as long as the socket stays
 * open, so that one is kept.
 * @param {import("node:net").Socket} socket
 * @returns {Promise<number|null>}
 */
export function peerPid(socket) {
  const cached = cache.get(socket);
  if (cached) return cached;
  const p = readPeerPid(socket).then(pid => { if (pid == null) cache.delete(socket); return pid; });
  cache.set(socket, p);
  return p;
}

/**
 * The perl that reads the peer: by absolute path (SIP-protected on macOS, root-owned perl-base on
 * the box) and with an empty environment. vyred's own PATH and env are its user's, which a model's
 * shell shares: a perl earlier in PATH, or PERL5OPT/PERL5LIB, would be handed fd 3 of every checked
 * connection and could print whatever pid it liked.
 */
const PERL_BIN = "/usr/bin/perl";

/**
 * Put a socket back to non-blocking. The child's own first line does this, but a child that never
 * runs it (a failed exec, a kill) must not leave vyred blocking either, so the parent does too.
 * @param {any} socket
 */
function nonBlocking(socket) {
  try { if (socket && socket._handle && typeof socket._handle.setBlocking === "function") socket._handle.setBlocking(false); } catch {}
}

// A busy box (rc.2's find, 28 Sep: node --test at concurrency 4 on a shared testbox) can starve
// the perl helper past a short timeout, and a fail-closed check then refuses the real person's own
// CLI, not just a model. So one retry, same fd, before giving up -- never more, so a caller cannot
// stretch this into a long hang by keeping the box busy across every attempt.
const PEER_TIMEOUT = 4000, PEER_ATTEMPTS = 2;

/**
 * @param {import("node:net").Socket} socket
 * @param {{ bin?: string, args?: string[] }} [seam] tests only: another program in perl's place
 * @returns {Promise<number|null>}
 */
export function readPeerPid(socket, seam = {}) {
  const script = PERL[/** @type {"darwin"|"linux"} */ (process.platform)];
  if (!script) return Promise.resolve(null);
  // The fd number, not the Socket: given a Socket, Node wraps its handle for the child and closes
  // it when the child exits, which resets the person's keep-alive connection.
  const fd = /** @type {any} */ (socket)._handle && /** @type {any} */ (socket)._handle.fd;
  if (!Number.isInteger(fd) || fd < 0) return Promise.resolve(null);
  const once = () => new Promise(resolve => {
    let out = "";
    const child = spawn(seam.bin || PERL_BIN, seam.args || ["-e", script], { stdio: ["ignore", "pipe", "ignore", fd], env: {} });
    const timer = setTimeout(() => child.kill("SIGKILL"), PEER_TIMEOUT);
    child.stdout.on("data", d => { out += d; });
    child.on("error", () => { clearTimeout(timer); nonBlocking(socket); resolve(null); });
    child.on("close", code => {
      clearTimeout(timer);
      nonBlocking(socket);
      const pid = Number(out.trim());
      resolve(code === 0 && Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
  return (async () => {
    for (let n = 0; n < PEER_ATTEMPTS; n++) {
      // Every attempt asks the SAME connection (the fd captured above) again -- never a pid found
      // some other way -- so a retry can only confirm or fail to confirm this one peer, not drift.
      const pid = await once();
      if (pid != null) return pid;
    }
    return null;
  })();
}

/**
 * A way to look up one process: its parent and command line, or null. On Linux, /proc/<pid>/stat
 * and cmdline. On macOS, one `ps -A` read up front (ps asks the kernel through sysctl), so a walk
 * costs one process however deep it goes.
 * pgid and sid (Linux) say which process group and session the process runs in: an orphan keeps
 * them when its parent ends, so a thread spawned as its own group still owns what it left behind.
 * @param {{ fresh?: boolean, platform?: string, read?: () => Map<number, any>, cache?: { at: number, rows: Map<number, any> | null } }} [o] `fresh` skips the shared snapshot; `read` and `cache` are test seams for the macOS read
 * @returns {(pid: number) => { ppid: number, args: string, pgid?: number, sid?: number } | null}
 */
export function processTable({ fresh = false, platform = process.platform, read = readMacRows, cache = macCache } = {}) {
  if (platform === "linux") return pid => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name is in parentheses and may hold spaces; the parent pid follows the state.
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(f[1]);
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      return Number.isInteger(ppid) ? { ppid, args, pgid: Number(f[2]), sid: Number(f[3]) } : null;
    } catch { return null; }
  };
  // The reviewer's LOW, 28 Sep: this bulk read blocks vyred's whole event loop while it runs, and
  // every connection needing an ancestry check (a fresh insideClaude()) triggers its own by
  // default. Narrower mitigation that does not touch the interface: share one snapshot for a
  // quarter second, so a burst of connections costs one read. It shrinks the frequency of the
  // block; it does not remove it.
  //
  // A snapshot that does not list a pid is never taken as "nobody" (reviewer-2, 30 Sep: a process
  // forked inside the window is not in it, so a forged "cli" label under a claude was believed, 20
  // of 20 on a Mac). A miss on a shared snapshot reads the table again, once; a walk that asks for
  // `fresh` starts from a new read. Only a pid missing from a read taken after the caller
  // connected is really gone.
  const now = Date.now();
  /** @type {Map<number, any>} */
  let rows;
  let refreshed;
  if (!fresh && cache.rows && now - cache.at < MAC_TABLE_TTL) { rows = cache.rows; refreshed = false; }
  else {
    rows = read(); refreshed = true;
    // Only a real answer is cached: an empty table is a failed read, never "nobody above".
    if (rows.size) { cache.at = now; cache.rows = rows; }
  }
  return pid => {
    const hit = rows.get(pid);
    if (hit || refreshed) return hit || null;
    refreshed = true;
    const again = read();
    if (again.size) { rows = again; cache.at = Date.now(); cache.rows = again; }
    return rows.get(pid) || null;
  };
}

/** One `ps -A` read of the process table (macOS). Empty when the read failed twice. @returns {Map<number, { ppid: number, args: string, pgid: number }>} */
function readMacRows() {
  /** @type {Map<number, { ppid: number, args: string, pgid: number }>} */
  const rows = new Map();
  // A busy box can starve this single bulk read past a short timeout (the same rc.2 find as
  // readPeerPid's), and coming back empty reads as "nobody above" -- unknown, refused -- for the
  // real person's own CLI too. One retry, same as the peer read, before accepting empty.
  for (let n = 0; n < PEER_ATTEMPTS && rows.size === 0; n++) {
    try {
      for (const line of execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,args="], { encoding: "utf8", timeout: PEER_TIMEOUT, maxBuffer: 16 << 20 }).split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), args: m[4] });
      }
    } catch {}
  }
  return rows;
}

/** The macOS snapshot shared for MAC_TABLE_TTL. @type {{ at: number, rows: Map<number, any> | null }} */
const macCache = { at: 0, rows: null };
const MAC_TABLE_TTL = 250;

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
 * The kernel's own record of a process's executable image -- never argv, which `exec -a fake` or
 * a custom process title (real sshd does this too, for its privsep display) can say is anything.
 * On Linux, /proc/<pid>/exe is a symlink the kernel maintains to the file that was actually
 * exec'd. macOS has no /proc; the closest without a compiled helper is `lsof`'s `txt` (text
 * segment) mapping, which names the file actually mapped in, not the argv string. Neither is
 * fooled by `setsid -f script ...`, `python3 -c 'import pty; pty.spawn(...)'`, or `exec -a sshd`
 * (the reviewer's reproduction, 28 Sep): those show up as script's, python's or the real caller's
 * own binary, never as sshd's or login's.
 * @param {number} pid @returns {string|null}
 */
export function exePath(pid) {
  try {
    if (process.platform === "linux") return fs.readlinkSync(`/proc/${pid}/exe`);
    const out = execFileSync("lsof", ["-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    for (const line of out.split("\n")) {
      const m = /^\S+\s+\d+\s+\S+\s+txt\s+\S+\s+.*?\s(\/\S+)$/.exec(line);
      if (m) return m[1];
    }
    return null;
  } catch { return null; }
}

/**
 * The pid's owning uid, permission-safe unlike exePath -- reading another uid's `/proc/<pid>/exe`
 * (or its lsof mapping) needs the SAME uid or ptrace access, which vyred does not have onto a
 * more privileged process. On the box vyred runs as its own uid, not root, so the system's own
 * sshd listener (ppid 1, its own session -- the exact ambiguous shape a real ssh login's top of
 * chain has) is a permission EACCES on exePath, not a missing process: found running these tests
 * for real over ssh (28 Sep), where every "vyre <verb>" call, the ordinary way to use the box,
 * hit this and was refused. `/proc/<pid>/status`'s Uid line is world-readable regardless of who
 * owns the target, so this reads the one fact exePath's permission wall does not block.
 * @param {number} pid @returns {number|null}
 */
export function processUid(pid) {
  try {
    if (process.platform === "linux") {
      const m = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
      return m ? Number(m[1]) : null;
    }
    const out = execFileSync("ps", ["-o", "uid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    return out ? Number(out) : null;
  } catch { return null; }
}

/**
 * The ONLY allowlist in this file, and a security boundary: adding to it needs the same review as
 * any other PERSON_ONLY change. Exact absolute paths only, never a basename (the reviewer's own
 * reproduction, 28 Sep: `cp $(command -v script) /tmp/x/login; setsid -f /tmp/x/login -qfc ..`
 * passed the basename version of this check -- a copy the person's own uid made and named
 * anything on the list). login is the one thing left that genuinely hosts a real console/terminal
 * login and is normally root-owned and immutable on both platforms. sshd is deliberately NOT here
 * (the lead's decision, 28 Sep): a model can trivially get itself an sshd leader too
 * (`ssh -o BatchMode=yes localhost ..` after appending its own key to ~/.ssh/authorized_keys,
 * whenever Remote Login is on), so ssh sessions fall through to the same one-proof-per-session
 * fallback as everything else not on this list (Ghostty, iTerm2, VS Code's terminal, Warp, tmux,
 * screen, ssh -- named servers, never a flat refusal: see insideClaude's `server` case below).
 */
const TRUSTED_PATHS = new Set(["/usr/bin/login", "/bin/login",
  "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"]);

/**
 * Every component from `/` down to the file itself must be root-owned and not group- or
 * other-writable, so a person's own build or a copy under their own uid (Homebrew, an
 * /Applications bundle the installer left owned by the admin, a tmpfs a model's shell can write
 * to) can never satisfy this even if it happens to land at an allowlisted path. Not a full
 * immutability proof (a compromised root already owns everything), but it is exactly what SIP
 * paths and system package paths already guarantee on a stock install, and it costs one stat per
 * path component, not a subprocess.
 * @param {string} p @returns {boolean}
 */
function rootOwnedPath(p) {
  try {
    // /bin, /sbin and /lib are themselves symlinks into /usr on a merged-usr Linux (Debian
    // included, so testbox too): a symlink's own lstat shows mode 777 no matter who owns the
    // real target, which would fail every ancestor check on `/bin/login`'s way up through `/bin`
    // for no real reason. Resolve once, then walk the REAL path with a normal stat (no symlinks
    // left to misread).
    for (let cur = fs.realpathSync(p); ; ) {
      const st = fs.statSync(cur);
      if (st.uid !== 0 || (st.mode & 0o022)) return false;
      const parent = path.dirname(cur);
      if (parent === cur) return true;
      cur = parent;
    }
  } catch { return false; }
}

/** @param {string|null} p @returns {boolean} */
function trustedLeader(p) {
  return Boolean(p && TRUSTED_PATHS.has(p) && rootOwnedPath(p));
}

/**
 * Does this caller's process run inside a Claude session? Any ancestor that is a `claude`, or one
 * of `threads` (the processes vyred runs threads in), counts, so a model's shell is caught
 * whether it runs straight under claude, under a shell it started, or in a tmux or ssh it opened.
 * A person's shell under tmux or sshd has no claude above it. vyred's own process and its
 * ancestors are not the caller's. Unknown when the chain cannot be read to the top.
 * @param {number} pid
 * @param {{ threads?: number[], look?: (pid: number) => { ppid: number, args: string, pgid?: number, sid?: number } | null, exe?: (pid: number) => string | null, started?: (pid: number) => string | null, self?: number }} [o]
 * @returns {{ inside: boolean, by?: number, unknown?: boolean, server?: { exe: string, pid: number, started: string } }}
 */
export function insideClaude(pid, { threads = [], look = processTable(), exe = exePath, started = defaultStarted, uid = processUid, self = process.pid } = {}) {
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
  // `setsid -f <cmd>` (util-linux), or a plain fork that calls setsid() itself, produces exactly
  // this shape too: ppid 1, its own session and group, nothing above it to blame -- and it is
  // indistinguishable BY ANCESTRY ALONE from a real terminal, sshd or tmux server that launchd or
  // init started directly. A controlling terminal is not proof either: `setsid -f script -qfc ..`
  // or a python `pty.spawn` hands the detached leader a FRESH, real-looking tty it made up on the
  // spot (the reviewer's own reproduction, 28 Sep, broke the first version of this fix, which
  // checked exactly that). What ancestry alone CAN still say: which binary the kernel actually
  // loaded for this leader (exePath, never argv) -- so this judges that against a short allowlist
  // of what actually hosts a login, not whether a tty exists.
  if (row && row.ppid <= 1 && row.pgid === top.pid) {
    const p = exe(top.pid);
    if (trustedLeader(p)) return { inside: false };
    // exePath can come back null not because there is nothing to read, but because it needs the
    // SAME uid or ptrace access, which vyred does not have onto a more privileged process --
    // found running for real over ssh (28 Sep): the box's own sshd LISTENER (root) is exactly
    // this ambiguous shape, and vyred (its own, non-root uid on the box) cannot read root's
    // /proc/<pid>/exe. The reviewer's HOLD, 28 Sep: uid 0 alone is not enough to trust it outright
    // -- root daemons that run USER-SCHEDULED jobs have this exact same shape (cron: ppid 1, its
    // own session/group, uid 0, unreadable exe from vyred's own uid; a model runs `crontab -`
    // with a job that calls vyre, and its chain tops out at cron). So an unreadable exe, even at
    // uid 0, is never trusted outright -- it is named as a server (below) like anything else the
    // allowlist does not know, keyed generically ("uid0", since there is no real exe path to
    // name) so the person proves it once per server, the same as tmux, screen or ssh.
    const at = p ? started(top.pid) : (uid(top.pid) === 0 ? started(top.pid) : null);
    // Everything else with this shape (tmux, screen, ssh's sshd, Ghostty, iTerm2's server, the
    // VS Code or Cursor terminal, Warp, an unreadable root daemon, or a setsid'd model) is named
    // as a server rather than folded into a flat refusal, per the lead's decision, 28 Sep: nobody
    // with a real terminal the allowlist does not happen to know about gets locked out. The
    // caller can offer the person one presence proof for THIS specific leader (its exe, pid and
    // start time -- never a bare pid, which can be recycled, and never a different process: a
    // model-started one always has its own pid and start time, so it can never inherit trust
    // proved for the person's real one).
    if (at) return { inside: false, unknown: true, server: { exe: p || "uid0", pid: top.pid, started: at } };
    return { inside: false, unknown: true };
  }
  return { inside: false };
}

/** @param {number} pid @returns {string|null} */
function defaultStarted(pid) { const i = procInfo(pid); return i && i.started; }

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
 * The Capsule's own proof, since its shape (ppid 1, its own session, no controlling terminal,
 * launchd-started) is exactly what `setsid` fakes and is not on the terminal-host allowlist
 * above -- and never will be, since it does not host a login at all. What ancestry can never
 * fake: the kernel's own record of exactly which signed binary is running (macOS `codesign`,
 * asked by pid -- it resolves the process's audit token itself, no Security.framework binding
 * needed from Node), compared against the cdhash `vyre capsule install` pinned the last time it
 * signed a build (a person action, at a real terminal; see the allowlist). Not the signing
 * identity or certificate: a self-signed "Vyre Local" cert sits in the login keychain with no ACL,
 * so a model's shell (the same macOS user) could sign its own binary with it and pass a
 * cert-based check. The exact cdhash a person just pinned cannot be forged that way.
 * @param {number} pid @returns {string|null}
 */
export function codeCdhash(pid) {
  const s = codeSignature(pid);
  return s && s.cdhash;
}

/**
 * What `codesign -dvvv` says about a running process: its cdhash, and whether it is signed at all
 * or only ad hoc. An ad-hoc build has no signing identity, so its keychain ACL binds to nothing a
 * same-uid program cannot copy (capsule-pro's test, 28 Sep).
 * @param {number} pid @returns {{ cdhash: string|null, signed: boolean, adhoc: boolean } | null}
 */
export function codeSignature(pid) {
  if (process.platform !== "darwin") return null;
  try {
    // codesign's pid form is a bare or `+`-prefixed pid, never `pid=<n>` (that form fails outright
    // on macOS 26: "No such file or directory") -- found and confirmed against a real signed app
    // by capsule-pro, 28 Sep.
    const r = spawnSync("codesign", ["-dvvv", `+${pid}`], { encoding: "utf8", timeout: 2000 });
    return parseCodesign(`${r.stdout || ""}\n${r.stderr || ""}`);
  } catch { return null; }
}

/** @param {string} text codesign -dvvv output @returns {{ cdhash: string|null, signed: boolean, adhoc: boolean }} */
export function parseCodesign(text) {
  const m = /^CDHash=([0-9a-f]+)$/m.exec(text);
  const signed = Boolean(m) && !/not signed at all/.test(text);
  const adhoc = /^Signature=adhoc$/m.test(text) || /^CodeDirectory .*flags=0x[0-9a-f]*\([^)]*\badhoc\b/m.test(text);
  return { cdhash: m ? m[1] : null, signed, adhoc };
}

/**
 * codeSignature for the process on a socket call, with its start time read before and after so a
 * pid recycled mid-check reads as nothing.
 * @param {number} pid @param {{ started?: (pid: number) => string | null, signature?: typeof codeSignature }} [seam]
 */
export function signatureOf(pid, seam = {}) {
  const started = seam.started || (p => { const i = procInfo(p); return i && i.started; });
  const before = started(pid);
  if (!before) return null;
  const s = (seam.signature || codeSignature)(pid);
  return s && started(pid) === before ? s : null;
}

// The pin itself lives in vyred's own db now (core/presence/index.js's pinCapsule/capsulePin,
// written only through the presence-required presence.capsule.pin tool) -- NOT a file under root. The
// first version of this was a flat JSON file, and the reviewer broke it in one line: 0600 or not,
// it was writable by the same uid vyred runs as, which is also a model's shell's, so nothing
// stopped a direct write of its own build's cdhash there, no tool call and no proof needed at all
// (28 Sep). A DB row through the same presence floor as presence.enroll does not have that hole.

/** @type {WeakMap<object, Promise<boolean>>} */
const capsuleVerified = new WeakMap();

/**
 * Does the live process on this socket match the pinned Capsule build? Read and checked ONCE per
 * connection and cached there (capsule-pro's own note): re-deriving it later in a long-lived
 * connection's life would be asking about a pid that may since have been recycled to an unrelated
 * process. The start time is read before AND after the (slower) codesign call and must still
 * match, so a recycle mid-check is caught even within this one verification.
 * @param {import("node:net").Socket} socket @param {number} pid @param {{ cdhash: string } | null} pin
 * @param {{ started?: (pid: number) => string | null, cdhash?: (pid: number) => string | null }} [seam]
 * @returns {Promise<boolean>}
 */
export function verifiedCapsule(socket, pid, pin, seam = {}) {
  if (!pin || !pin.cdhash) return Promise.resolve(false);
  let v = capsuleVerified.get(socket);
  if (v) return v;
  const started = seam.started || (p => { const i = procInfo(p); return i && i.started; });
  const cdhash = seam.cdhash || codeCdhash;
  v = Promise.resolve().then(() => {
    const before = started(pid);
    if (!before) return false;
    const now = cdhash(pid);
    return Boolean(now && now === pin.cdhash && started(pid) === before);
  });
  capsuleVerified.set(socket, v);
  return v;
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
