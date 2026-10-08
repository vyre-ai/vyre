// @ts-check
// system — installing vyred as a systemd service on a Linux box.
//
// Planning is pure: `installPlan` and `uninstallPlan` turn what `detect` saw into a list of
// steps, so every decision is testable on a Mac with no systemd. `apply` is the only thing that
// changes a machine, and it changes nothing unless the caller passes dryRun: false.
//
// vyred runs as the box owner's own login account, never root: Claude Code, its credentials,
// transcripts and the CLI all belong to that person, and ~/.vyre/vyred.sock stays theirs. vyred
// opens no listener of its own on the network: the built-in network and the relay carry every connection out.

import crypto from "node:crypto";
import nodeFs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const ETC = "/etc/systemd/system";

/** @typedef {{ do: "write", path: string, content: string, mode: number }
 *   | { do: "run", argv: string[], why: string, optional?: boolean, ifFails?: string }
 *   | { do: "mkdir", path: string, mode: number, owner: string }
 *   | { do: "remove", path: string }
 *   | { do: "note", text: string }} Step */

const NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
// A unit file is line-based and treats % as a specifier and whitespace as a separator, so a
// path carrying any of those would change the unit's meaning. Refuse rather than escape.
const SAFE_PATH = /^\/[A-Za-z0-9_@+,.:/-]*$/;

function check({ user, group, home, node, pkg }) {
  if (!NAME.test(String(user))) throw new Error(`"${user}" is not a user name`);
  if (user === "root") throw new Error("vyred does not run as root; pass the box owner's own login");
  if (!NAME.test(String(group))) throw new Error(`"${group}" is not a group name`);
  for (const [k, v] of Object.entries({ home, node, pkg })) {
    if (!SAFE_PATH.test(String(v)) || String(v).includes("..")) throw new Error(`${k} "${v}" must be an absolute path without spaces, quotes or %`);
  }
}

/**
 * The unit file.
 * @param {{ user: string, group: string, home: string, node: string, pkg: string }} o
 * @returns {{ "vyre.service": string }}
 */
export function units({ user, group, home, node, pkg }) {
  check({ user, group, home, node, pkg });
  const service = `[Unit]
Description=Vyre
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${group}
Environment=VYRE_SUPERVISOR=systemd
Environment=VYRE_HOME=${home}/.vyre
EnvironmentFile=-${home}/.vyre/env
WorkingDirectory=${home}
ExecStart=${node} ${pkg}/core/daemon/main.js
Restart=always
RestartSec=2
NoNewPrivileges=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;
  return { "vyre.service": service };
}

/**
 * What to do to get vyred running under systemd, given what is already there. Running the same
 * plan twice changes nothing the second time except starting the service if it stopped.
/**
 * What to do to get vyred running under systemd, given what is already there. Running the same
 * plan twice changes nothing the second time except starting the service if it stopped.
 * @param {{ user: string, group: string, home: string, node: string, pkg: string,
 *   hasUnit?: { service?: string }, systemd: boolean, etc?: string, wall?: Step[] }} o
 * @returns {Step[]}
 */
export function installPlan({ user, group, home, node, pkg, hasUnit = {}, systemd, etc = ETC, wall = [] }) {
  if (!systemd) {
    return [{ do: "note", text: "systemd is required for a system install (no /run/systemd/system here). "
      + "Under another supervisor, run `vyre daemon` as the box owner (not root), with VYRE_HOME set, and restart it when it exits." }];
  }
  const u = units({ user, group, home, node, pkg });
  /** @type {Step[]} */
  const steps = [{ do: "mkdir", path: path.join(home, ".vyre"), mode: 0o700, owner: `${user}:${group}` }];
  // The wall watchers run behind (lib/sandbox/apparmor.js): bubblewrap and, where Ubuntu restricts user namespaces, its profile.
  steps.push(...wall);
  const serviceChanged = hasUnit.service !== u["vyre.service"];
  if (serviceChanged) steps.push({ do: "write", path: path.join(etc, "vyre.service"), content: u["vyre.service"], mode: 0o644 });
  const changed = serviceChanged;
  if (changed) steps.push({ do: "run", argv: ["systemctl", "daemon-reload"], why: "pick up the changed unit files" });
  if (changed) {
    steps.push({ do: "run", argv: ["systemctl", "enable", "vyre.service"], why: "start vyred at boot" });
    steps.push({ do: "run", argv: ["systemctl", "restart", "vyre.service"], why: "run vyred with the new units" });
  } else {
    steps.push({ do: "run", argv: ["systemctl", "start", "vyre.service"], why: "make sure vyred is running" });
  }
  return steps;
}

/**
 * Take vyred back off the box. Without purge, ~/.vyre (vault, memory, config) stays.
 * @param {{ purge?: boolean, home: string, etc?: string }} o
 * @returns {Step[]}
 */
export function uninstallPlan({ purge = false, home, etc = ETC, wall = [] }) {
  if (!SAFE_PATH.test(String(home)) || home === "/") throw new Error(`home "${home}" is not a home folder`);
  /** @type {Step[]} */
  const steps = [
    { do: "note", text: "The names of your spaces stay yours in the name directory: removing Vyre from this server releases none of them." },
    { do: "run", argv: ["systemctl", "disable", "--now", "vyre.service"], why: "stop vyred", optional: true },
    { do: "remove", path: path.join(etc, "vyre.service") },
    { do: "run", argv: ["systemctl", "daemon-reload"], why: "forget the removed units", optional: true },
    ...wall,
  ];
  if (purge) {
    steps.push({ do: "note", text: `purge: ${path.join(home, ".vyre")} is deleted, and the vault goes with it. Nothing in it can be recovered afterwards.` });
    steps.push({ do: "remove", path: path.join(home, ".vyre") });
  }
  steps.push({ do: "note", text: "to remove the program itself: npm rm -g vyre" });
  return steps;
}

/** One readable line per step. */
export function describe(step) {
  const oct = m => "0" + m.toString(8).padStart(3, "0");
  switch (step.do) {
    case "write": return `write ${step.path} (${oct(step.mode)})`;
    case "mkdir": return `mkdir ${step.path} (${oct(step.mode)}, owner ${step.owner})`;
    case "remove": return `remove ${step.path}`;
    case "run": return `run ${step.argv.join(" ")}  # ${step.why}`;
    case "note": return `note: ${step.text}`;
    default: throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
}

const runArgv = argv => execFileSync(argv[0], argv.slice(1), { stdio: "inherit" });

/**
 * Print, and unless dryRun, perform each step. Commands run in argv form, never through a shell.
 * dryRun defaults to true so nothing reaches a real system without the caller asking for it.
 * @param {Step[]} steps
 * @param {{ dryRun?: boolean, out?: (line: string) => void, exec?: (argv: string[]) => any, fs?: typeof nodeFs }} [o]
 * @returns {Promise<{ lines: string[], failed: string[] }>}
 */
export async function apply(steps, { dryRun = true, out = console.log, exec = runArgv, fs = nodeFs } = {}) {
  const lines = [], failed = [];
  for (const step of steps) {
    const line = (dryRun && step.do !== "note" ? "would " : "") + describe(step);
    lines.push(line); out(line);
    if (dryRun || step.do === "note") continue;
    if (step.do === "write") writeAtomic(fs, step.path, step.content, step.mode);
    else if (step.do === "mkdir") {
      fs.mkdirSync(step.path, { recursive: true, mode: step.mode });
      fs.chmodSync(step.path, step.mode);
      // chown by name through the system tool: it resolves user:group the same way systemd will.
      exec(["chown", step.owner, step.path]);
    } else if (step.do === "remove") fs.rmSync(step.path, { recursive: true, force: true });
    else if (step.do === "run") {
      try { exec(step.argv); }
      catch (e) {
        if (!step.optional) throw e;
        failed.push(step.argv.join(" "));
        out(`  (did not succeed, carrying on: ${/** @type {Error} */ (e).message.split("\n")[0]})`);
        if (step.ifFails) out(`  ${step.ifFails}`);
      }
    }
  }
  return { lines, failed };
}

/** Temp file in the same folder, fsync, rename: a crash never leaves a half-written unit. */
function writeAtomic(fs, target, text, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, target); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  fs.chmodSync(target, mode);
}

/**
 * Look at the machine. Read-only; every probe that fails reads as "not there".
 * @param {{ fs?: typeof nodeFs, etc?: string }} [o]
 */
export function detect({ fs = nodeFs, etc = ETC } = {}) {
  const read = p => { try { return fs.readFileSync(p, "utf8"); } catch { return undefined; } };
  return {
    systemd: fs.existsSync("/run/systemd/system"),
    units: { service: read(path.join(etc, "vyre.service")) },
  };
}
