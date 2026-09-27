// @ts-check
// pty: a pseudo-terminal without a native dependency (ADR 0024, contract 4).
//
// `script` already knows how to put a program on a pty and copy its bytes to and from pipes, so a
// terminal here is one `script` child: util-linux on the box (`script -qfec "<shell> -l"
// /dev/null`), BSD on a Mac (`script -q /dev/null <shell> -l`). What `script` cannot do is change
// the window size, so a resize finds the pty the shell sits on (`ps -o tty=` of script's child,
// the session leader) and sets it with stty; the kernel then tells the foreground job, and a
// SIGWINCH to that group (`ps -o tpgid=`) makes sure. `script` runs in a process group of its
// own (detached) and the shell in a session of its own, so close() ends both, jobs included.
//
// Nothing here logs or stores what a terminal prints: output goes to whoever listens (onData)
// and to a small ring the module replays when a browser reattaches.

import { spawn, execFile } from "node:child_process";
import os from "node:os";

/** @param {string} cmd @param {string[]} args @returns {Promise<string>} */
function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const clamp = (n, lo, hi, dflt) => Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Math.floor(Number(n)))) : dflt;
export const size = (cols, rows) => ({ cols: clamp(cols, 2, 500, 80), rows: clamp(rows, 2, 200, 24) });

/** The user's login shell. */
export function loginShell(env = process.env) {
  let fromUser = "";
  try { fromUser = os.userInfo().shell || ""; } catch {}
  return env.SHELL || fromUser || "/bin/sh";
}

/** The argv that puts `shell -l` on a pty on this platform. */
export function scriptArgs(shell, platform = process.platform, login = true) {
  const cmd = login ? [shell, "-l"] : [shell];
  if (platform === "linux") return ["-qfec", cmd.map(quote).join(" "), "/dev/null"];
  return ["-q", "/dev/null", ...cmd];
}

export class Pty {
  /**
   * @param {{ cwd: string, cols?: number, rows?: number, shell?: string, login?: boolean, env?: NodeJS.ProcessEnv,
   *           platform?: string, onData?: (b: Buffer) => void, onExit?: (code: number|null) => void }} o
   */
  constructor(o) {
    this.platform = o.platform || process.platform;
    const shell = o.shell || loginShell(o.env);
    const { cols, rows } = size(o.cols, o.rows);
    this.cols = cols; this.rows = rows;
    this.onData = o.onData || (() => {});
    this.onExit = o.onExit || (() => {});
    /** The shell's session leader (script's child), found after start; its pid is the session id. */
    /** @type {number|null} */ this.leader = null;
    /** @type {string|null} */ this.tty = null;
    this.exited = false;
    const env = { ...(o.env || process.env), SHELL: shell, TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: String(cols), LINES: String(rows) };
    this.child = spawn("script", scriptArgs(shell, this.platform, o.login !== false), { cwd: o.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.pid = this.child.pid || 0;
    this.child.stdout?.on("data", b => this.onData(b));
    // script's own complaints go nowhere a person reads them; the shell's stderr is on the pty.
    this.child.stderr?.on("data", () => {});
    this.child.stdin?.on("error", () => {});
    this.child.on("error", () => this.finish(null));
    this.child.on("exit", code => this.finish(code));
    /** @type {Promise<void>|null} */ this.resizing = null;
    /** @type {{ cols: number, rows: number }|null} */ this.pendingSize = null;
    this.ready = this.find().then(() => this.apply()).catch(() => {});
  }

  finish(code) {
    if (this.exited) return;
    this.exited = true;
    this.onExit(code);
  }

  /** Wait for script's child, the shell's session leader, and learn its tty. Up to about 3 s. */
  async find() {
    for (let i = 0; i < 60 && !this.exited; i++) {
      const kid = Number((await run("pgrep", ["-P", String(this.pid)])).trim().split(/\s+/)[0]);
      if (kid) {
        const tty = (await run("ps", ["-o", "tty=", "-p", String(kid)])).trim();
        if (tty && tty !== "?" && tty !== "??") { this.leader = kid; this.tty = "/dev/" + tty; return; }
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }

  /** @param {Buffer|string} data */
  write(data) {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return;
    try { this.child.stdin.write(data); } catch {}
  }

  /** Set the window size. Resizes arrive in bursts (a window being dragged); only the last one waits. */
  resize(cols, rows) {
    const s = size(cols, rows);
    this.cols = s.cols; this.rows = s.rows;
    this.pendingSize = s;
    if (!this.resizing) this.resizing = this.ready.then(() => this.apply()).finally(() => { this.resizing = null; if (this.pendingSize) this.resize(this.pendingSize.cols, this.pendingSize.rows); });
    return this.resizing;
  }

  async apply() {
    const s = this.pendingSize || { cols: this.cols, rows: this.rows };
    this.pendingSize = null;
    if (!this.tty || this.exited) return;
    const flag = this.platform === "linux" ? "-F" : "-f";
    await run("stty", [flag, this.tty, "cols", String(s.cols), "rows", String(s.rows)]);
    const fg = Number((await run("ps", ["-o", "tpgid=", "-p", String(this.leader)])).trim());
    if (fg > 0) { try { process.kill(-fg, "SIGWINCH"); } catch {} }
  }

  /** End the shell's whole session and script's group: a hang-up first, then a kill a second later. */
  async close() {
    const sid = this.leader;
    const hit = sig => {
      if (sid) { try { process.kill(-sid, sig); } catch {} }
      if (this.pid) { try { process.kill(-this.pid, sig); } catch {} }
    };
    hit("SIGHUP");
    if (sid) await run("pkill", ["-HUP", "-s", String(sid)]);
    await new Promise(r => setTimeout(r, this.exited ? 200 : 1000));
    hit("SIGKILL");
    if (sid) await run("pkill", ["-KILL", "-s", String(sid)]);
    try { this.child.stdin?.destroy(); } catch {}
  }
}
