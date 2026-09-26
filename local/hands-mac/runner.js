// @ts-check
// runner: one request to the compiled accessibility helper, one JSON answer back.
//
// The helper runs once per call rather than as a long-lived child. A tree walk is a few
// hundred milliseconds of synchronous IPC to another app, and a stuck app should cost one
// call (killed at the timeout), not wedge a helper that every later call would queue behind.
//
// The request goes over stdin, never argv: argv is visible to every process on the machine
// through `ps`, and a request to type may carry something private.

import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { dialogsAllowed } from "../../core/config/dialogs.js";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BIN = path.join(HERE, "bin", "ax");
export const BUILD = path.join(HERE, "build.sh");

/** An error with a code the tools can act on. */
export class HandsError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * The app macOS holds responsible for this process, which is the app that needs the
 * Accessibility grant. A helper started by a terminal inherits the terminal's grant, so naming
 * the helper would send the person to the wrong row of the settings list. This walks up the
 * parent processes and takes the outermost .app bundle; with none (a launchd agent), the
 * responsible process is the one running, so the answer is its own executable.
 *
 * @param {{ ps?: (pid: number) => { ppid: number, command: string } | null, pid?: number, fallback?: string }} [o]
 */
export function responsibleApp({ ps = psOf, pid = process.pid, fallback = process.execPath } = {}) {
  let app = null;
  for (let cur = pid, hops = 0; cur > 1 && hops < 64; hops++) {
    const row = ps(cur);
    if (!row) break;
    const m = /\/([^/]+)\.app\//.exec(row.command);
    if (m) app = m[1];
    cur = row.ppid;
  }
  return app || fallback;
}

function psOf(/** @type {number} */ pid) {
  try {
    const out = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const m = /^(\d+)\s+(.*)$/.exec(out);
    return m ? { ppid: Number(m[1]), command: m[2] } : null;
  } catch { return null; }
}

/** The exact words for a missing grant. The person has to act, so they get the place to click. */
export function grantMessage(app = responsibleApp()) {
  return `grant Accessibility to ${app} in System Settings > Privacy & Security > Accessibility`;
}

/**
 * Make a runner for a helper binary. The hands take any function with this shape, which is how
 * the tests drive them without a screen.
 *
 * @param {{ bin?: string, timeoutMs?: number, responsible?: () => string }} [o]
 * @returns {(request: Record<string, unknown>) => Promise<any>}
 */
export function makeRunner({ bin = DEFAULT_BIN, timeoutMs = 20000, responsible = responsibleApp } = {}) {
  return request => new Promise((ok, no) => {
    if (process.platform !== "darwin") return no(new HandsError("unsupported", "the hands module works only on macOS"));
    if (!fs.existsSync(bin)) return no(new HandsError("not_built", `the accessibility helper is not built; run ${BUILD}`));
    // The real helper drives the screen and can raise the Accessibility prompt: never under tests.
    if (bin === DEFAULT_BIN && !dialogsAllowed()) return no(new HandsError("no_dialog", "the accessibility helper does not run under tests"));
    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const timer = setTimeout(() => {
      done = true; child.kill("SIGKILL");
      no(new HandsError("timeout", `the app did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { if (done) return; done = true; clearTimeout(timer); no(new HandsError("helper_failed", `could not run the helper: ${e.message}; rebuild it with ${BUILD}`)); });
    child.on("close", () => {
      if (done) return;
      done = true; clearTimeout(timer);
      let body;
      try { body = JSON.parse(out.trim().split("\n").pop() || ""); }
      catch { return no(new HandsError("helper_failed", `the helper answered with something that is not JSON${err ? ": " + err.trim().slice(0, 200) : ""}`)); }
      if (body && body.error) {
        if (body.code === "not_trusted") return no(new HandsError("not_trusted", grantMessage(responsible())));
        return no(new HandsError(body.code || "helper_failed", body.error));
      }
      ok(body);
    });
    child.stdin.end(JSON.stringify(request));
  });
}
