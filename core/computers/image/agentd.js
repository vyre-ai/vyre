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

/** @param {{ user: string, uid: number, display: number }} u */
function check(u) {
  if (!USER_RE.test(String(u.user))) throw new Error(`"${u.user}" is not an agent user name`);
  if (!Number.isInteger(u.uid) || u.uid < MIN_UID) throw new Error(`uid ${u.uid} is below the agent range`);
  if (!Number.isInteger(u.display) || u.display < 20 || u.display > 200) throw new Error(`display ${u.display} is not an agent display`);
}

/** The home of a user. @param {string} user */
export const homeOf = user => `${HOMES}/${user}`;

/** The argv prefix that runs something as the agent's uid with nothing extra: no capabilities, no new privileges, its own group only, limited and niced. @param {{ user: string, uid: number }} u @param {{ memoryMb?: number, procs?: number }} [lim] */
export function asAgent(u, lim = {}) {
  return ["setpriv", `--reuid=${u.uid}`, `--regid=${u.uid}`, "--clear-groups", "--inh-caps=-all", "--no-new-privs",
    "--", "prlimit", `--as=${(lim.memoryMb ?? 3072) * 1024 * 1024}`, `--nproc=${lim.procs ?? 512}`, "nice", "-n", "5"];
}

/** Check the agent's private home and run folder (both made at image build) and make sure they are 0700, as the agent. Idempotent. @param {{ user: string, uid: number, display: number }} u */
export function planCreate(u) {
  check(u);
  const home = homeOf(u.user);
  return [
    [...asAgent(u), "mkdir", "-p", home, `${RUN}/${u.user}`],
    [...asAgent(u), "chmod", "0700", home, `${RUN}/${u.user}`],
  ];
}

/**
 * Start the agent's screen: Xvnc on its own display and VNC port (5900 + display), a window manager, and Chrome with the agent's own profile. The VNC password
 * is written to a file only that agent's runtime folder holds, then handed to Xvnc by path, never on the command line.
 * @param {{ user: string, uid: number, display: number }} u @param {{ memoryMb?: number, procs?: number, size?: string }} [lim]
 */
export function planStartScreen(u, lim = {}) {
  check(u);
  const home = homeOf(u.user);
  const as = asAgent(u, lim);
  const D = `:${u.display}`;
  return [
    [...as, "Xvnc", D, "-geometry", lim.size || "1440x900", "-depth", "24", "-rfbport", String(5900 + u.display), "-rfbauth", `${RUN}/${u.user}/vnc.pass`, "-SecurityTypes", "VncAuth", "-AlwaysShared"],
    [...as, "env", `DISPLAY=${D}`, "fluxbox"],
    [...as, "env", `DISPLAY=${D}`, `HOME=${home}`, "chromium", `--user-data-dir=${home}/.chrome`, "--no-first-run", "--restore-last-session", `--disk-cache-dir=${home}/.cache/chrome`],
  ];
}

/** Stop the agent's screen and Chrome, as the agent (it can signal its own processes and no one else's). Its tmux server, and whatever runs in it, is left alone. @param {{ user: string, uid: number, display: number }} u */
export function planStopScreen(u) {
  check(u);
  const as = asAgent(u);
  return [
    [...as, "pkill", "-TERM", "-u", String(u.uid), "-x", "chromium"],
    [...as, "pkill", "-TERM", "-u", String(u.uid), "-x", "fluxbox"],
    [...as, "pkill", "-TERM", "-u", String(u.uid), "-x", "Xvnc"],
  ];
}

/** Empty the agent's home but keep the folder, its owner and its mode: Chrome profile, files and terminal state go. Run as the agent. @param {{ user: string, uid: number, display: number }} u */
export function planWipeHome(u) {
  check(u);
  const home = homeOf(u.user);
  const as = asAgent(u);
  return [
    [...as, "pkill", "-KILL", "-u", String(u.uid)],
    [...as, "find", home, "-mindepth", "1", "-delete"],
    [...as, "chmod", "0700", home],
  ];
}

/** Free the agent's place: stop everything of its uid and empty its home and run folder. The user and the folders stay in the image for the next agent. @param {{ user: string, uid: number, display: number }} u */
export function planRemove(u) {
  check(u);
  const as = asAgent(u);
  return [
    [...as, "pkill", "-KILL", "-u", String(u.uid)],
    [...as, "find", homeOf(u.user), `${RUN}/${u.user}`, "-mindepth", "1", "-delete"],
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
export const tolerant = argv => argv.includes("pkill");
