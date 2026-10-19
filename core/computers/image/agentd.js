// @ts-check
// agentd: the supervisor inside the space's one computer that gives each agent its own Linux user, home, screen and Chrome
// (owner decision, 18 Oct 2026). It runs as root with only CAP_SETUID, CAP_SETGID, CAP_CHOWN and CAP_FOWNER, and it never runs an agent's
// code itself: every agent process is started through `setpriv` as that agent's uid with no capabilities and no new privileges.
//
// This file is the plan: each action is an ordered list of argv arrays (never a shell string), so what runs is readable and testable
// without a container. `run` (given by the caller) executes one argv; agentd.test.js passes a recorder. The HTTP skin that vyred talks to
// and the supervisor loop live in agentd-server.js (next to this file) and call these functions.
//
// The image's root is read-only, so users cannot be added at run time: the image makes ag20000 to ag20063 AND their homes and run folders
// (owned by each uid, 0700) when it is built (Dockerfile), and a new volume copies them as they are. agentd itself keeps only CAP_SETUID and
// CAP_SETGID: it can never chown, read another uid's files or signal another uid's processes, so everything that touches an agent's
// files or processes is run AS that agent (`asAgent`). "Creating" an agent only checks its home; removing one empties its home.
//
// Isolation per agent: uid and gid 20000+n, home /home/ag<uid> mode 0700 (no other agent can list or read it), its own X display :N with
// its own VNC password, Chrome under that uid with its own profile directory, tmux with its own socket in the home, address space and
// process limits through prlimit, nice 5. Nothing here gives an agent a group of another agent or any admin right.

import crypto from "node:crypto";

/** Where each agent keeps its runtime files (the VNC password file): inside the computer's state volume, each folder made at image build owned by its agent, 0700. */
export const RUN = "/var/lib/vyre/agents";
/** An agent's home is inside its own run folder, on the computer's one state volume (the image root is read-only, so a home anywhere else could not be written). Each is 0700. */
/** Each agent has a second uid for its browser: the agent's uid plus this. The browser's profile, memory and debugging socket belong to that uid, so the agent's own shell cannot read them. */
export const BROWSER_OFFSET = 1000;
/** The browser uid's folders (profile, debugging socket), the folder that carries the X cookie to it, and where its downloads land for the agent to read. All made at image build. */
export const BROWSERS = "/var/lib/vyre/browsers", XDIR = "/var/lib/vyre/x", DOWNLOADS = "/var/lib/vyre/downloads";
const USER_RE = /^ag[a-z0-9]{1,28}$/;
const MIN_UID = 20000;
/** The image makes this many agent users; a request outside them is refused. */
const MAX_UID = 20063;
/** The environment every agent process gets: nothing from agentd, so nothing it holds (a token) reaches an agent, and a PATH that cannot be bent. */
const PATH_SAFE = "/usr/local/bin:/usr/bin:/bin";

/** The only triple agentd accepts: the user is ag<uid>, the uid is one the image made, the display follows from the uid. @param {{ user: string, uid: number, display: number }} u */
function check(u) {
  if (!Number.isInteger(u.uid) || u.uid < MIN_UID || u.uid > MAX_UID) throw new Error(`uid ${u.uid} is not one of the agent users`);
  if (u.user !== `ag${u.uid}` || !USER_RE.test(String(u.user))) throw new Error(`"${u.user}" is not an agent user name for uid ${u.uid}`);
  if (u.display !== 20 + (u.uid - MIN_UID)) throw new Error(`display ${u.display} is not the display of uid ${u.uid}`);
}

/** The home of a user. @param {string} user */
export const homeOf = user => `${RUN}/${user}/home`;

/** The agent's browser identity: uid, name, folder, and the X cookie file its Chrome is allowed to read. @param {{ uid: number }} u */
export const browserOf = u => {
  const uid = u.uid + BROWSER_OFFSET, home = `${BROWSERS}/agb${uid}`;
  // trusted: the X cookie of the screen's owner (Xvnc, the window manager, Chrome: all the browser uid's), 0600. xauth: the agent's own, UNTRUSTED cookie (the X SECURITY extension), the only one the agent can read.
  // vncSock and vncPass: the screen's socket and password file, the browser uid's too.
  return { uid, user: `agb${uid}`, home, trusted: `${home}/xauth`, xauth: `${XDIR}/ag${u.uid}/xauth`, vncSock: `${home}/vnc.sock`, vncPass: `${home}/vnc.pass` };
};

/**
 * The argv prefix that runs something as the agent's uid with nothing extra: every capability set emptied (inheritable, ambient, bounding), no new privileges, no groups, limited
 * and niced, with an environment built from nothing. Absolute paths throughout, so no PATH can be bent. @param {{ user: string, uid: number }} u
 * @param {{ memoryMb?: number, procs?: number, nofile?: number, fsizeMb?: number, cpuSeconds?: number }} [lim] @param {Record<string, string>} [env] extra variables for the child (DISPLAY, HOME)
 */
export function asAgent(u, lim = {}, env = {}) {
  return asUid(u.uid, u.user, homeOf(u.user), lim, env);
}

/** The same, for the agent's browser uid (its own home, its own name; no group of the agent's). @param {{ uid: number, user: string }} u @param {{ memoryMb?: number, procs?: number, nofile?: number, fsizeMb?: number, cpuSeconds?: number }} [lim] @param {Record<string, string>} [env] */
export function asBrowser(u, lim = {}, env = {}) {
  const b = browserOf(u);
  return asUid(b.uid, b.user, b.home, lim, env);
}

/** @param {number} uid @param {string} user @param {string} home @param {{ memoryMb?: number, procs?: number, nofile?: number, fsizeMb?: number, cpuSeconds?: number, noAddressCap?: boolean, dataMb?: number }} lim @param {Record<string, string>} env */
function asUid(uid, user, home, lim, env) {
  const vars = { HOME: home, USER: user, LOGNAME: user, PATH: PATH_SAFE, LANG: "C.UTF-8", ...env };
  const u = { uid };
  return ["/usr/bin/setpriv", `--reuid=${u.uid}`, `--regid=${u.uid}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs",
    "--", "/usr/bin/prlimit", ...(lim.noAddressCap === true ? [`--data=${(lim.dataMb ?? 3072) * 1024 * 1024}`] : [`--as=${(lim.memoryMb ?? 3072) * 1024 * 1024}`]), `--nproc=${lim.procs ?? 512}`, `--nofile=${lim.nofile ?? 4096}`, `--fsize=${(lim.fsizeMb ?? 4096) * 1024 * 1024}`,
    ...(lim.cpuSeconds ? [`--cpu=${lim.cpuSeconds}`] : []), "/usr/bin/nice", "-n", "5",
    "/usr/bin/env", "-i", ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)];
}

/** Check the agent's private home and run folder (both made at image build) and make sure they are 0700, as the agent. Idempotent. @param {{ user: string, uid: number, display: number }} u */
export function planCreate(u) {
  check(u);
  const home = homeOf(u.user);
  const b = browserOf(u);
  return [
    [...asAgent(u), "/usr/bin/mkdir", "-p", home, `${RUN}/${u.user}`],
    [...asAgent(u), "/usr/bin/chmod", "0700", home, `${RUN}/${u.user}`],
    // the browser's own folders, as the browser uid
    [...asBrowser(u), "/usr/bin/mkdir", "-p", `${b.home}/profile`],
    [...asBrowser(u), "/usr/bin/chmod", "0700", `${b.home}/profile`, b.home],
    ...planFolders(u),
  ];
}

/** The folders every agent's home has (owner, 20 Oct 2026), in the order Files shows them. Downloads is the one Chrome saves to. */
export const FOLDERS = Object.freeze(["Inbox", "Work", "Done", "Downloads", "Scripts", "Notes"]);
/** A step that may fail without failing its plan (a folder or link that is already there, the wallpaper). @param {string[]} argv */
const mayFail = argv => Object.assign(argv, { tolerate: true });

/**
 * The agent's tidy folder, as the agent: Inbox, Work, Done, Scripts and Notes are made when missing (mkdir -p never replaces anything), and Downloads is a link to the folder Chrome
 * saves into (DOWNLOADS/ag<uid>, the browser uid's, which the agent reads and cannot write: a download can never be swapped for a link into the browser's profile, e2e review MEDIUM 3).
 * `ln -s -T` refuses when anything is already called Downloads, so an agent's own file or folder of that name is kept. Both steps may fail and the plan goes on.
 * @param {{ user: string, uid: number, display: number }} u
 */
export function planFolders(u) {
  check(u);
  const home = homeOf(u.user);
  return [
    mayFail([...asAgent(u), "/usr/bin/mkdir", "-p", ...FOLDERS.filter(f => f !== "Downloads").map(f => `${home}/${f}`)]),
    mayFail([...asAgent(u), "/usr/bin/ln", "-s", "-T", `${DOWNLOADS}/ag${u.uid}`, `${home}/Downloads`]),
  ];
}

/** The desk's fixed files, root's and read-only in the image (Dockerfile): the window manager's settings (no menus, no launchers of its own) and the Vyre mark the wallpaper is made from. */
export const DESK = Object.freeze({ fluxbox: "/etc/vyre-desk/fluxbox/init", mark: "/usr/share/vyre-desk/mark.png", background: "#0E0D0C" });
/** A screen size Xvnc and the wallpaper may be given: WIDTHxHEIGHT, nothing else. @param {unknown} s */
const sizeOf = s => typeof s === "string" && /^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$/.test(s) ? s : "1440x900";

/** Marks a plan step as one that keeps running after agentd moves on (a screen, a window manager, Chrome), so agentd starts it and does not wait. @param {string[]} argv */
export const longRunning = argv => Object.assign(argv, { detach: true });

/**
 * Start the agent's screen: Xvnc on its own display and on a unix socket in the agent's run folder (mode 0600, owned by the agent; no TCP port, so no other agent can reach it
 * and a VncAuth password's 8 significant characters guard nothing a stranger can reach), a window manager, Chrome with the agent's own profile, and the desk (the wallpaper, and the
 * agent's own dock of Chrome, Terminal and Files). The VNC password file is
 * written by the agent's own helper from standard input; Xvnc reads it by path.
 * @param {{ user: string, uid: number, display: number }} u @param {{ memoryMb?: number, procs?: number, size?: string }} [lim]
 */
export function planStartScreen(u, lim = {}) {
  check(u);
  const D = `:${u.display}`;
  const b = browserOf(u);
  const bs = (/** @type {Record<string, string>} */ env = {}) => asBrowser(u, lim, env);
  const onScreen = { DISPLAY: D, XAUTHORITY: b.trusted };
  // The screen belongs to the BROWSER uid: Xvnc, the window manager and Chrome run as it, with a trusted X cookie only it can read, and the VNC socket and password are its too. The agent's own uid cannot read the
  // screen's memory or cookie, so it cannot read keystrokes typed into the screen (a person's password in a take-over included). What the agent gets is an UNTRUSTED cookie (the X SECURITY extension): its X clients
  // can draw their own windows and cannot read, grab or record those of any other client.
  const trusted = Object.assign([...bs(), "/usr/bin/xauth", "-f", b.trusted, "source", "-"], { input: `add ${D} . ${crypto.randomBytes(16).toString("hex")}\n` });
  // generated by the running server, so it waits for it to be up
  const untrusted = Object.assign([...bs(onScreen), "/usr/bin/xauth", "-f", b.xauth, "generate", D, ".", "untrusted"], { retry: { tries: 40, delayMs: 250 } });
  const size = sizeOf(lim.size), wallpaper = `${b.home}/wallpaper.png`;
  return [
    [...bs(), "/usr/bin/rm", "-f", b.trusted, b.xauth, b.vncSock],
    trusted,
    [...bs(), "/usr/bin/chmod", "0600", b.trusted],
    longRunning([...bs(), "/usr/bin/Xvnc", D, "-geometry", size, "-depth", "24", "-rfbport", "-1", "-rfbunixpath", b.vncSock, "-rfbunixmode", "0600",
      "-rfbauth", b.vncPass, "-auth", b.trusted, "-SecurityTypes", "VncAuth", "-AlwaysShared",
      // the agent's untrusted cookie is an X SECURITY extension authority: without the extension there is no such cookie and the agent has no way onto its own screen (the computer's own Xvnc has it, entrypoint.sh)
      "+extension", "SECURITY"]),
    untrusted,
    [...bs(), "/usr/bin/chmod", "0640", b.xauth],
    // the window manager with the desk's own settings (root's, read-only): no toolbar, no desktop menu, no key that starts a program, so nothing on this screen starts anything as the browser uid
    longRunning([...bs(onScreen), "/usr/bin/fluxbox", "-rc", DESK.fluxbox]),
    // Chrome is started by a holder that keeps Chrome's debugging pipe (no TCP debug port): agentd-chrome.py, with no argument. The profile, the pipe's socket and the memory are the browser uid's too. The profile survives sleep.
    // No address-space cap on Chrome (an explicit noAddressCap only this call sets; RLIMIT_DATA, which counts committed private memory and not Chrome's reservations, bounds it instead): it reserves far more virtual memory than it uses, and under RLIMIT_AS it dies at start (security-live 18 Oct). Its memory is held by the computer's own limit and its process count by --nproc.
    longRunning([...asBrowser(u, { ...lim, noAddressCap: true }), "/usr/bin/python3", "-I", "/opt/agentd/agentd-chrome.py"]),
    // The wallpaper, as the screen's owner: the Vyre mark, small, in the middle of a dark screen of this size, set on the root window. A failure costs the picture, never the screen.
    mayFail([...bs(), "/usr/bin/convert", "-size", size, `xc:${DESK.background}`, "(", DESK.mark, "-resize", "112x112", ")", "-gravity", "center", "-composite", `PNG24:${wallpaper}`]),
    longRunning([...bs(onScreen), "/usr/bin/display", "-window", "root", wallpaper]),
    // The dock (Chrome, Terminal, Files) runs as the AGENT with its untrusted cookie, like any window the agent opens: what it starts (a terminal, the file manager) is the agent's, in the
    // agent's folder. Its Chrome button only asks the holder to show Chrome (agentd-chrome.py: a FIFO the agent may write to, read as "open a tab"); it never reaches Chrome's pipe.
    longRunning([...asAgent(u, lim, { DISPLAY: D, XAUTHORITY: b.xauth }), "/usr/bin/python3", "-I", "/opt/agentd/agentd-dock.py"]),
    ...planFolders(u),
  ];
}

/** The agent's screen socket. @param {{ user: string }} u */
export const socketOf = u => browserOf(u).vncSock;

/** Stop the agent's screen and Chrome, as the agent (it can signal its own processes and no one else's). Its tmux server, and whatever runs in it, is left alone. @param {{ user: string, uid: number, display: number }} u */
export function planStopScreen(u) {
  check(u);
  const bs = asBrowser(u), b = browserOf(u);
  // all three are the browser uid's: Chrome first (it ends on SIGTERM and writes its profile; its holder ends with it), then the window manager, then the screen
  // First Chrome's holder: it asks Chrome to close itself over the debugging pipe, which writes the profile (a login made in the last 30 s is in it); the wait gives that its few seconds.
  // Then the plain SIGTERM to whatever is left, the window manager and the screen.
  return [
    // the dock is the agent's, so the agent's uid ends it (its terminal and file manager end with the screen; the terminal's tmux session stays)
    [...asAgent(u), "/usr/bin/pkill", "-TERM", "-u", String(u.uid), "-f", "^/usr/bin/python3 -I /opt/agentd/agentd-dock.py$"],
    [...bs, "/usr/bin/pkill", "-TERM", "-u", String(b.uid), "-f", "^/usr/bin/python3 -I /opt/agentd/agentd-chrome.py$"],
    [...bs, "/usr/bin/sleep", "4"],
    ...["chromium", "fluxbox", "Xvnc"].map(name => [...bs, "/usr/bin/pkill", "-TERM", "-u", String(b.uid), "-x", name]),
  ];
}

/** Empty the agent's home but keep the folder, its owner and its mode: Chrome profile, files and terminal state go. Run as the agent. @param {{ user: string, uid: number, display: number }} u */
export function planWipeHome(u) {
  check(u);
  const home = homeOf(u.user), b = browserOf(u);
  const as = asAgent(u), bs = asBrowser(u);
  return [
    [...as, "/usr/bin/pkill", "-KILL", "-u", String(u.uid)],
    [...bs, "/usr/bin/pkill", "-KILL", "-u", String(b.uid)],
    [...as, "/usr/bin/find", home, "-mindepth", "1", "-delete"],
    [...as, "/usr/bin/chmod", "0700", home],
    // the browser's profile and logins are the browser uid's to empty
    [...bs, "/usr/bin/find", b.home, `${DOWNLOADS}/ag${u.uid}`, "-mindepth", "1", "-delete"],
    [...bs, "/usr/bin/mkdir", `${b.home}/profile`],
    [...bs, "/usr/bin/chmod", "0700", `${b.home}/profile`, b.home],
    // the folder's structure comes back, empty
    ...planFolders(u),
  ];
}

/** Free the agent's place: stop everything of its uid and empty its home and run folder. The user and the folders stay in the image for the next agent. @param {{ user: string, uid: number, display: number }} u */
export function planRemove(u) {
  check(u);
  const b = browserOf(u);
  const as = asAgent(u), bs = asBrowser(u);
  return [
    [...as, "/usr/bin/pkill", "-KILL", "-u", String(u.uid)],
    [...bs, "/usr/bin/pkill", "-KILL", "-u", String(b.uid)],
    [...as, "/usr/bin/find", `${RUN}/${u.user}`, "-mindepth", "1", "-delete"],
    // the home was inside what was just emptied: make it again, empty, for the next agent that takes this place
    [...as, "/usr/bin/mkdir", homeOf(u.user)],
    [...as, "/usr/bin/chmod", "0700", homeOf(u.user), `${RUN}/${u.user}`],
    // the browser's profile, and what it downloaded for the agent, are the browser uid's to empty
    [...bs, "/usr/bin/find", b.home, `${DOWNLOADS}/ag${u.uid}`, "-mindepth", "1", "-delete"],
    [...bs, "/usr/bin/mkdir", `${b.home}/profile`],
    [...bs, "/usr/bin/chmod", "0700", `${b.home}/profile`, b.home],
  ];
}

/** Run a plan in order; a step that fails stops the rest unless it is marked tolerant. @param {string[][]} steps @param {(argv: string[]) => Promise<void>} run @param {{ tolerate?: (argv: string[]) => boolean }} [o] */
export async function execute(steps, run, o = {}) {
  for (const argv of steps) {
    const retry = /** @type {any} */ (argv).retry;
    const tries = retry && Number.isInteger(retry.tries) ? Math.min(retry.tries, 100) : 1;
    for (let n = 1; ; n++) {
      try { await run(argv); break; }
      catch (e) {
        if (n < tries) { await new Promise(r => setTimeout(r, Math.min(Number(retry.delayMs) || 250, 2000))); continue; }
        if (!(o.tolerate && o.tolerate(argv))) throw e;
        break;
      }
    }
  }
}

/** Steps that are fine to fail: stopping what is not running, and the steps marked so (a folder that is already there, the wallpaper). @param {string[]} argv */
export const tolerant = argv => argv.includes("/usr/bin/pkill") || /** @type {any} */ (argv).tolerate === true;

/** Listing an agent's tmux sessions, as the agent: one line per session, "name windows". The socket is the agent's own, in its own run folder. @param {{ user: string, uid: number, display: number }} u */
export function planTerminals(u) {
  check(u);
  return [...asAgent(u), "/usr/bin/tmux", "-S", `${RUN}/${u.user}/tmux.sock`, "list-sessions", "-F", "#{session_name} #{session_windows}"];
}

/** @param {string} text @returns {Array<{ name: string, windows: number }>} */
export function parseTerminals(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = /^([A-Za-z0-9_.-]{1,40}) (\d{1,3})$/.exec(line.trim());
    if (m) out.push({ name: m[1], windows: Number(m[2]) });
  }
  return out.slice(0, 50);
}

/** Names an exec may not set: agentd builds these itself, or they change what the loader or the shell runs. */
const EXEC_FORBIDDEN = /^(PATH|HOME|USER|LOGNAME|SHELL|DISPLAY|XAUTHORITY|IFS|ENV|BASH_ENV|LD_.*|DYLD_.*|PYTHON.*|NODE_OPTIONS|PERL.*|RUBY.*)$/;
export const EXEC_LIMITS = Object.freeze({ argc: 64, argvBytes: 4096, stdinBytes: 8192, envCount: 16, envValueBytes: 1024, timeoutMs: 25_000, defaultTimeoutMs: 20_000, stdoutBytes: 16 * 1024, stderrBytes: 8 * 1024 });

/** Check a request to run a command as the agent (shared by the one-shot exec and the streaming run): the argv, the folder and the extra variables, exactly as planExec and the run helper use them. @param {{ user: string, uid: number, display: number }} u @param {{ argv?: any, cwd?: any, env?: any }} req @param {number} [maxArgvBytes] @returns {{ argv: string[], cwd: string, env: Record<string, string> }} */
export function validateRun(u, req, maxArgvBytes = EXEC_LIMITS.argvBytes) {
  check(u);
  const argv = req.argv;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > EXEC_LIMITS.argc || argv.some(x => typeof x !== "string" || x.includes("\0"))) throw new Error("a command is 1 to 64 text arguments");
  if (!/^\/[A-Za-z0-9_.\/+-]{1,200}$/.test(argv[0]) || argv[0].includes("..")) throw new Error("the command must be an absolute path");
  if (argv.reduce((n, x) => n + Buffer.byteLength(x) + 1, 0) > maxArgvBytes) throw new Error("the command is too long");
  const home = homeOf(u.user);
  const cwd = req.cwd === undefined || req.cwd === null ? home : String(req.cwd);
  if (!/^\/[A-Za-z0-9_.\/ +@=-]{1,300}$/.test(cwd) || cwd.split("/").includes("..") || !(cwd === home || cwd.startsWith(home + "/"))) throw new Error("the folder must be inside the agent's home");
  /** @type {Record<string, string>} */ const env = {};
  const given = req.env === undefined || req.env === null ? {} : req.env;
  if (typeof given !== "object" || Array.isArray(given) || Object.keys(given).length > EXEC_LIMITS.envCount) throw new Error("env is a few NAME: value pairs");
  for (const [k, v] of Object.entries(given)) {
    if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(k) || EXEC_FORBIDDEN.test(k)) throw new Error(`${k} cannot be set`);
    if (typeof v !== "string" || v.includes("\0") || Buffer.byteLength(v) > EXEC_LIMITS.envValueBytes) throw new Error(`the value of ${k} is not usable`);
    env[k] = v;
  }
  return { argv, cwd, env };
}

/**
 * Run a command as the agent: its uid, no groups, no capabilities, no new privileges, the usual memory and process limits, a clean environment (HOME, USER, PATH, LANG, the agent's display and cookie, and
 * the named variables the caller asked for, none of the forbidden names), in a folder under the agent's own home. Nothing is passed through a shell.
 * @param {{ user: string, uid: number, display: number }} u
 * @param {{ argv?: any, cwd?: any, env?: any }} req @param {{ memoryMb?: number, procs?: number, nofile?: number, fsizeMb?: number, cpuSeconds?: number }} [lim]
 * @returns {string[]}
 */
export function planExec(u, req, lim = {}) {
  const { argv, cwd, env } = validateRun(u, req);
  const b = browserOf(u);
  // the fixed variables are laid over the caller's, never the reverse
  return [...asAgent(u, { cpuSeconds: 120, ...lim }, { ...env, DISPLAY: `:${u.display}`, XAUTHORITY: b.xauth }), "/usr/bin/env", "-C", cwd, ...argv];
}

/** A streaming run (a harness session) may carry a longer command line than a one-shot exec. */
export const RUN_ARGV_BYTES = 10_000;
