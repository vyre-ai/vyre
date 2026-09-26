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
 *   close(): Promise<void>, target: string }} Remote
 */

/**
 * A server reached as `user@host`.
 * @param {string} target
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Remote}
 */
export function remote(target, { env = process.env } = {}) {
  const bin = env.VYRE_SSH_BIN || "ssh";
  const dir = fs.mkdtempSync(path.join("/tmp", "vyre-ssh-"));
  fs.chmodSync(dir, 0o700);
  // Every call names the control socket, so it rides on the master when there is one. Only
  // open() may become the master; a later call never forks a second one behind our back.
  const ctl = ["-o", `ControlPath=${dir}/%C`];

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
    const args = ["-o", "ControlMaster=auto", ...ctl, "-o", "ControlPersist=600", ...(interactive ? [] : ["-o", "BatchMode=yes"]), target, "true"];
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

    run(cmd, { tty = false, input } = {}) {
      return ssh([...ctl, ...(tty ? ["-t"] : []), target, cmd], { tty, input });
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
      if (!(await portFree(localPort))) {
        const who = await holder(localPort);
        throw new Error(`port ${localPort} on this computer is taken${who ? ` by ${who}` : ""}; stop that and run this again`);
      }
      // The forward is added to the held master (-O forward), not a second connection, so a
      // password is never asked for again; -O cancel takes it away.
      const spec = `${localPort}:127.0.0.1:${remotePort}`;
      const r = await ssh([...ctl, "-o", "ExitOnForwardFailure=yes", "-O", "forward", "-L", spec, target]);
      if (r.code !== 0) throw new Error(firstLine(r.stderr) || `could not forward port ${localPort}`);
      return { close: async () => { await ssh([...ctl, "-O", "cancel", "-L", spec, target]); } };
    },

    spawn(cmd, stdio) {
      return spawn(bin, [...ctl, target, cmd], { env, stdio });
    },

    async close() {
      await ssh([...ctl, "-O", "exit", target]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
