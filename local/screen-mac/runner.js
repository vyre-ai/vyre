// @ts-check
// runner: the long-lived sight helper, with request ids over NDJSON.
//
// Unlike the hands' helper, which runs once per call, sight stays alive: it holds the AX
// observers that keep screen context current, and a helper started per call would have nothing
// to observe with. The cost of that is a helper that can get stuck, so every request has a
// timeout, and a timeout kills the helper so the next call starts a fresh one instead of
// queueing behind a hung app.
//
// Requests go over stdin, never argv: argv is readable by every process through `ps`. Nothing
// the helper says is logged, stderr included, because what it says is what is on the screen.

import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BIN = path.join(HERE, "bin", "sight");
export const BUILD = path.join(HERE, "build.sh");

/** An error with a code the tools can act on. */
export class ScreenError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * The app macOS holds responsible for this process, which is the app that needs the grant. A
 * helper started by a terminal inherits the terminal's grant, so naming the helper would send the
 * person to the wrong row of the settings list. This walks up the parent processes and takes the
 * outermost .app bundle; with none (a launchd agent), the answer is its own executable.
 * Copied from the hands module, not imported: modules never import each other's files.
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
export function grantMessage(app = responsibleApp(), pane = "Accessibility") {
  return `grant ${pane} to ${app} in System Settings > Privacy & Security > ${pane}`;
}

/**
 * @typedef {{
 *   request: (req: Record<string, unknown>) => Promise<any>,
 *   onChanged: (fn: (changed: any) => void) => void,
 *   onRestart: (fn: () => void) => void,
 *   pid: () => number | null,
 *   stop: () => Promise<void>,
 * }} Helper
 */

/**
 * Start the helper on first request and keep it running. A helper that dies is started again
 * on the next request, and a request whose helper died under it is retried once on a fresh one;
 * a second death fails that request with helper_failed rather than looping.
 *
 * `env` is for tests, which hand a fake helper its scenario that way.
 *
 * @param {{ bin?: string, timeoutMs?: number, responsible?: () => string, platform?: string, env?: NodeJS.ProcessEnv }} [o]
 * @returns {Helper}
 */
export function makeHelper({ bin = DEFAULT_BIN, timeoutMs = 5000, responsible = responsibleApp, platform = process.platform, env = process.env } = {}) {
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
  let child = null;
  let nextId = 1;
  /** @type {Map<number, { ok: (v: any) => void, no: (e: any) => void, timer: NodeJS.Timeout, req: any, retried: boolean }>} */
  const waiting = new Map();
  /** @type {((c: any) => void)[]} */
  const changed = [];
  /** @type {(() => void)[]} */
  const restarted = [];
  let stopping = false;

  function launch() {
    const c = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env });
    child = c;
    let buf = "";
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", d => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line) answer(line);
      }
    });
    // Drained and dropped: the helper does not write screen content there, but a pipe nobody
    // reads fills up and stalls it, and a log of it is the last place anything should land.
    c.stderr.resume();
    c.stdin.on("error", () => {});
    c.on("error", () => {});
    c.on("close", () => {
      if (child === c) child = null;
      for (const fn of restarted) fn();
      // Everything in flight retries once on a fresh helper; what already retried fails.
      for (const [id, w] of [...waiting]) {
        waiting.delete(id); clearTimeout(w.timer);
        if (stopping) w.no(new ScreenError("stopped", "the screen module stopped"));
        else if (w.retried) w.no(new ScreenError("helper_failed", `the screen helper exited twice; rebuild it with ${BUILD}`));
        else send(w.req, w.ok, w.no, true);
      }
    });
    return c;
  }

  function answer(/** @type {string} */ line) {
    let body;
    try { body = JSON.parse(line); } catch { return; }
    if (body && body.changed && body.id === undefined) { for (const fn of changed) fn(body.changed); return; }
    const w = waiting.get(body && body.id);
    if (!w) return;
    waiting.delete(body.id); clearTimeout(w.timer);
    if (body.error) {
      if (body.code === "not_trusted") return w.no(new ScreenError("not_trusted", grantMessage(responsible())));
      return w.no(new ScreenError(body.code || "helper_failed", String(body.error)));
    }
    delete body.id;
    w.ok(body);
  }

  /** @param {any} req @param {(v: any) => void} ok @param {(e: any) => void} no @param {boolean} retried */
  function send(req, ok, no, retried) {
    const c = child || launch();
    const id = nextId++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      no(new ScreenError("timeout", `the screen did not answer within ${timeoutMs} ms`));
      // A helper stuck on one app would make every later call wait too.
      c.kill("SIGKILL");
    }, timeoutMs);
    waiting.set(id, { ok, no, timer, req, retried });
    c.stdin.write(JSON.stringify({ ...req, id }) + "\n");
  }

  return {
    request: req => new Promise((ok, no) => {
      if (platform !== "darwin") return no(new ScreenError("unsupported", "screen context works only on macOS"));
      if (!fs.existsSync(bin)) return no(new ScreenError("not_built", `the screen helper is not built; run ${BUILD}`));
      stopping = false;
      send(req, ok, no, false);
    }),
    onChanged: fn => { changed.push(fn); },
    onRestart: fn => { restarted.push(fn); },
    pid: () => (child && child.pid) || null,
    stop: async () => {
      stopping = true;
      const c = child;
      if (!c) return;
      await new Promise(r => { c.once("close", r); c.stdin.end(); setTimeout(() => c.kill("SIGKILL"), 1000).unref(); });
    },
  };
}
