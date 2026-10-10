// @ts-check
// vyred's side of the spawner (server.js): start one session child as uid `vyre-agent` and get
// back something that looks like a ChildProcess to the session driver: pid, stdin, stdout,
// stderr, kill(), and the "exit" and "error" events. The sessions driver passes it to the Agent
// SDK as its spawnClaudeCodeProcess on the box (ADR 0030, ADR 0032 part 3).

import fs from "node:fs";
import crypto from "node:crypto";
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
 * @param {string[]} argv @param {{ env?: Record<string, string|undefined>, cwd?: string, fd3?: string, socket?: string, account?: number, shared?: boolean, seed?: Record<string, string>, role?: "watcher", ro?: string[] }} [o]
 *   fd3: written once to the child's fd 3 (an API key, CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=3)
 *   account: run as that account's own uid (the spawner checks its range and its private HOME)
 *   seed: files (relative path -> text) the spawner writes in the account's HOME as that uid, 0600, before it starts
 *   role "watcher" (the watcher wall): runs as a pool uid with no group and an empty environment; ro lists the absolute paths it may read
 *   shared: with account, also join the /work group (project work needs it; nothing else does)
 */
export async function spawnAsAgent(argv, { env = {}, cwd, fd3, socket = SOCKET, account, shared, seed, role, ro } = {}) {
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

  control.write(JSON.stringify({ op: "spawn", argv, ...(role === "watcher" ? { role, ...(ro ? { ro } : {}) } : {}), ...(role !== "watcher" || Object.keys(env).length ? { env } : {}), cwd, ...(typeof fd3 === "string" ? { fd3 } : {}), ...(account !== undefined ? { account, ...(shared ? { shared: true } : {}), ...(seed ? { seed } : {}) } : {}) }) + "\n");
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

/**
 * Empty one account's HOME (its sign-ins, its caches) so its uid can go to a new account holding
 * nothing of the last. The spawner refuses while a session of that account still runs.
 * @param {number} account @param {{ socket?: string }} [o]
 */
export async function wipeAccount(account, { socket = SOCKET } = {}) {
  const c = /** @type {net.Socket} */ (await connect(socket));
  const answer = new Promise((resolve, reject) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", d => { buf += d; });
    c.on("end", () => { try { resolve(JSON.parse(buf.split("\n")[0])); } catch { reject(new Error("spawner: no answer")); } });
    c.on("error", reject);
  });
  c.write(JSON.stringify({ op: "wipe", account }) + "\n");
  const r = /** @type {any} */ (await answer);
  if (r.error) throw new Error(`spawner: ${r.error}`);
  return true;
}

/** Start a watcher's runner behind the wall: argv[0] is node, ro the paths it reads, and nothing else reaches it. @param {string[]} argv @param {{ ro?: string[], cwd?: string, socket?: string }} [o] */
export const spawnAsWatcher = (argv, { ro, cwd, socket } = {}) => spawnAsAgent(argv, { role: "watcher", ro, cwd, ...(socket ? { socket } : {}) });

/**
 * Make one session transcript of an account group-readable for vyred (the spawner checks the path: a .jsonl under that account's own .claude/projects, no link).
 * @param {number} account @param {string} file @param {{ socket?: string }} [o]
 */
/**
 * Put one session transcript into an account's own HOME as that account (the spawner checks the path: a plain .jsonl at <HOME>/.claude/projects/<folder>/<session>.jsonl, no link; 0600; written whole).
 * @param {number} account @param {string} file @param {Buffer | Uint8Array} bytes @param {{ socket?: string }} [o]
 */
export async function placeTranscript(account, file, bytes, { socket = SOCKET } = {}) {
  const buf = Buffer.from(bytes);
  const c = /** @type {net.Socket} */ (await connect(socket));
  const answer = new Promise((resolve, reject) => {
    let out = "";
    c.setEncoding("utf8");
    c.on("data", d => { out += d; });
    c.on("end", () => { try { resolve(JSON.parse(out.split("\n")[0])); } catch { reject(new Error("spawner: no answer")); } });
    c.on("error", reject);
  });
  c.write(JSON.stringify({ op: "place", account, path: file, size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") }) + "\n");
  c.write(buf);
  const r = /** @type {any} */ (await answer);
  if (r.error) throw new Error(`spawner: ${r.error}`);
  return true;
}

export async function shareTranscript(account, file, { socket = SOCKET } = {}) {
  const c = /** @type {net.Socket} */ (await connect(socket));
  const answer = new Promise((resolve, reject) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", d => { buf += d; });
    c.on("end", () => { try { resolve(JSON.parse(buf.split("\n")[0])); } catch { reject(new Error("spawner: no answer")); } });
    c.on("error", reject);
  });
  c.write(JSON.stringify({ op: "share", account, path: file }) + "\n");
  const r = /** @type {any} */ (await answer);
  if (r.error) throw new Error(`spawner: ${r.error}`);
  return true;
}
