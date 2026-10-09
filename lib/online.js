// @ts-check
// A Vyre server comes back by itself: after a restart, a power cut or a logout, with nobody at the keyboard (a Mac mini server once lost its login on a restart).
// This is the Mac server's half: the power settings that make "power came back" mean "booted" and "idle" never mean "asleep", the FileVault warning (a Mac with FileVault on waits at the
// login window after an unplanned restart and runs nothing, so no LaunchDaemon helps), and the boot test of the LaunchDaemons. Pure parsing plus a `run` seam, so it is tested without a Mac.
//
// Used by the root installer (installer.js, a server install), by `vyre doctor` (re-checks and, with --repair, fixes) and by the server's status (the app shows the FileVault line).

/** @typedef {(cmd: string, args: string[], o?: { input?: string }) => string} Run */

/** What `pmset -a` is set to on a server: power back means boot, no sleep of the machine or its disk, wake on network access, no Power Nap. (The display may sleep: nothing runs in it.) */
export const POWER = Object.freeze({ autorestart: "1", sleep: "0", disksleep: "0", womp: "1", powernap: "0" });

export const PMSET = "/usr/bin/pmset";
export const FDESETUP = "/usr/bin/fdesetup";
export const LAUNCHCTL = "/bin/launchctl";
export const PLUTIL = "/usr/bin/plutil";

/** `pmset -g` output ("  sleep    0", " autorestart  1 ...") as { key: value } for the keys we care about. The first number after the name is the value; a trailing "(sleep prevented by ...)" is ignored. @param {string} text */
export function parsePmset(text) {
  /** @type {Record<string, string>} */ const out = {};
  for (const line of String(text).split("\n")) {
    const m = /^\s*([a-z]+)\s+(-?\d+)\b/.exec(line);
    if (m && m[1] in POWER) out[m[1]] = m[2];
  }
  return out;
}

/** The settings that are not what a server wants. A setting `pmset -g` does not show (a Mac without Power Nap) is not drift: it cannot be set wrong. @param {Record<string, string>} have */
export function powerDrift(have) {
  return Object.entries(POWER).filter(([k, want]) => k in have && have[k] !== want).map(([key, want]) => ({ key, have: have[key], want }));
}

/** The one command that sets them all (root). */
export const pmsetArgs = () => ["-a", ...Object.entries(POWER).flatMap(([k, v]) => [k, v])];

/** Read, set what drifted, read again. Returns what is wrong after (empty: the Mac stays on and comes back after a power cut). Needs root to set. @param {Run} run @returns {{ changed: boolean, drift: { key: string, have: string, want: string }[] }} */
export function ensurePower(run) {
  const before = powerDrift(parsePmset(run(PMSET, ["-g"])));
  if (!before.length) return { changed: false, drift: [] };
  run(PMSET, pmsetArgs());
  return { changed: true, drift: powerDrift(parsePmset(run(PMSET, ["-g"]))) };
}

/** What `fdesetup status` says: "FileVault is On." / "FileVault is Off." Anything else (not a Mac, no answer) is unknown, never "off". @param {Run} run @returns {"on" | "off" | "unknown"} */
export function fileVault(run) {
  let t = "";
  try { t = run(FDESETUP, ["status"]); } catch { return "unknown"; }
  if (/FileVault is On/i.test(t)) return "on";
  if (/FileVault is Off/i.test(t)) return "off";
  return "unknown";
}

export const FILEVAULT_NOTICE = "FileVault is on. After a power cut or a restart this Mac will wait for someone to type the password, and Vyre will be offline until then. For a server, turn FileVault off in System Settings, Privacy and Security, then run this line again. To keep FileVault anyway, run the line with VYRE_ACCEPT_FILEVAULT=1.";

/** What stays on a server card and in `vyre doctor` for a server installed with FileVault on: it will not come back by itself after a restart. */
export const FILEVAULT_LASTING = "Stops after a restart until someone signs in.";

/** Can this Mac restart through FileVault's login window for a planned restart (an update)? `fdesetup supportsauthrestart` prints true or false. @param {Run} run */
export function authRestartSupported(run) {
  try { return /^true/i.test(String(run(FDESETUP, ["supportsauthrestart"])).trim()); } catch { return false; }
}

/** How a planned restart is done: with FileVault on and authrestart available, `fdesetup authrestart` (it asks for the person's password once and the Mac comes back to the desktop); otherwise a plain restart. @param {Run} run */
export function plannedRestartCommand(run) {
  return fileVault(run) === "on" && authRestartSupported(run) ? { cmd: FDESETUP, args: ["authrestart"] } : { cmd: "/sbin/shutdown", args: ["-r", "now"] };
}

/**
 * The boot test of a LaunchDaemon: launchd knows it (`launchctl print system/<label>` answers), and its plist has RunAtLoad true and a KeepAlive (true or a rule). The plist is read with plutil;
 * when plutil cannot (the answer is not JSON) the caller's own plist object decides.
 * @param {Run} run @param {string} label @param {string} plistFile @param {Record<string, any>} [dict]
 * @returns {{ label: string, loaded: boolean, runAtLoad: boolean, keepAlive: boolean }}
 */
export function bootCheck(run, label, plistFile, dict) {
  let loaded = true;
  try { run(LAUNCHCTL, ["print", `system/${label}`]); } catch { loaded = false; }
  /** @type {Record<string, any> | undefined} */ let d = dict;
  try { const j = JSON.parse(run(PLUTIL, ["-convert", "json", "-o", "-", plistFile])); if (j && typeof j === "object") d = j; } catch { /* the caller's dict stands */ }
  return { label, loaded, runAtLoad: d?.RunAtLoad === true, keepAlive: d?.KeepAlive === true || (typeof d?.KeepAlive === "object" && d.KeepAlive !== null) };
}

/** The sentence a failed boot test says. @param {{ label: string, loaded: boolean, runAtLoad: boolean, keepAlive: boolean }} c */
export const bootProblem = (c) => (!c.loaded ? `${c.label} is not loaded in launchd` : !c.runAtLoad ? `${c.label} does not start at boot (no RunAtLoad)` : !c.keepAlive ? `${c.label} is not restarted if it stops (no KeepAlive)` : "");
