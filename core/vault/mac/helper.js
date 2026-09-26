// @ts-check
// helper: the small Swift programs the vault runs on a Mac (the clipboard, the lock watcher and
// native fill). vyred builds each one with swiftc on first use into a private folder in the Vyre
// home, records the binary's hash, and checks that hash before every run: anything running as
// this user could swap the file for one that keeps a copy of what it is handed on stdin.
//
// Values only ever reach a helper on stdin, never in its arguments, which `ps` shows to everyone.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkDialog } from "./dialogs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SWIFTC = "/usr/bin/swiftc";

const sha256 = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/** Make (or check) a private build folder. Throws if it is not safely ours. */
export function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (uid() >= 0 && st.uid !== uid()) || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a private folder owned by this user; refusing to build a vault helper there`);
  }
  return dir;
}

/**
 * @typedef {{ name: "clip"|"watch"|"type"|"enclave"|"keychain", dir: string, swiftc?: string, platform?: string, command?: string[] }} HelperOptions
 * `command` replaces the built binary with a fixed command (tests use a fake written in Node);
 * it skips building and hashing, and nothing outside tests sets it.
 */

export class Helper {
  /** @param {HelperOptions} o */
  constructor({ name, dir, swiftc = SWIFTC, platform = process.platform, command }) {
    this.name = name;
    this.source = path.join(HERE, `${name}.swift`);
    this.dir = dir;
    this.swiftc = swiftc;
    this.platform = platform;
    this.command = command || null;
    /** @type {Promise<{ path: string, hash: string }> | null} */
    this.built = null;
  }

  /** Whether this helper can run here at all: a Mac with swiftc, or a test's fake. */
  usable() {
    if (this.command) return true;
    return this.platform === "darwin" && fs.existsSync(this.swiftc);
  }

  /** The binary, built once per process. A failed build is tried again on the next call. */
  ensure() {
    if (!this.built) {
      this.built = this.compile();
      this.built.catch(() => { this.built = null; });
    }
    return this.built;
  }

  async compile() {
    if (this.platform !== "darwin") throw new Error("vault helpers need macOS");
    if (!fs.existsSync(this.swiftc)) throw new Error(`${this.swiftc} not found`);
    const dir = privateDir(this.dir);
    const source = fs.readFileSync(this.source);
    const target = path.join(dir, `vyre-vault-${this.name}-${sha256(source).slice(0, 16)}`);
    if (!fs.existsSync(target)) {
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
      const code = await new Promise(resolve => {
        const c = execFile(this.swiftc, ["-O", "-o", tmp, this.source], { timeout: 300_000, killSignal: "SIGKILL", maxBuffer: 1 << 20 },
          err => resolve(err ? (typeof /** @type {any} */ (err).code === "number" ? /** @type {any} */ (err).code : -1) : 0));
        c.stdin?.end();
      });
      if (code !== 0) { fs.rmSync(tmp, { force: true }); throw new Error(`swiftc could not build the ${this.name} helper (${code})`); }
      fs.renameSync(tmp, target);
    }
    const st = fs.lstatSync(target);
    if (!st.isFile() || (uid() >= 0 && st.uid !== uid()) || (st.mode & 0o022) !== 0) {
      throw new Error(`${target} is not a private file owned by this user`);
    }
    return { path: target, hash: sha256(fs.readFileSync(target)) };
  }

  /**
   * Start the helper with its stdin, stdout and stderr as pipes, after checking it is the binary
   * that was built. A changed binary is thrown away and built again before it runs.
   * @param {string[]} [args] never a value
   * @param {{ env?: NodeJS.ProcessEnv, request?: any }} [o] request: what will be sent on stdin,
   *   so the dialog check can tell a harmless op from one that asks a person
   * @returns {Promise<import("node:child_process").ChildProcessWithoutNullStreams>}
   */
  async spawn(args = [], { env, request } = {}) {
    if (this.command) return spawn(this.command[0], [...this.command.slice(1), ...args], { stdio: "pipe", env: env || process.env });
    // A real helper that can raise a system dialog does not start when dialogs are off (dialogs.js).
    checkDialog(this.name, request);
    let h = await this.ensure();
    let now = "";
    try { now = sha256(fs.readFileSync(h.path)); } catch { /* missing counts as changed */ }
    if (now !== h.hash) {
      try { fs.rmSync(h.path, { force: true }); } catch { /* rebuilt below either way */ }
      this.built = null;
      h = await this.ensure();
    }
    return spawn(h.path, args, { stdio: "pipe", env: env || process.env });
  }
}

/**
 * JSON lines from a child's stdout, one callback per parsed line. Lines that are not JSON are
 * dropped: a helper's reply is data, and a stray line must not become an error message.
 * @param {import("node:stream").Readable} stream @param {(msg: any) => void} onLine
 */
export function lines(stream, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    buf += chunk;
    if (buf.length > 1 << 20) buf = "";
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onLine(msg);
    }
  });
}
