// @ts-check
// kit: what every `vyre` command shares, so they all behave the same way.
//
//   Exit codes   0 ok · 1 failed · 2 usage (the CLI refused the arguments) ·
//                3 a person must prove presence · 4 the vault is locked ·
//                5 vyred is not running or did not answer.
//                3 and 4 are the vault's codes from before this file (core/cli/commands/vault.js),
//                kept so a script that already checks them keeps working.
//   Errors       one line saying what went wrong, then one dim line saying what to do next.
//   --json       reads print their data as one line of JSON and nothing else on stdout. A
//                failure prints {"error":{code,message,next?}} there instead, with the same exit
//                code. core/cli/index.js turns the mode on when --json is anywhere before a `--`.
//   --view       the same data, each line a frame with how to draw it (core/cli/view.js), for
//                the Capsule, chat and the phone. It implies --json.
//
// Colours come from style.js only.

import { spawn } from "node:child_process";
import { out, dim, beacon } from "./style.js";
import { frame } from "./view.js";

/**
 * Spawn this device's "open a URL in the browser" command, detached, its errors swallowed (a
 * missing browser command is never worth failing a run over). Only `http:`/`https:` URLs are
 * opened, on every platform: this opens URLs vyre did not create (an OAuth consent page, a
 * paired server's link), so a `file:`/`javascript:` scheme is refused rather than handed to
 * `open`/`xdg-open` to interpret. On win32 the URL never touches a shell at all: `cmd /c start`
 * would let a query string's `&`, `|`, `^`, `<`, `>` (every OAuth URL has a `&`) run as command
 * operators after it, which is a real vulnerability, not a theoretical one, so this uses
 * `rundll32`'s `FileProtocolHandler` (the same path Explorer opens a link through) with the URL
 * as one argv entry instead. `VYRE_OPEN_BIN` (env) always wins, for tests and for a person's own
 * override, but the http(s)-only check still applies to it.
 * @param {string} url
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, spawn?: typeof spawn }} [opts] `spawn` is
 *   for a test to capture the argv without launching anything real.
 */
export function openInBrowser(url, { env = process.env, platform = process.platform, spawn: spawnImpl = spawn } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  const custom = env.VYRE_OPEN_BIN;
  const [cmd, args] = custom ? [custom, [url]]
    : platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  try {
    const p = spawnImpl(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    p.on("error", () => {});
    p.unref();
  } catch {}
}

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, PRESENCE: 3, LOCKED: 4, UNREACHABLE: 5 });

const PRESENCE = new Set(["presence_required", "presence_refused", "presence_denied", "no_terminal"]);
const DOWN = new Set(["unreachable", "timeout"]);

let JSON_MODE = false;
/** Whether this run prints JSON. index.js sets it; a test may too. */
export const json = () => JSON_MODE;
/** @param {boolean} on */
export function setJson(on) { JSON_MODE = Boolean(on); }

/** @type {{ cmd: string, frames: number, argv: string[] } | null} */
let VIEW = null;
/** Whether this run prints frames (--view). */
export const viewing = () => Boolean(VIEW);
/**
 * Turn frames on for `cmd` ("threads list"), or off. `argv` is the run's words after `vyre`,
 * without --view or --json: what a prompt frame's args start from (again()).
 * @param {string|null} cmd @param {string[]} [argv]
 */
export function setView(cmd, argv = []) { VIEW = cmd ? { cmd, frames: 0, argv } : null; if (cmd) JSON_MODE = true; }
/** The words of this run after `vyre`, without --view or --json, for a prompt frame to rerun. */
export const again = () => (VIEW ? [...VIEW.argv] : []);
/** How many frames this run printed. */
export const framesOut = () => (VIEW ? VIEW.frames : 0);

/** --view anywhere before a `--`. */
export function wantsView(argv) {
  const at = argv.indexOf("--");
  return (at < 0 ? argv : argv.slice(0, at)).includes("--view");
}

/** --json anywhere before a `--` (after it, the words belong to a child command). */
export function wantsJson(argv) {
  const at = argv.indexOf("--");
  return (at < 0 ? argv : argv.slice(0, at)).includes("--json");
}

/**
 * One line of JSON on stdout: the data, or under --view a frame with the data and how to draw it.
 * @param {any} data @param {any} [view] a view from core/cli/view.js; derived from the data when left out
 */
export function emit(data, view) {
  if (VIEW) { VIEW.frames++; process.stdout.write(JSON.stringify(frame(VIEW.cmd, data, view)) + "\n"); }
  else process.stdout.write(JSON.stringify(data) + "\n");
  return EXIT.OK;
}

/** A usage mistake: bad or missing arguments, an unknown flag. Thrown by parse, caught by index.js. */
export class UsageError extends Error {
  /** @param {string} message @param {string} [next] */
  constructor(message, next) { super(message); this.name = "UsageError"; this.next = next; }
}

/**
 * Print a failure and return its exit code. In JSON mode it is the error object instead.
 * @param {string} message
 * @param {{ next?: string, code?: string, exit?: number }} [o]
 */
export function fail(message, { next, code = "failed", exit = EXIT.FAILED } = {}) {
  if (JSON_MODE) emit({ error: { code, message, ...(next ? { next } : {}) } });
  else {
    out(beacon("  " + message));
    if (next) out(dim("  next: " + next));
  }
  return exit;
}

/** A usage mistake, exit 2, pointing at the command's help. @param {string} message @param {string} [next] */
export function usage(message, next) {
  return fail(message, { code: "bad_input", exit: EXIT.USAGE, next: next || helpFor(message) });
}

/** "vyre help threads" for a message that starts "vyre threads ...", else "vyre help". */
function helpFor(message) {
  const m = /^vyre ([a-z][a-z-]*)/.exec(String(message));
  return m ? `vyre help ${m[1]}` : "vyre help";
}

/** The exit code a tool's error means. */
export function exitFor(error) {
  if (!error) return EXIT.OK;
  if (DOWN.has(error.code)) return EXIT.UNREACHABLE;
  if (PRESENCE.has(error.code)) return EXIT.PRESENCE;
  if (error.code === "locked") return EXIT.LOCKED;
  // A tool's bad_input is 1, not 2: it often means "no such thing" (no lesson 9), which is a
  // failure, not a mistyped command. 2 is only for what the CLI rejects before asking vyred.
  return EXIT.FAILED;
}

/** What to do next after a tool's error, when there is something useful to say. */
export function nextFor(error) {
  if (!error) return undefined;
  if (DOWN.has(error.code)) return "vyre up starts it, then try again";
  if (error.code === "no_such_tool") return "update Vyre, then vyre down and vyre up";
  if (error.code === "presence_required") return "run it in your own terminal, where you can confirm it is you";
  if (error.code === "no_terminal") return "run it in your own terminal";
  if (error.code === "locked") return "vyre vault unlock";
  return undefined;
}

/**
 * Print a tool's { error } and return its exit code. Unreachable reads as "vyred is not running".
 * @param {{ code: string, message?: string }} error
 * @param {string} [next] overrides the default next step
 */
export function failTool(error, next) {
  const down = DOWN.has(error.code);
  const message = down ? (error.code === "timeout" ? `vyred did not answer${error.message ? ": " + error.message : ""}` : "vyred is not running")
    : error.code === "no_such_tool" ? `this vyred has no ${String(error.message || "").replace(/^no tool /, "") || "such tool"} yet`
    : String(error.message || error.code);
  return fail(message, { code: error.code, exit: exitFor(error), next: next || nextFor(error) });
}

/** A tool reply's data, or null after printing its error. @param {{ data?: any, error?: any }} r */
export function dataOr(r) {
  if (r.error) { failTool(r.error); return null; }
  return r.data;
}

/**
 * Flags and positional words. `--k v`, `--k=v`, `--flag` for the names in `bool`, repeats for
 * `multi`. `--json`, `--help` and `-h` are always known. A flag not named in `bool`, `multi` or
 * `values` is a UsageError when `values` is given; without `values` any flag takes a value, as
 * the old parser did.
 * @param {string[]} args
 * @param {{ bool?: string[], multi?: string[], values?: string[], cmd?: string }} [spec]
 */
export function parse(args, { bool = [], multi = [], values, cmd } = {}) {
  /** @type {Record<string, any>} */
  const flags = {};
  const pos = [];
  const allBool = [...bool, "json", "help"];
  const next = cmd ? `vyre help ${cmd}` : undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a === "-h") { flags.help = true; continue; }
    if (!a.startsWith("--") || a === "--") { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (allBool.includes(k)) { flags[k] = true; continue; }
    if (values && !values.includes(k) && !multi.includes(k)) throw new UsageError(`--${k} is not a flag${cmd ? " of vyre " + cmd : ""}`, next);
    const v = inline !== undefined ? inline : args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[++i] : undefined;
    if (v === undefined) throw new UsageError(`--${k} needs a value`, next);
    if (multi.includes(k)) (flags[k] ||= []).push(v); else flags[k] = v;
  }
  return { flags, pos };
}

/** Edit distance, for "did you mean". */
export function distance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** The names closest to what was typed, best first: a prefix match or within a third of its length. */
export function closest(word, names, max = 3) {
  const w = String(word).toLowerCase();
  return [...new Set(names)]
    .map(n => ({ n, d: n.startsWith(w) || w.startsWith(n) ? 0.5 : distance(w, n) }))
    .filter(x => x.d <= Math.max(1, Math.ceil(w.length / 3)))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, max).map(x => x.n);
}
