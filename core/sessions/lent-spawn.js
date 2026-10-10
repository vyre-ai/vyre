// @ts-check
// A chat's agent process on a lent computer, with the box as the way back (R031-95 part B; team/contracts/lent-spawn.md).
//
// `host.lentSpawn(...)` answers at once with a ChildProcess-shaped object that the lender starts a moment later. When nothing could start (`error` with code `lent_unavailable`, then close(null, null)) NOTHING ran,
// so the chat goes on on the box exactly as before. The Agent SDK wants one object, immediately, and writes its first line at once: this one keeps what was written to stdin until the lender's process is up (`spawn`)
// or the box has taken over, and hands the box's process the same bytes, once. After `spawn` the lender's process is the object. A process that ended because the session moved carries `moved`; the resume on the
// server is the loader's (agent-core), not this file's.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * @param {{ lent: any, box: () => any }} o `lent`: the lender's process (what `lentSpawn` returned); `box`: starts the same process here, as a chat that never moved would.
 * @returns {any} a ChildProcess-shaped object
 */
export function lentOrBox({ lent, box }) {
  const proc = /** @type {any} */ (new EventEmitter());
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(proc, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr], pid: undefined, exitCode: null, signalCode: null, killed: false, moved: undefined, lent: undefined, where: "pending" });
  /** @type {Buffer[]} */ const held = [];
  let ended = false, killedWith = /** @type {string | null} */ (null);
  /** @type {any} */ let active = null;

  /** Follow one process: its output and its end are this object's. @param {any} p */
  const follow = (p) => {
    active = p;
    p.stdout && p.stdout.pipe(stdout);
    p.stderr && p.stderr.pipe(stderr);
    const done = (/** @type {string} */ ev) => (/** @type {any} */ code, /** @type {any} */ signal) => {
      if (active !== p || proc.exitCode !== null || proc.signalCode !== null) return;
      proc.exitCode = code ?? null; proc.signalCode = signal ?? null;
      if (p.moved) proc.moved = p.moved;
      proc.emit(ev, code, signal);
    };
    p.on("exit", done("exit"));
    p.on("close", done("close"));
  };

  const useBox = () => {
    proc.where = "box";
    const b = box();
    proc.pid = b.pid;
    follow(b);
    b.on("error", (/** @type {Error} */ e) => proc.emit("error", e));
    b.on("spawn", () => { proc.pid = b.pid; proc.emit("spawn"); });
    if (killedWith) { try { b.kill(killedWith); } catch { /* it is going anyway */ } }
    for (const c of held.splice(0)) b.stdin.write(c);
    stdin.removeAllListeners("data");
    stdin.on("data", (/** @type {Buffer} */ c) => { b.stdin.write(c); });
    if (ended) b.stdin.end(); else stdin.on("end", () => b.stdin.end());
  };

  // Everything the SDK writes before the lender's process is up is kept, and sent to whichever process takes the session.
  let up = false, settled = false;
  stdin.on("data", (/** @type {Buffer} */ c) => { if (!settled) held.push(Buffer.from(c)); });
  stdin.on("end", () => { ended = true; });

  const lentUp = () => {
    if (settled) return;
    settled = up = true;
    proc.where = "lent"; proc.lent = lent.lent; proc.pid = lent.pid;
    // bytes already written go down in order, then the rest follows the pipe as written (the lender holds them until its process is up and sends each once)
    for (const c of held.splice(0)) lent.stdin.write(c);
    stdin.removeAllListeners("data");
    stdin.on("data", (/** @type {Buffer} */ c) => { lent.stdin.write(c); });
    if (ended) lent.stdin.end(); else stdin.once("end", () => lent.stdin.end());
    follow(lent);
    proc.emit("spawn");
  };

  lent.on("spawn", lentUp);
  lent.on("error", (/** @type {any} */ e) => {
    if (settled) { if (up) proc.emit("error", e); return; }
    settled = true;
    // Nothing ran on the lender: the box carries on, the same bytes once.
    if (e && e.code === "lent_unavailable") { useBox(); return; }
    proc.emit("error", e);
  });
  // A lender process that ended before it ever said it was up, without an error, ran nothing either.
  lent.on("close", (/** @type {any} */ code, /** @type {any} */ signal) => { if (!settled && code === null && signal === null) { settled = true; useBox(); } });

  proc.kill = (/** @type {string} */ sig = "SIGTERM") => {
    proc.killed = true;
    if (active) return active.kill(sig);
    killedWith = sig; try { lent.kill(sig); } catch { /* the lender never started it */ }
    return true;
  };
  return proc;
}

/**
 * The lender's spawn for a chat the home's book places on a computer (`where: "mac"`), or null: a chat with no row is the server's, and so is any Space this daemon is not the home of. The row's own person is the chat's own person.
 * @param {any} kernel the module's kernel handle @param {{ thread: string, chat: string | null, native: string }} q
 * @returns {((command: string, args: string[], env: any, cwd?: string, o?: any) => any) | null}
 */
export function lentSpawnFor(kernel, q) {
  /** @type {any} */ let host = null;
  try { host = kernel && typeof kernel.runnerHost === "function" ? kernel.runnerHost() : null; } catch { host = null; }
  const places = host && host.placements;
  if (!host || typeof host.lentSpawn !== "function" || !places) return null;
  for (const space of places.spaces()) {
    const row = [q.chat, q.native, q.thread].filter(Boolean).map(k => places.find(space, String(k))).find(Boolean);
    if (row && row.where === "mac") return (command, args, _env, _cwd, o) => host.lentSpawn(space, { session: row.session, chat: row.chat || q.chat || null, person: row.person, command, args, ...(o && o.signal ? { signal: o.signal } : {}) });
  }
  return null;
}
