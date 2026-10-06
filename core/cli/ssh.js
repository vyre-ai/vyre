// @ts-check
// ssh: the Mac's reach into a server, over the system `ssh` binary (ADR 0008 section 2).
//
// `vyre box` does every server chore through this, so the person never opens a shell there. One
// master connection is opened first and held (ControlMaster), and every later call rides on it:
// a server without a key set up asks for its password once, not once per step. The control
// socket lives in a fresh 0700 folder under /tmp, because a socket path is limited to about 104
// bytes and a home folder path can eat most of that. VYRE_SSH_BIN points tests at a fake.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFile } from "node:child_process";

/**
 * Quote one word for a POSIX shell on the other side. Plain words stay as they are, so the
 * commands in logs read naturally; anything else goes in single quotes.
 * @param {string} s
 */
export function quote(s) {
  s = String(s);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/** Quote each word and join them into one command line. */
export const line = (...words) => words.map(quote).join(" ");

const firstLine = s => String(s || "").trim().split("\n")[0] || "";

/** Is this local port free to listen on? */
export function portFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/** What holds a local port, as "name (pid n)", or null when lsof cannot say. */
function holder(port) {
  return new Promise(resolve => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcp"], { timeout: 3000 }, (e, out) => {
      const pid = /^p(\d+)/m.exec(String(out || "")), cmd = /^c(.+)$/m.exec(String(out || ""));
      resolve(pid && cmd ? `${cmd[1]} (pid ${pid[1]})` : null);
    });
  });
}

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} Result
 * @typedef {{ open(): Promise<{ ok: boolean, why: string|null }>,
 *   run(cmd: string, opts?: { tty?: boolean, input?: string|Buffer }): Promise<Result>,
 *   json(cmd: string): Promise<any>,
 *   put(localFile: string, remotePath: string): Promise<Result>,
 *   tunnel(localPort: number, remotePort: number): Promise<{ close(): Promise<void> }>,
 *   spawn(cmd: string, stdio: any[]): import("node:child_process").ChildProcess,
 *   reopen(): Promise<{ ok: boolean, why: string|null }>,
 *   close(): Promise<void>, target: string }} Remote
 */

/**
 * Is this a `user@host` we will hand to ssh? A word starting with "-" would be read as an option
 * (`-oProxyCommand=...` runs a command on this Mac), so neither half may start with one.
 * @param {unknown} target
 */
export function validTarget(target) {
  const m = /^([^@\s'"]+)@([^@\s'"]+)$/.exec(String(target || ""));
  return Boolean(m && !m[1].startsWith("-") && !m[2].startsWith("-"));
}

/** Control folders not yet closed. A run that exits without close() (an error, process.exit) still removes them. */
const unclosed = new Set();
process.on("exit", () => { for (const d of unclosed) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

/**
 * A server reached as `user@host`.
 * @param {string} target
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Remote}
 */
export function remote(target, { env = process.env } = {}) {
  if (!validTarget(target)) throw new Error(`not a user@host: ${target}`);
  const bin = env.VYRE_SSH_BIN || "ssh";
  const dir = fs.mkdtempSync(path.join("/tmp", "vyre-ssh-"));
  fs.chmodSync(dir, 0o700);
  unclosed.add(dir);
  // Every call names the control socket, so it rides on the master when there is one. Only
  // open() may become the master; a later call never forks a second one behind our back.
  const ctl = ["-o", `ControlPath=${dir}/%C`];
  // After the master, nothing may stop to ask (BatchMode), and a dead link is noticed within a
  // minute rather than hanging a poll forever.
  const quiet = [...ctl, "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"];
  // `--` ends ssh's options, so the target is never read as one.
  const to = ["--", target];
  let closed = false;

  /** Run ssh with these arguments; resolves with its exit code and output. */
  function ssh(args, { tty = false, input } = /** @type {{ tty?: boolean, input?: string|Buffer }} */ ({})) {
    return new Promise(resolve => {
      const child = spawn(bin, args, { env, stdio: tty ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout?.on("data", c => { stdout += c; });
      child.stderr?.on("data", c => { stderr += c; });
      child.on("error", e => resolve({ code: 127, stdout, stderr: e.message }));
      child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
      if (child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    });
  }

  /**
   * Start the master. The master stays behind in the background holding its stdio, so its
   * output goes to a file rather than a pipe we would wait on forever.
   */
  function master(interactive) {
    const errFile = path.join(dir, "open.err");
    const fd = fs.openSync(errFile, "w", 0o600);
    const args = ["-o", "ControlMaster=auto", ...ctl, "-o", "ControlPersist=600", ...(interactive ? [] : ["-o", "BatchMode=yes"]), ...to, "true"];
    return new Promise(resolve => {
      const child = spawn(bin, args, { env, stdio: [interactive ? "inherit" : "ignore", "ignore", interactive ? "inherit" : fd] });
      child.on("error", e => { fs.closeSync(fd); resolve({ code: 127, why: e.message }); });
      child.on("exit", code => {
        fs.closeSync(fd);
        resolve({ code: code ?? 1, why: firstLine(fs.readFileSync(errFile, "utf8")) || null });
      });
    });
  }

  return {
    target,

    async open() {
      let r = await master(false);
      // 255 is ssh's own failure (no key, host unknown): with a person at the keyboard, try once
      // more interactively so they can answer the password or host-key question.
      if (r.code === 255 && process.stdin.isTTY) r = await master(true);
      if (r.code === 0) return { ok: true, why: null };
      return { ok: false, why: r.why || `ssh ${target} failed (exit ${r.code})` };
    },

    async reopen() {
      // A new login session, so a group just added (docker) applies to the calls after it.
      await ssh([...quiet, "-O", "exit", ...to]);
      return this.open();
    },

    run(cmd, { tty = false, input } = {}) {
      // With a terminal, sudo on the server may ask; ssh itself still rides the master.
      return ssh([...(tty ? [...ctl, "-o", "ServerAliveInterval=15", "-t"] : quiet), ...to, cmd], { tty, input });
    },

    async json(cmd) {
      const r = await this.run(cmd);
      if (r.code !== 0) throw new Error(firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`);
      try { return JSON.parse(r.stdout); }
      catch { throw new Error(`${cmd}: not JSON: ${firstLine(r.stdout)}`); }
    },

    put(localFile, remotePath) {
      // cat, not scp: one fewer program the server must have, and it rides the same master.
      return this.run(`cat > ${quote(remotePath)} && chmod 0700 ${quote(remotePath)}`, { input: fs.readFileSync(localFile) });
    },

    async tunnel(localPort, remotePort) {
      if (!Number.isInteger(localPort) || !Number.isInteger(remotePort) || localPort <= 0 || remotePort <= 0) {
        throw new Error(`the box gave no port to forward (${localPort}); run vyre up on it and try again`);
      }
      if (!(await portFree(localPort))) {
        const who = await holder(localPort);
        throw new Error(`port ${localPort} on this computer is taken${who ? ` by ${who}` : ""}; stop that and run this again`);
      }
      // The forward is added to the held master (-O forward), not a second connection, so a
      // password is never asked for again; -O cancel takes it away.
      const spec = `${localPort}:127.0.0.1:${remotePort}`;
      const r = await ssh([...quiet, "-o", "ExitOnForwardFailure=yes", "-O", "forward", "-L", spec, ...to]);
      if (r.code !== 0) throw new Error(firstLine(r.stderr) || `could not forward port ${localPort}`);
      return { close: async () => { await ssh([...quiet, "-O", "cancel", "-L", spec, ...to]); } };
    },

    spawn(cmd, stdio) {
      return spawn(bin, [...quiet, ...to, cmd], { env, stdio });
    },

    async close() {
      if (closed) return;
      closed = true;
      await ssh([...quiet, "-O", "exit", ...to]);
      fs.rmSync(dir, { recursive: true, force: true });
      unclosed.delete(dir);
    },
  };
}
