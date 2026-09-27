// @ts-check
// dtach: a terminal that outlives vyred (ADR 0029, R4).
//
// The shell runs under a `dtach -N` master: dtach holds the pty and a unix socket, and vyred is only
// a client of that socket. When vyred stops or restarts, the master and the shell carry on, and the
// next vyred connects to the same socket again. vyred speaks dtach's socket protocol itself, so no
// `dtach -a` (which wants a real terminal on its stdin) and no `script` sit in between:
//
//   client to master: a 10-byte packet { type u8, len u8, 8 bytes }. MSG_PUSH (0) carries up to 8
//   bytes of keys, MSG_ATTACH (1) asks for the output, MSG_WINCH (3) carries a struct winsize
//   (rows, cols, xpixel, ypixel as native u16) and MSG_REDRAW (4, len = method) a winsize and a
//   redraw.
//   master to client: the raw bytes the pty prints, to every attached client.
//
// The master discards output while no client is attached (vyred down), and waits for a slow client
// before it reads the pty again, which holds the shell back just as a paused pipe does.
//
// `dtach` must be on the PATH (the box image has it), or VYRE_DTACH_BIN names it. An empty
// VYRE_DTACH_BIN turns durable terminals off. Without dtach, core/term falls back to pty.js.

import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { privateSocketDir } from "../config/index.js";
import { loginShell, size } from "./pty.js";

const MSG_PUSH = 0, MSG_ATTACH = 1, MSG_WINCH = 3, MSG_REDRAW = 4;
const REDRAW_WINCH = 3;
const LE = os.endianness() === "LE";

/** @param {string} cmd @param {string[]} args @returns {Promise<string>} */
function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

/** The dtach binary to use, or "" when there is none. */
export function findDtach(env = process.env) {
  if (env.VYRE_DTACH_BIN !== undefined) {
    const bin = String(env.VYRE_DTACH_BIN);
    if (!bin) return "";
    try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch { return ""; }
  }
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const bin = path.join(dir, "dtach");
    try { if (fs.statSync(bin).isFile()) { fs.accessSync(bin, fs.constants.X_OK); return bin; } } catch {}
  }
  return "";
}

/**
 * The folder terminal sockets live in: <home>/run/term, or, when that is too long for a unix socket
 * path, a folder named by a hash of the home inside the private per-user /tmp folder.
 * @param {string} root vyred's home
 */
export function socketDir(root) {
  const near = path.join(root, "run", "term");
  // "t_" + 12 hex + ".sock" is 19 bytes; a unix socket path must stay under about 104.
  if (Buffer.byteLength(near) + 20 <= 100) { fs.mkdirSync(near, { recursive: true, mode: 0o700 }); return near; }
  const hash = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  const dir = path.join(privateSocketDir(), `term-${hash}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** One dtach packet. */
function packet(type, len = 0, body) {
  const b = Buffer.alloc(10);
  b[0] = type; b[1] = len;
  if (body) body.copy(b, 2, 0, Math.min(8, body.length));
  return b;
}

/** struct winsize { rows, cols, xpixel, ypixel }, native unsigned shorts. */
function winsize(cols, rows) {
  const b = Buffer.alloc(8);
  if (LE) { b.writeUInt16LE(rows, 0); b.writeUInt16LE(cols, 2); } else { b.writeUInt16BE(rows, 0); b.writeUInt16BE(cols, 2); }
  return b;
}

/** Whether pid is still the dtach master for sock (a pid can be reused). */
export async function isMaster(pid, sock) {
  if (!pid) return false;
  const args = (await run("ps", ["-o", "args=", "-p", String(pid)])).trim();
  return args.includes(` ${sock} `) || args.endsWith(` ${sock}`);
}

export class DtachPty {
  /**
   * Start a new master (`sock` must not exist yet) or, with adopt, connect to a live one.
   * @param {{ bin?: string, sock: string, cwd?: string, cols?: number, rows?: number, shell?: string, login?: boolean,
   *           env?: NodeJS.ProcessEnv, adopt?: { pid: number }, onData?: (b: Buffer) => void, onExit?: (code: number|null) => void }} o
   */
  constructor(o) {
    this.durable = true;
    this.sock = o.sock;
    const { cols, rows } = size(o.cols, o.rows);
    this.cols = cols; this.rows = rows;
    this.onData = o.onData || (() => {});
    this.onExit = o.onExit || (() => {});
    this.exited = false;
    this.detached = false;
    /** @type {net.Socket|null} */ this.conn = null;
    /** Keys typed before the socket is up. */
    /** @type {Buffer[]} */ this.pending = [];
    /** The master's pid; the shell is its child and leads its own session. */
    this.pid = o.adopt ? Number(o.adopt.pid) || 0 : 0;
    /** @type {number|null} */ this.leader = null;
    if (!o.adopt) {
      const shell = o.shell || loginShell(o.env);
      const env = { ...(o.env || process.env), SHELL: shell, TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: String(cols), LINES: String(rows) };
      const cmd = o.login !== false ? [shell, "-l"] : [shell];
      // The master throws away what the shell prints before a client attaches, so the shell waits
      // for vyred to attach (the go file) before it starts, and its first prompt is not lost. Ten
      // seconds at most, then it starts anyway.
      const wait = `i=0; while [ ! -e "$1" ] && [ $i -lt 500 ]; do sleep 0.02; i=$((i+1)); done; rm -f "$1"; shift; exec "$@"`;
      // -N: the master stays in the foreground as our child, so its pid is known. It calls setsid
      // itself and outlives vyred. -E and -z: no detach or suspend key; -r winch redraws on request.
      const argv = ["-N", this.sock, "-E", "-z", "-r", "winch", "/bin/sh", "-c", wait, "vyre-term", this.sock + ".go", ...cmd];
      const child = spawn(String(o.bin), argv, { cwd: o.cwd, env, detached: true, stdio: "ignore" });
      child.on("error", () => this.finish(null));
      child.unref();
      this.pid = child.pid || 0;
    }
    this.ready = this.connect(Boolean(o.adopt));
  }

  /** Connect to the master's socket (it takes a moment to appear after a start), then attach. */
  async connect(adopted) {
    let conn = null;
    for (let i = 0; i < 60 && !this.exited && !this.detached; i++) {
      conn = await new Promise(resolve => {
        const c = net.connect(this.sock);
        c.once("connect", () => resolve(c));
        c.once("error", () => resolve(null));
      });
      if (conn || adopted) break;
      await new Promise(r => setTimeout(r, 50));
    }
    if (!conn) { this.finish(null); return; }
    if (this.exited || this.detached) { conn.destroy(); return; }
    this.conn = conn;
    conn.on("data", b => this.onData(b));
    conn.on("error", () => {});
    conn.on("close", () => { this.conn = null; if (!this.detached) this.finish(null); });
    conn.write(packet(MSG_ATTACH));
    // A new shell gets its size; an adopted one also a SIGWINCH so a full-screen program repaints.
    conn.write(adopted ? packet(MSG_REDRAW, REDRAW_WINCH, winsize(this.cols, this.rows)) : packet(MSG_WINCH, 0, winsize(this.cols, this.rows)));
    // Attached: the shell may start now.
    if (!adopted) { try { fs.writeFileSync(this.sock + ".go", "", { mode: 0o600 }); } catch {} }
    const keys = this.pending; this.pending = [];
    for (const b of keys) this.write(b);
    this.leader = Number((await run("pgrep", ["-P", String(this.pid)])).trim().split(/\s+/)[0]) || null;
  }

  finish(code) {
    if (this.exited) return;
    this.exited = true;
    this.onExit(code);
  }

  /** @param {Buffer|string} data */
  write(data) {
    if (this.exited || this.detached) return;
    const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    if (!this.conn) { if (this.pending.reduce((n, x) => n + x.length, 0) + b.length <= 64 * 1024) this.pending.push(b); return; }
    if (this.conn.destroyed) return;
    const out = [];
    for (let i = 0; i < b.length; i += 8) { const part = b.subarray(i, i + 8); out.push(packet(MSG_PUSH, part.length, part)); }
    try { this.conn.write(Buffer.concat(out)); } catch {}
  }

  resize(cols, rows) {
    const s = size(cols, rows);
    this.cols = s.cols; this.rows = s.rows;
    if (this.conn && !this.conn.destroyed) { try { this.conn.write(packet(MSG_WINCH, 0, winsize(s.cols, s.rows))); } catch {} }
    return Promise.resolve();
  }

  pause() { this.conn?.pause(); }
  resume() { this.conn?.resume(); }

  /** Let go of the master and leave the shell running, for the next vyred to pick up. */
  detach() {
    this.detached = true;
    try { this.conn?.destroy(); } catch {}
    this.conn = null;
  }

  /** End the shell's whole session and the master: a hang-up first, then a kill a second later. */
  async close() {
    await this.ready.catch(() => {});
    const sid = this.leader;
    const master = this.pid && await isMaster(this.pid, this.sock) ? this.pid : 0;
    const hit = sig => {
      if (sid) { try { process.kill(-sid, sig); } catch {} }
      if (master) { try { process.kill(master, sig); } catch {} }
    };
    hit("SIGHUP");
    if (sid) await run("pkill", ["-HUP", "-s", String(sid)]);
    await new Promise(r => setTimeout(r, this.exited ? 200 : 1000));
    hit("SIGKILL");
    if (sid) await run("pkill", ["-KILL", "-s", String(sid)]);
    try { this.conn?.destroy(); } catch {}
    try { fs.unlinkSync(this.sock); } catch {}
    try { fs.unlinkSync(this.sock + ".go"); } catch {}
  }
}
