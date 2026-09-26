// @ts-check
// env: the one way the apps module touches the Mac. Adapters never import child_process; they
// get this object, and a test gets the same object built over fakes.
//
// Three rules live here so no adapter can forget them:
//   - User text reaches AppleScript only as argv. Scripts are constants in the adapters' source,
//     each starting `on run argv`, so a quote or a line break in a note is data, never code.
//   - The real exec never raises a dialog under tests or a throwaway home. The first AppleScript
//     call to an app makes macOS ask for Automation consent, and a shortcut or `open` can bring
//     an app forward, so all three refuse with code no_dialog when dialogsAllowed() says no.
//     They refuse before spawning anything.
//   - Off a Mac they refuse with code not_mac, so the box answers in words, not with ENOENT.
//
// A config fake (`apps.exec`) replaces the process layer entirely and skips the dialog gate: a
// fake shows nothing. The platform check still applies, so tests say `platform: "darwin"`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as childExecFile } from "node:child_process";
import { dialogsAllowed, NO_DIALOG } from "../../core/config/dialogs.js";

/** An error with a code a caller can act on: setup, no_dialog, not_mac, not_found, sends, not_sends, bad_input, failed. */
export class AppsError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * The first argv item every script gets and drops (`set argv to rest of argv`). osascript reads
 * options until the first non-option argument, so without it a note that starts "- buy milk"
 * would be taken as a flag.
 */
export const SENTINEL = "vyre";

export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 * @typedef {(file: string, args: string[], opts?: { input?: string, timeoutMs?: number }) => Promise<ExecResult>} Exec
 */

/**
 * The process layer over child_process.execFile: no shell, a timeout, and an exit code rather
 * than a rejection for a program that ran and failed. `execFile` is injectable so a test can
 * prove the gate refuses without anything being spawned.
 *
 * @param {Function} [execFile]
 * @returns {Exec}
 */
export function realExec(execFile = childExecFile) {
  return (file, args, { input, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => new Promise((ok, no) => {
    const child = execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 << 20, encoding: "utf8" },
      (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
        if (err && (err.killed || err.signal === "SIGKILL")) return no(new AppsError("failed", `${path.basename(file)} did not answer within ${Math.round(timeoutMs / 1000)}s`));
        if (err && typeof err.code === "string") {
          return no(new AppsError(err.code === "ENOENT" ? "setup" : "failed", err.code === "ENOENT" ? `${path.basename(file)} is not on this machine` : err.message));
        }
        ok({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    if (child && child.stdin) child.stdin.end(input === undefined ? undefined : input);
  });
}

/** The words macOS puts in an AppleScript error, without the "execution error:" noise. */
function osaWords(/** @type {string} */ stderr) {
  return String(stderr).replace(/^\d+:\d+: /, "").replace(/^execution error: /, "").trim() || "AppleScript failed";
}

/** Map an osascript failure to a code: a missing object, a missing Automation grant, or anything else. */
function osaError(/** @type {string} */ stderr) {
  const words = osaWords(stderr);
  if (/\(-1743\)/.test(stderr)) {
    const app = (/Apple events to ([^.]+)\./.exec(stderr) || [])[1] || "the app";
    return new AppsError("setup", `allow Vyre to control ${app} in System Settings > Privacy & Security > Automation`);
  }
  if (/\(-1728\)|\(-1719\)/.test(stderr)) return new AppsError("not_found", words);
  return new AppsError("failed", words);
}

/**
 * Build the environment. Nothing runs here: no scan, no process, no timer.
 *
 * @param {{ config?: any, call?: (tool: string, input: any) => Promise<any>, execFile?: Function, vars?: NodeJS.ProcessEnv }} [o]
 *   config is ctx.config.apps; execFile and vars reach below the config fake, for the gate's tests.
 */
export function makeEnv({ config = {}, call = async () => ({ error: { code: "no_such_tool", message: "no registry" } }), execFile, vars = process.env } = {}) {
  const faked = typeof config.exec === "function";
  /** @type {Exec} */
  const exec = faked ? config.exec : realExec(execFile);
  const platform = config.platform || process.platform;

  /** Refuse before spawning: off a Mac, or a real process that might raise a dialog nobody may answer. */
  const guard = (/** @type {string} */ what) => {
    if (platform !== "darwin") throw new AppsError("not_mac", `${what} works only on a Mac`);
    if (!faked && !dialogsAllowed(vars)) throw new AppsError(NO_DIALOG, `${what} may show a macOS dialog, and none may be shown here`);
  };

  /**
   * Run a constant AppleScript with argv. Returns stdout without its final line break.
   * @param {string} script @param {string[]} [argv]
   */
  const osa = async (script, argv = []) => {
    guard("AppleScript");
    const r = await exec("osascript", ["-e", script, SENTINEL, ...argv.map(String)]);
    if (r.code !== 0) throw osaError(r.stderr);
    return r.stdout.replace(/\n$/, "");
  };

  const tmpRoot = config.tmpdir || os.tmpdir();
  const shortcuts = {
    /** The names of the shortcuts this user has. */
    async list() {
      guard("Shortcuts");
      const r = await exec("shortcuts", ["list"]);
      if (r.code !== 0) throw new AppsError("failed", r.stderr.trim() || "shortcuts list failed");
      return r.stdout.split("\n").map(s => s.trim()).filter(Boolean);
    },
    /**
     * Run a shortcut with text input; returns its text output ("" when it has none). Input and
     * output go through files in a private temp folder, removed after, never through argv.
     * @param {string} name @param {string} input
     */
    async run(name, input) {
      guard("Shortcuts");
      const dir = fs.mkdtempSync(path.join(tmpRoot, "vyre-apps-"));
      try {
        const inPath = path.join(dir, "input.txt"), outPath = path.join(dir, "output.txt");
        fs.writeFileSync(inPath, String(input), { mode: 0o600 });
        const r = await exec("shortcuts", ["run", name, "--input-path", inPath, "--output-path", outPath], { timeoutMs: 30000 });
        if (r.code !== 0) throw new AppsError("failed", `the shortcut "${name}" failed: ${r.stderr.trim() || `exit ${r.code}`}`);
        try { return fs.readFileSync(outPath, "utf8"); } catch { return ""; }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };

  /** Bring an app up with `open -a`. It is an app launch, so it goes through the same gate. */
  const open = async (/** @type {string} */ app) => {
    guard(`Opening ${app}`);
    const r = await exec("open", ["-a", app]);
    if (r.code !== 0) throw new AppsError("not_found", r.stderr.trim() || `could not open ${app}`);
  };

  return {
    exec, osa, shortcuts, open, platform, call, config,
    fetch: typeof config.fetch === "function" ? config.fetch : (/** @type {any[]} */ ...a) => globalThis.fetch(.../** @type {[any, any]} */ (a)),
    now: typeof config.now === "function" ? config.now : Date.now,
    timeZone: config.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** @typedef {ReturnType<typeof makeEnv>} Env */
