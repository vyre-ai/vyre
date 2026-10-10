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
    const said = new Set();
    const done = (/** @type {string} */ ev) => (/** @type {any} */ code, /** @type {any} */ signal) => {
      if (active !== p || said.has(ev)) return;
      said.add(ev);
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
    stdin.removeAllListeners("end");
    if (ended) b.stdin.end(); else stdin.on("end", () => b.stdin.end());
  };

  // The lender holds what is written until its process is up and sends each byte once, so everything goes to it at once; a copy is kept until it says it is up, for the box if it never is.
  let up = false, settled = false;
  lent.stdin.on("error", () => {});
  stdin.on("data", (/** @type {Buffer} */ c) => { if (settled) return; held.push(Buffer.from(c)); lent.stdin.write(c); });
  stdin.on("end", () => { ended = true; if (!settled) lent.stdin.end(); });

  const lentUp = () => {
    if (settled) return;
    settled = up = true;
    proc.where = "lent"; proc.lent = lent.lent; proc.pid = lent.pid;
    held.length = 0;
    stdin.removeAllListeners("data");
    stdin.on("data", (/** @type {Buffer} */ c) => { lent.stdin.write(c); });
    stdin.removeAllListeners("end");
    stdin.on("end", () => lent.stdin.end());
    if (ended) lent.stdin.end();
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
