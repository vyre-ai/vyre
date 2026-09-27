// @ts-check
// holder: one terminal's shell, kept alive apart from vyred (ADR 0029 R4).
//
// vyred starts `node holder.js '<json>'` detached (a session of its own, stdio closed but for one
// "ready <pid>" line), so a vyred restart or crash does not take the shell with it. The holder owns
// the `script` pty (pty.js), keeps the byte-offset ring (ring.js), and listens on a unix socket
// in a folder only this user can open. vyred connects to it:
//  - an attach connection (one per browser socket) says HELLO {mode: "attach", from, tail?}, gets
//    AT {from, cut, end, cols, rows}, the ring's bytes after `from`, then live output. With no
//    `from` and a `tail`, the replay is the last `tail` bytes (an older client's 64 KB). It sends keys
//    (IN) and sizes (SIZE). A connection that reads slowly holds the shell's output back.
//  - a control connection (vyred's own, one per terminal) says HELLO {mode: "control"} and can
//    QUERY (answered with INFO) or CLOSE. INFO carries `meta`, what vyred handed the holder at
//    start (folder, screen, owner key, when), so a restarted vyred can find its terminals again
//    from their sockets alone.
// Every connection hears EXIT {reason} before the holder goes: "exited" (the shell ended),
// "closed" (CLOSE, or SIGTERM), "detached" (no attach connection for keepMs), "failed".
//
// With no attach connection the holder keeps the shell for keepMs, then ends itself. It writes
// nothing a terminal prints anywhere but its socket: no log, no file.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Pty } from "./pty.js";
import { Ring, Reader, T, frame, outFrames, json } from "./ring.js";

/** A connection holding more than this unread makes the shell wait. */
const SLOW = 256 * 1024;

/**
 * @param {{ id: string, cwd: string, cols?: number, rows?: number, shell?: string, login?: boolean,
 *   sock: string, ring?: number, keepMs?: number, meta?: object }} o
 */
export function hold(o) {
  const ring = new Ring(o.ring || 1024 * 1024);
  const keepMs = Math.max(100, Number(o.keepMs) || 12 * 3600_000);
  /** @type {Set<net.Socket>} */ const conns = new Set();
  /** @type {Set<net.Socket>} */ const attached = new Set();
  /** @type {any} */ let keep = null;
  /** @type {number|null} */ let until = null;
  let ending = false;

  const pty = new Pty({ cwd: o.cwd, cols: o.cols, rows: o.rows, shell: o.shell, login: o.login !== false,
    onData: b => output(b), onExit: () => { end("exited"); } });

  const idle = () => {
    if (keep) clearTimeout(keep);
    until = Date.now() + keepMs;
    keep = setTimeout(() => { keep = null; if (!attached.size) end("detached"); }, keepMs);
  };
  const busy = () => { if (keep) { clearTimeout(keep); keep = null; } until = null; };
  const resumeIfDrained = () => { if ([...attached].every(c => c.writableLength <= SLOW)) pty.child.stdout?.resume(); };

  /** @param {Buffer} b */
  function output(b) {
    ring.push(b);
    if (!attached.size) return;
    const frames = outFrames(b);
    let slow = false;
    for (const c of attached) {
      for (const f of frames) { try { c.write(f); } catch {} }
      if (c.writableLength > SLOW) slow = true;
    }
    if (slow) pty.child.stdout?.pause();
  }

  const info = () => ({ id: o.id, meta: o.meta || {}, pid: process.pid, pty: pty.pid, leader: pty.leader, cols: pty.cols, rows: pty.rows, end: ring.end, start: ring.start, attached: attached.size, until });

  /** @param {string} reason */
  async function end(reason) {
    if (ending) return;
    ending = true;
    busy();
    for (const c of conns) { try { c.end(frame(T.EXIT, { reason })); } catch {} }
    try { server.close(); } catch {}
    try { fs.rmSync(o.sock, { force: true }); } catch {}
    await pty.close().catch(() => {});
    // Let the EXIT frames go out, then leave.
    await Promise.race([
      Promise.all([...conns].map(c => new Promise(r => { if (c.destroyed) r(undefined); else c.once("close", () => r(undefined)); }))),
      new Promise(r => setTimeout(r, 500)),
    ]);
    process.exit(0);
  }

  const server = net.createServer(c => {
    if (ending) { c.destroy(); return; }
    conns.add(c);
    const reader = new Reader();
    let mode = "";
    const gone = () => {
      conns.delete(c);
      if (attached.delete(c)) {
        if (!attached.size && !ending) { pty.child.stdout?.resume(); idle(); }
        else resumeIfDrained();
      }
    };
    c.on("close", gone);
    c.on("error", () => { try { c.destroy(); } catch {} });
    c.on("drain", resumeIfDrained);
    c.on("data", chunk => {
      let frames;
      try { frames = reader.push(chunk); } catch { c.destroy(); return; }
      for (const f of frames) {
        if (!mode) {
          const m = f.type === T.HELLO ? json(f.body) : null;
          if (!m || (m.mode !== "attach" && m.mode !== "control")) { c.destroy(); return; }
          mode = m.mode;
          if (mode === "attach") {
            // since() and joining `attached` happen in one turn, so no byte falls between them.
            const tail = Number(m.tail);
            const from = m.from == null && Number.isInteger(tail) && tail >= 0 ? Math.max(ring.start, ring.end - tail) : m.from;
            const r = ring.since(from);
            c.write(frame(T.AT, { from: r.from, cut: r.cut, end: ring.end, cols: pty.cols, rows: pty.rows }));
            for (const x of outFrames(r.bytes)) c.write(x);
            attached.add(c);
            busy();
            if (c.writableLength > SLOW) pty.child.stdout?.pause();
          }
          continue;
        }
        if (f.type === T.IN) pty.write(f.body);
        else if (f.type === T.SIZE) { const s = json(f.body); if (s) pty.resize(s.cols, s.rows); }
        else if (f.type === T.QUERY) c.write(frame(T.INFO, info()));
        else if (f.type === T.CLOSE && mode === "control") end("closed");
      }
    });
  });

  process.on("SIGTERM", () => { end("closed"); });
  process.on("SIGINT", () => { end("closed"); });
  process.on("SIGHUP", () => {});
  process.on("uncaughtException", () => { end("failed"); });

  try { fs.rmSync(o.sock, { force: true }); } catch {}
  server.listen(o.sock, () => {
    try { fs.chmodSync(o.sock, 0o600); } catch {}
    idle();
    // The one thing the holder ever says on stdout, so vyred knows it is listening.
    try { process.stdout.end(`ready ${process.pid}\n`); } catch {}
  });
  server.on("error", () => { end("failed"); });
}

const HOLDER = fileURLToPath(import.meta.url);

/**
 * Start a holder detached from this process (its own session, no stdio after "ready"), and wait
 * until it listens. Resolves {pid, sock}.
 * @param {Parameters<typeof hold>[0]} o
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ pid: number, sock: string }>}
 */
export function spawnHolder(o, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER, JSON.stringify(o)], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "", done = false;
    /** @param {Error|null} err @param {any} [v] */
    const finish = (err, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdout?.destroy(); } catch {}
      child.unref();
      if (err) reject(err); else resolve(v);
    };
    const timer = setTimeout(() => { try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch {} finish(new Error("the terminal holder did not start")); }, timeoutMs);
    child.stdout?.on("data", b => { out += b; const m = /ready (\d+)/.exec(out); if (m) finish(null, { pid: Number(m[1]), sock: o.sock }); });
    child.stdout?.on("error", () => {});
    child.on("error", e => finish(e));
    child.on("exit", code => finish(new Error(`the terminal holder exited (${code})`)));
  });
}

/**
 * Connect to a holder and say HELLO. Frames from it go to onFrame. Resolves once connected.
 * @param {string} sock @param {{ mode: "attach"|"control", from?: number|null, tail?: number }} hello
 * @param {(f: { type: number, body: Buffer }) => void} onFrame
 * @returns {Promise<net.Socket>}
 */
export function dial(sock, hello, onFrame, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    const rd = new Reader();
    const timer = setTimeout(() => { c.destroy(); reject(new Error("the terminal holder did not answer")); }, timeoutMs);
    c.on("connect", () => { clearTimeout(timer); c.write(frame(T.HELLO, hello)); resolve(c); });
    c.on("error", e => { clearTimeout(timer); reject(e); });
    c.on("data", chunk => {
      let fr;
      try { fr = rd.push(chunk); } catch { c.destroy(); return; }
      for (const f of fr) onFrame(f);
    });
  });
}

/** Ask a holder who it is: its INFO, or null when nothing live answers on that socket. @param {string} sock */
export async function query(sock, timeoutMs = 2000) {
  /** @type {net.Socket|null} */ let c = null;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      dial(sock, { mode: "control" }, f => { if (f.type === T.INFO) { clearTimeout(timer); resolve(json(f.body)); } }, timeoutMs)
        .then(s => { c = s; s.on("close", () => { clearTimeout(timer); resolve(null); }); s.write(frame(T.QUERY, "")); }, e => { clearTimeout(timer); reject(e); });
    });
  } catch { return null; }
  finally { try { /** @type {any} */ (c)?.destroy(); } catch {} }
}

const isMain = () => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(HOLDER); } catch { return false; } };
if (isMain()) {
  let o;
  try { o = JSON.parse(process.argv[2] || ""); } catch { process.exit(2); }
  process.chdir("/");
  hold(o);
}
