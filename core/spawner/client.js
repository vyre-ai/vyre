// @ts-check
// vyred's side of the spawner (server.js): start one session child as uid `vyre-agent` and get
// back something that looks like a ChildProcess to the session driver: pid, stdin, stdout,
// stderr, kill(), and the "exit" and "error" events. The sessions driver passes it to the Agent
// SDK as its spawnClaudeCodeProcess on the box (ADR 0030, ADR 0032 part 3).

import fs from "node:fs";
import net from "node:net";
import { EventEmitter } from "node:events";

/** Where the spawner listens on the box. */
export const SOCKET = process.env.VYRE_SPAWNER_SOCKET || "/run/vyre/spawner.sock";

/** Is there a spawner to ask? On a Mac, or a box without the split, sessions spawn directly. */
export const available = (socket = SOCKET) => { try { return fs.statSync(socket).isSocket(); } catch { return false; } };

const connect = socket => new Promise((resolve, reject) => {
  // Half-open: ending stdin must not end stdout, which shares the connection.
  const c = net.createConnection({ path: socket, allowHalfOpen: true }, () => { c.off("error", reject); resolve(c); });
  c.once("error", reject);
});

/**
 * Start argv as the agent. Resolves once the child runs, with its handle.
 * @param {string[]} argv @param {{ env?: Record<string, string|undefined>, cwd?: string, fd3?: string, socket?: string }} [o]
 *   fd3: written once to the child's fd 3 (an API key, CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=3)
 */
export async function spawnAsAgent(argv, { env = {}, cwd, fd3, socket = SOCKET } = {}) {
  const control = /** @type {net.Socket} */ (await connect(socket));
  const lines = [];
  /** @type {((l: any) => void) | null} */
  let waiting = null;
  let buf = "";
  const proc = /** @type {any} */ (new EventEmitter());
  proc.exitCode = null; proc.signalCode = null; proc.killed = false; proc.pid = undefined;
  control.setEncoding("utf8");
  control.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch { m = null; }
      buf = buf.slice(i + 1);
      if (!m) continue;
      if ("exit" in m) { proc.exitCode = m.exit; proc.signalCode = m.signal || null; proc.emit("exit", m.exit, m.signal || null); proc.emit("close", m.exit, m.signal || null); continue; }
      if (waiting) { const w = waiting; waiting = null; w(m); } else lines.push(m);
    }
  });
  const next = () => new Promise(r => { if (lines.length) r(lines.shift()); else waiting = r; });
  control.on("error", e => proc.emit("error", e));

  control.write(JSON.stringify({ op: "spawn", argv, env, cwd, ...(typeof fd3 === "string" ? { fd3 } : {}) }) + "\n");
  const first = await next();
  if (first.error || !first.id) { control.destroy(); throw new Error(`spawner: ${first.error || "no answer"}`); }
  const stdio = /** @type {net.Socket} */ (await connect(socket));
  stdio.write(JSON.stringify({ op: "io", id: first.id, stream: "stdio" }) + "\n");
  const stderr = /** @type {net.Socket} */ (await connect(socket));
  stderr.write(JSON.stringify({ op: "io", id: first.id, stream: "stderr" }) + "\n");
  const started = await next();
  if (started.error || !started.pid) { for (const c of [control, stdio, stderr]) c.destroy(); throw new Error(`spawner: ${started.error || "the child did not start"}`); }
  proc.pid = started.pid;
  proc.stdin = stdio;
  proc.stdout = stdio;
  proc.stderr = stderr;
  proc.kill = (sig = "SIGTERM") => { proc.killed = true; try { control.write(JSON.stringify({ kill: String(sig) }) + "\n"); return true; } catch { return false; } };
  return proc;
}
