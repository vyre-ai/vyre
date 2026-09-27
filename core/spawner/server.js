// @ts-check
// The spawner: the one piece of the box that runs as root (ADR 0032 part 3).
//
// vyred runs as uid `vyre` and cannot change uid. A Vyre-owned Claude session must not run as
// `vyre`, or the model's shell could open vyred's socket, read the vault's files and act as the
// person. So vyred asks this server, over a socket only uid `vyre` can open, to start one session
// child as uid `vyre-agent`, and it hands the child's stdio back as plain connections.
//
// It starts nothing but an allowed program (the claude binary, under tini as a subreaper), in a
// cwd under /work, with an environment cut down to known keys. The container gives it no
// capability but SETUID, SETGID and KILL.
//
// Protocol, one JSON line to open each connection:
//   {"op":"spawn","argv":[...],"env":{...},"cwd":"/work/...","fd3":"..."}  -> {"id","pid"} then later {"exit":code,"signal":s}
//                                                                 fd3: written once to the child's fd 3 and closed
//                                                                 (an API key: Claude Code reads it there, its tools never see it)
//                                                                 the client may send {"kill":"SIGTERM"}
//   {"op":"io","id":"...","stream":"stdio"|"stderr"}            -> raw bytes: stdin in, stdout out; or stderr out
// The child starts once both io connections are attached; a spawn nobody attaches to in 10 s ends.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

/** Environment keys a session child may get. Anything else (LD_PRELOAD, NODE_OPTIONS ...) is dropped. */
const ENV_KEYS = /^(HOME|PATH|LANG|LC_[A-Z]+|TERM|TZ|USER|SHELL|TMPDIR|NO_COLOR|FORCE_COLOR|VYRE_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|DISABLE_[A-Z0-9_]+|MCP_[A-Z0-9_]+)$/;
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);
const ATTACH_MS = 10_000;
const MAX_LIVE = 16;

/**
 * @param {{ socket: string, mode?: number, allow: string[], agent: { uid: number, gid: number, groups: number[] },
 *   work?: string, home?: string, wrap?: (argv: string[], cwd: string) => string[], makeDir?: (dir: string) => void, log?: (m: string) => void }} o
 *   allow: programs argv[0] may name (absolute paths). wrap: how the child is started as the agent;
 *   the default is setpriv plus umask 002 plus tini as a subreaper. A test passes identity.
 */
export async function serve(o) {
  const log = o.log || (() => {});
  const work = path.resolve(o.work || "/work");
  // The default changes directory as the agent, after setpriv: root here has no right to enter the
  // agent's home (no DAC capabilities), so the spawn itself starts in /.
  const custom = Boolean(o.wrap);
  const wrap = o.wrap || ((argv, cwd) => ["/usr/bin/setpriv", `--reuid=${o.agent.uid}`, `--regid=${o.agent.gid}`, `--groups=${o.agent.groups.join(",")}`,
    "--inh-caps=-all", "--", "/bin/sh", "-c", 'umask 002; cd "$1" || exit 126; shift; exec "$@"', "sh", cwd, "/usr/bin/tini", "-s", "--", ...argv]);
  // Programs by their real path, so a symlink (/bin/sh to dash) is the program it names.
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  const allowed = new Set(o.allow.map(real));
  /** @type {Map<string, { req: any, control: net.Socket, stdio?: net.Socket, stderr?: net.Socket, child?: import("node:child_process").ChildProcess, timer: NodeJS.Timeout }>} */
  const live = new Map();

  const line = sock => new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(10);
      if (i < 0) { if (buf.length > 256 * 1024) { sock.off("data", onData); reject(new Error("request too large")); } return; }
      sock.off("data", onData);
      sock.pause();
      const rest = buf.subarray(i + 1);
      if (rest.length) sock.unshift(rest);
      try { resolve(JSON.parse(buf.subarray(0, i).toString("utf8"))); } catch { reject(new Error("request is not JSON")); }
    };
    sock.on("data", onData);
    sock.once("error", reject);
  });

  /** Is this a spawn we will run? Returns why not, or null. */
  function refuse(req) {
    if (!Array.isArray(req.argv) || !req.argv.length || !req.argv.every(a => typeof a === "string" && !a.includes("\0"))) return "argv must be strings";
    if (!path.isAbsolute(req.argv[0]) || !allowed.has(real(req.argv[0]))) return `${req.argv[0]} is not a program the spawner starts`;
    if (req.fd3 !== undefined && (typeof req.fd3 !== "string" || req.fd3.length > 4096)) return "fd3 must be a short string";
    const cwd = path.resolve(String(req.cwd || work));
    const under = dir => dir && (cwd === dir || cwd.startsWith(dir + path.sep));
    // The work folder, or the agent's own home (an agent without a project works there).
    if (!under(work) && !under(o.home ? path.resolve(o.home) : null)) return `cwd must be under ${work}${o.home ? ` or ${o.home}` : ""}`;
    if (live.size >= MAX_LIVE) return "too many sessions are running";
    return null;
  }

  function start(id) {
    const s = live.get(id);
    if (!s || !s.stdio || !s.stderr || s.child) return;
    clearTimeout(s.timer);
    const env = {};
    for (const [k, v] of Object.entries(s.req.env || {})) if (ENV_KEYS.test(k) && typeof v === "string" && !v.includes("\0")) env[k] = v;
    if (o.home) { env.HOME = o.home; env.USER = "vyre-agent"; }
    const cwd = path.resolve(String(s.req.cwd || work));
    const argv = wrap(s.req.argv, cwd);
    // A folder in the agent's home is made as the agent, which owns that home (mkdir -p: root
    // here cannot even look inside it).
    if (o.home && cwd.startsWith(path.resolve(o.home) + path.sep) && o.makeDir) {
      try { o.makeDir(cwd); } catch (e) { log(`spawner: cannot make ${cwd}: ${/** @type {Error} */ (e).message}`); }
    }
    const fd3 = typeof s.req.fd3 === "string";
    const child = spawn(argv[0], argv.slice(1), { cwd: custom ? cwd : "/", env, stdio: fd3 ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"], detached: true });
    if (fd3 && child.stdio[3]) { const p3 = /** @type {any} */ (child.stdio[3]); p3.on("error", () => {}); p3.end(s.req.fd3); }
    s.child = child;
    child.on("error", e => { try { s.control.end(JSON.stringify({ error: e.message }) + "\n"); } catch {} });
    s.stdio.pipe(/** @type {any} */ (child.stdin)).on("error", () => {});
    /** @type {any} */ (child.stdout).pipe(s.stdio).on("error", () => {});
    /** @type {any} */ (child.stderr).pipe(s.stderr).on("error", () => {});
    s.stdio.resume(); s.stderr.resume();
    s.control.write(JSON.stringify({ id, pid: child.pid }) + "\n");
    log(`spawner: started ${path.basename(s.req.argv[0])} as pid ${child.pid}`);
    // Once the child and its pipes are done: the exit on the control line, then every connection
    // closes, whether or not the client ever ended stdin.
    child.on("close", (code, signal) => {
      try { s.control.end(JSON.stringify({ exit: code, signal }) + "\n"); } catch {}
      for (const c of [s.stdio, s.stderr]) { try { c && c.end(); } catch {} setTimeout(() => { try { c && c.destroy(); } catch {} }, 1000).unref(); }
      setTimeout(() => { try { s.control.destroy(); } catch {} }, 1000).unref();
      live.delete(id);
    });
  }

  function end(id, why) {
    const s = live.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    live.delete(id);
    if (s.child && s.child.exitCode === null) { try { process.kill(-(/** @type {number} */ (s.child.pid)), "SIGKILL"); } catch {} }
    for (const c of [s.control, s.stdio, s.stderr]) try { c && c.destroy(); } catch {}
    if (why) log(`spawner: ended ${id}: ${why}`);
  }

  // Half-open: the client ending stdin must not end the child's stdout on the same connection.
  /** @type {Set<net.Socket>} */
  const conns = new Set();
  const server = net.createServer({ allowHalfOpen: true }, async sock => {
    conns.add(sock);
    sock.on("close", () => conns.delete(sock));
    sock.on("error", () => {});
    let req;
    try { req = await line(sock); } catch (e) { sock.end(JSON.stringify({ error: /** @type {Error} */ (e).message }) + "\n"); return; }
    if (req.op === "spawn") {
      const why = refuse(req);
      if (why) { sock.end(JSON.stringify({ error: why }) + "\n"); return; }
      const id = crypto.randomBytes(16).toString("hex");
      const timer = setTimeout(() => end(id, "nobody attached"), ATTACH_MS);
      live.set(id, { req, control: sock, timer });
      sock.write(JSON.stringify({ id }) + "\n");
      sock.resume();
      // Signals for the whole group: tini and the session under it, and what they started.
      let buf = "";
      sock.on("data", d => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(l); } catch { continue; }
          const s = live.get(id);
          if (m && SIGNALS.has(m.kill) && s && s.child && s.child.pid) { try { process.kill(-s.child.pid, m.kill); } catch {} }
        }
      });
      sock.on("close", () => { const s = live.get(id); if (s && !s.child) end(id, "closed"); });
      return;
    }
    if (req.op === "io") {
      const s = live.get(String(req.id || ""));
      if (!s || !["stdio", "stderr"].includes(req.stream) || s[req.stream]) { sock.destroy(); return; }
      s[req.stream] = sock;
      start(String(req.id));
      return;
    }
    sock.end(JSON.stringify({ error: "unknown op" }) + "\n");
  });

  // Only vyred may connect. In the image the folder is root:vyre, 2750: the socket takes the vyre
  // group from it, with no capability to chown, and vyre-agent cannot even enter the folder.
  fs.mkdirSync(path.dirname(o.socket), { recursive: true, mode: 0o700 });
  try { fs.rmSync(o.socket, { force: true }); } catch {}
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(o.socket, () => resolve(undefined)); });
  fs.chmodSync(o.socket, o.mode ?? 0o600);
  return {
    close: () => new Promise(r => { for (const id of [...live.keys()]) end(id, "stopping"); for (const c of conns) c.destroy(); server.close(() => r(undefined)); }),
    live: () => live.size,
  };
}
