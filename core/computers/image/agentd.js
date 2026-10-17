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

/** Where agents' homes live: one volume for the whole computer, each home 0700. */
export const HOMES = "/home";
/** Where each agent keeps its runtime files (the VNC password file): inside the computer's state volume, each folder made at image build owned by its agent, 0700. */
export const RUN = "/var/lib/vyre/agents";
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
export const homeOf = user => `${HOMES}/${user}`;

/**
 * The argv prefix that runs something as the agent's uid with nothing extra: every capability set emptied (inheritable, ambient, bounding), no new privileges, no groups, limited
 * and niced, with an environment built from nothing. Absolute paths throughout, so no PATH can be bent. @param {{ user: string, uid: number }} u
 * @param {{ memoryMb?: number, procs?: number }} [lim] @param {Record<string, string>} [env] extra variables for the child (DISPLAY, HOME)
 */
export function asAgent(u, lim = {}, env = {}) {
  const vars = { HOME: homeOf(u.user), USER: u.user, LOGNAME: u.user, PATH: PATH_SAFE, LANG: "C.UTF-8", ...env };
  return ["/usr/bin/setpriv", `--reuid=${u.uid}`, `--regid=${u.uid}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs",
    "--", "/usr/bin/prlimit", `--as=${(lim.memoryMb ?? 3072) * 1024 * 1024}`, `--nproc=${lim.procs ?? 512}`, "/usr/bin/nice", "-n", "5",
    "/usr/bin/env", "-i", ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)];
}

/** Check the agent's private home and run folder (both made at image build) and make sure they are 0700, as the agent. Idempotent. @param {{ user: string, uid: number, display: number }} u */
export function planCreate(u) {
  check(u);
  const home = homeOf(u.user);
  return [
    [...asAgent(u), "/usr/bin/mkdir", "-p", home, `${RUN}/${u.user}`],
    [...asAgent(u), "/usr/bin/chmod", "0700", home, `${RUN}/${u.user}`],
  ];
}

/** Marks a plan step as one that keeps running after agentd moves on (a screen, a window manager, Chrome), so agentd starts it and does not wait. @param {string[]} argv */
export const longRunning = argv => Object.assign(argv, { detach: true });

/**
 * Start the agent's screen: Xvnc on its own display and on a unix socket in the agent's run folder (mode 0600, owned by the agent; no TCP port, so no other agent can reach it
 * and a VncAuth password's 8 significant characters guard nothing a stranger can reach), a window manager, and Chrome with the agent's own profile. The VNC password file is
 * written by the agent's own helper from standard input; Xvnc reads it by path.
 * @param {{ user: string, uid: number, display: number }} u @param {{ memoryMb?: number, procs?: number, size?: string }} [lim]
 */
export function planStartScreen(u, lim = {}) {
  check(u);
  const D = `:${u.display}`;
  const as = (/** @type {Record<string, string>} */ env = {}) => asAgent(u, lim, env);
  return [
    longRunning([...as(), "/usr/bin/Xvnc", D, "-geometry", lim.size || "1440x900", "-depth", "24", "-rfbport", "-1", "-rfbunixpath", socketOf(u), "-rfbunixmode", "0600",
      "-rfbauth", `${RUN}/${u.user}/vnc.pass`, "-SecurityTypes", "VncAuth", "-AlwaysShared"]),
    longRunning([...as({ DISPLAY: D }), "/usr/bin/fluxbox"]),
    // Chrome is started by a holder that runs as the agent and keeps Chrome's debugging pipe (no TCP debug port): agentd-chrome.py, with no argument. Its profile (home/.chrome) is the agent's own and survives sleep.
    longRunning([...as({ DISPLAY: D }), "/usr/bin/python3", "-I", "/opt/agentd/agentd-chrome.py"]),
  ];
}

/** The agent's screen socket. @param {{ user: string }} u */
export const socketOf = u => `${RUN}/${u.user}/vnc.sock`;

/** Stop the agent's screen and Chrome, as the agent (it can signal its own processes and no one else's). Its tmux server, and whatever runs in it, is left alone. @param {{ user: string, uid: number, display: number }} u */
export function planStopScreen(u) {
  check(u);
  const as = asAgent(u);
  return [
    [...as, "/usr/bin/pkill", "-TERM", "-u", String(u.uid), "-x", "chromium"],
    [...as, "/usr/bin/pkill", "-TERM", "-u", String(u.uid), "-x", "fluxbox"],
    [...as, "/usr/bin/pkill", "-TERM", "-u", String(u.uid), "-x", "Xvnc"],
  ];
}

/** Empty the agent's home but keep the folder, its owner and its mode: Chrome profile, files and terminal state go. Run as the agent. @param {{ user: string, uid: number, display: number }} u */
export function planWipeHome(u) {
  check(u);
  const home = homeOf(u.user);
  const as = asAgent(u);
  return [
    [...as, "/usr/bin/pkill", "-KILL", "-u", String(u.uid)],
    [...as, "/usr/bin/find", home, "-mindepth", "1", "-delete"],
    [...as, "/usr/bin/chmod", "0700", home],
  ];
}

/** Free the agent's place: stop everything of its uid and empty its home and run folder. The user and the folders stay in the image for the next agent. @param {{ user: string, uid: number, display: number }} u */
export function planRemove(u) {
  check(u);
  const as = asAgent(u);
  return [
    [...as, "/usr/bin/pkill", "-KILL", "-u", String(u.uid)],
    [...as, "/usr/bin/find", homeOf(u.user), `${RUN}/${u.user}`, "-mindepth", "1", "-delete"],
  ];
}

/** Run a plan in order; a step that fails stops the rest unless it is marked tolerant. @param {string[][]} steps @param {(argv: string[]) => Promise<void>} run @param {{ tolerate?: (argv: string[]) => boolean }} [o] */
export async function execute(steps, run, o = {}) {
  for (const argv of steps) {
    try { await run(argv); }
    catch (e) { if (!(o.tolerate && o.tolerate(argv))) throw e; }
  }
}

/** Steps that are fine to fail: stopping what is not running. @param {string[]} argv */
export const tolerant = argv => argv.includes("/usr/bin/pkill");

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
