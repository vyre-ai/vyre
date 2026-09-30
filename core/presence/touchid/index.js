// @ts-check
// Runs the Touch ID helper (touchid.swift). vyred builds it on first use into a private folder in
// the temp dir, records the binary's hash, and checks that hash before every run, because anything
// running as this user (a model included) could swap the file for one that always says "ok".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dialogsAllowed, NO_DIALOG } from "../../config/dialogs.js";

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "touchid.swift");
const SWIFTC = "/usr/bin/swiftc";

/** @typedef {{ path: string, hash: string }} Helper */
/** @typedef {{ dir?: string, swiftc?: string, platform?: string, source?: string, env?: NodeJS.ProcessEnv }} BuildOptions */

/** @type {{ swiftc: string, platform: string, source?: string, dir?: string, env?: NodeJS.ProcessEnv }} */
let config = { swiftc: SWIFTC, platform: process.platform };
/** @type {Promise<Helper> | null} */
let helper = null;

const sha256 = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/** Make (or check) our private build folder. Throws if it is not safely ours. */
function privateDir(dir = path.join(os.tmpdir(), `vyre-presence-${uid() < 0 ? "user" : uid()}`)) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  const mine = uid() < 0 || st.uid === uid();
  if (!st.isDirectory() || !mine || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a private folder owned by this user; refusing to build the Touch ID helper there`);
  }
  return dir;
}

/**
 * @param {string} file @param {string[]} args @param {number} ms
 * @returns {Promise<{ code: number | null, killed: boolean, stdout: string }>}
 */
function run(file, args, ms) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: ms, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (err, stdout) => {
      const e = /** @type {any} */ (err);
      resolve({ code: err ? (typeof e.code === "number" ? e.code : null) : 0, killed: Boolean(e?.killed), stdout: String(stdout || "").trim() });
    });
    child.stdin?.end();
  });
}

/** @param {typeof config} c @returns {Promise<Helper>} */
async function compile(c) {
  if (c.platform !== "darwin") throw new Error("Touch ID needs macOS");
  if (!fs.existsSync(c.swiftc)) throw new Error(`${c.swiftc} not found`);
  const dir = privateDir(c.dir);
  const file = c.source || SOURCE;
  const source = fs.readFileSync(file);
  const target = path.join(dir, `vyre-${path.basename(file, ".swift")}-${sha256(source).slice(0, 16)}`);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const r = await run(c.swiftc, ["-O", "-o", tmp, file], 300_000);
  if (r.code !== 0) { fs.rmSync(tmp, { force: true }); throw new Error(`swiftc failed (${r.code})`); }
  fs.renameSync(tmp, target);
  const st = fs.lstatSync(target);
  if (!st.isFile() || (uid() >= 0 && st.uid !== uid()) || (st.mode & 0o022) !== 0) {
    throw new Error(`${target} is not a private file owned by this user`);
  }
  return { path: target, hash: sha256(fs.readFileSync(target)) };
}

/**
 * Build the helper now, with the given options (tests pass a stub swiftc and their own folder).
 * Later calls to available() and authenticate() use these options.
 * @param {BuildOptions} [opts]
 * @returns {Promise<Helper>}
 */
export function build({ dir, swiftc = SWIFTC, platform = process.platform, env } = {}) {
  config = { dir, swiftc, platform, env };
  helper = compile(config);
  helper.catch(() => { helper = null; });
  return helper;
}

/** The helper, built once per process. A failed build is tried again on the next call. */
function ensure() {
  if (!helper) {
    helper = compile(config);
    helper.catch(() => { helper = null; });
  }
  return helper;
}

/**
 * Run the helper after checking it is the binary we built. A changed binary is refused and rebuilt.
 * @param {string[]} args @param {number} ms
 */
async function runHelper(args, ms) {
  const h = await ensure();
  let now = "";
  try { now = sha256(fs.readFileSync(h.path)); } catch { /* missing counts as changed */ }
  if (now !== h.hash) {
    helper = null;
    ensure().catch(() => {});
    return { changed: true, code: null, killed: false, stdout: "" };
  }
  return { changed: false, ...(await run(h.path, args, ms)) };
}

/**
 * Whether this Mac can show the authentication dialog. Never shows one.
 * @returns {Promise<boolean>}
 */
export async function available() {
  try {
    if (config.platform !== "darwin" || !fs.existsSync(config.swiftc)) return false;
    const r = await runHelper(["--check"], 10_000);
    return !r.changed && r.code === 0;
  } catch {
    return false;
  }
}

/**
 * Show the macOS authentication dialog with `reason`, and wait for the person. Under tests (or
 * VYRE_NO_DIALOGS=1) the helper never runs: the answer is { ok: false, reason: "no_dialog" }.
 * A test that drives a stub helper passes its own `env` to build().
 * @param {string} reason
 * @param {{ timeout?: number }} [opts] seconds
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function authenticate(reason, { timeout = 60 } = {}) {
  try {
    if (!dialogsAllowed(config.env || process.env)) return { ok: false, reason: NO_DIALOG };
    if (config.platform !== "darwin") return { ok: false, reason: "unavailable" };
    const text = String(reason || "");
    const r = await runHelper([text === "--check" ? " --check" : text, String(timeout)], (timeout + 2) * 1000);
    if (r.changed) return { ok: false, reason: "helper changed" };
    if (r.killed) return { ok: false, reason: "timeout" };
    if (r.code === 0) return { ok: true };
    if (r.code === 1) return { ok: false, reason: "denied" };
    if (r.code === 2) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "error" };
  } catch (e) {
    return { ok: false, reason: "unavailable: " + /** @type {Error} */ (e).message };
  }
}

/**
 * Another Swift helper under the same rules: built privately on first use, hash-checked before
 * every run, rebuilt if the binary changed. For modules that need their own (the vault's unlock).
 * Only `--check` runs while dialogs are off (core/config/dialogs.js); anything else is refused.
 * @param {string} source absolute path of the .swift file
 * @param {Omit<BuildOptions, "source">} [opts]
 * @returns {{ run(args: string[], ms: number): Promise<{ changed: boolean, code: number | null, killed: boolean, stdout: string }> }}
 */
export function swiftHelper(source, { dir, swiftc = SWIFTC, platform = process.platform, env } = {}) {
  const c = { dir, swiftc, platform, source };
  /** @type {Promise<Helper> | null} */
  let built = null;
  const ready = () => {
    if (!built) { built = compile(c); built.catch(() => { built = null; }); }
    return built;
  };
  return {
    async run(args, ms) {
      if (args[0] !== "--check" && !dialogsAllowed(env || process.env)) throw Object.assign(new Error("dialogs are off under tests"), { code: NO_DIALOG });
      const h = await ready();
      let now = "";
      try { now = sha256(fs.readFileSync(h.path)); } catch {}
      if (now !== h.hash) { built = null; return { changed: true, code: null, killed: false, stdout: "" }; }
      return { changed: false, ...(await run(h.path, args, ms)) };
    },
  };
}
