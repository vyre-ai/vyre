// @ts-check
// The Windows sandbox: an AppContainer process in a kill-on-close job object, started by vyre-sandbox.exe (win/sandbox.cs).
// Chosen by the spike (team/0.3/SPIKE-runner-windows.md): it needs no virtualization, no reboot and no admin per session, and
// it works on Home, Pro and Enterprise. Measured on the Windows 11 test VM: the container writes only its workspace, cannot read
// another folder or the user profile, has no internet, and reaches the runner's proxy on loopback once the container is exempt
// (an administrator step, done once by prepare()). Known limit: the exemption is per container, not per port, so the session can
// also reach other services listening on this computer's loopback; the proxy therefore requires the per-session token, and
// the Windows firewall cannot narrow it (measured, P10).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "win", "sandbox.cs");
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

/** The container's name for a space: one per space on this computer. @param {string} space */
export const containerName = space => "vyre.runner." + String(space).replace(/[^A-Za-z0-9]/g, "").slice(0, 24);

/** Build the launcher once into the runner's own folder. @param {string} dir @returns {string} the exe path */
export function ensureLauncher(dir) {
  const exe = path.join(dir, "vyre-sandbox.exe");
  const stale = !fs.existsSync(exe) || fs.statSync(exe).mtimeMs < fs.statSync(SRC).mtimeMs;
  if (stale) {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(CSC, ["/nologo", "/optimize", `/out:${exe}`, SRC], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("could not build the Windows sandbox launcher: " + (r.stdout + r.stderr).trim().slice(0, 300));
  }
  return exe;
}

const quote = s => (/[\s"]/.test(s) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s));

/**
 * One-time (per space) setup: make the container, let it use the workspace and the tools, allow loopback.
 * Needs administrator for the loopback exemption; returns what it could do.
 * @param {{ launcher: string, space: string, workspace: string, readOnly?: string[] }} o
 */
export function prepare(o) {
  // An AppContainer token has no "bypass traverse checking": it needs the traverse right on every folder above what it uses, including a
  // mounted encrypted volume's root (measured: CreateProcess fails with 203 without it).
  const above = p => { const out = []; for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) out.push(d); out.push(path.parse(p).root); return out; };
  const trav = [...new Set([o.workspace, ...(o.readOnly || [])].flatMap(above))];
  const args = ["prepare", containerName(o.space), "--grant", `${o.workspace}=M`, ...(o.readOnly || []).flatMap(d => ["--grant", `${d}=RX`]), ...trav.flatMap(d => ["--traverse", d]), "--exempt"];
  const r = spawnSync(o.launcher, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error("could not prepare the Windows sandbox: " + (r.stderr || r.stdout).trim().slice(0, 300));
  return { exempt: /exempt=yes/.test(r.stdout), output: r.stdout.trim() };
}

/** Variables the container process is started with: the launcher passes its own environment on, so the plan returns it. */
const WIN_ENV = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "SystemDrive", "ProgramData", "ProgramFiles", "ALLUSERSPROFILE", "COMPUTERNAME", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];

/**
 * @param {import("./sandbox.js").PlanOpts & { space: string, launcher: string, cleanEnv: (e: any) => Record<string, string> }} o
 */
export function planWin(o) {
  const ws = fs.realpathSync(o.workspace);
  const port = o.proxy.port;
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...o.cleanEnv(o.env), HOME: path.join(ws, "home"), USERPROFILE: path.join(ws, "home"), LOCALAPPDATA: path.join(ws, "home", "AppData", "Local"), APPDATA: path.join(ws, "home", "AppData", "Roaming"), TEMP: path.join(ws, "tmp"), TMP: path.join(ws, "tmp"), TMPDIR: path.join(ws, "tmp"),
    PATH: [process.env.SystemRoot + "\\System32", process.env.SystemRoot, ...(o.readOnly || [])].join(";"),
    ANTHROPIC_BASE_URL: `${base}/provider`, VYRE_SPACE_URL: `${base}/space`,
  };
  for (const k of WIN_ENV) if (process.env[k]) env[k] = /** @type {string} */ (process.env[k]);
  const cmdline = [o.command, ...(o.args || [])].map(quote).join(" ");
  return { argv: [o.launcher, "run", containerName(o.space), path.join(ws, "files"), "--", cmdline], env, cwd: path.join(ws, "files"), cleanup() {}, profile: `AppContainer ${containerName(o.space)}` };
}
