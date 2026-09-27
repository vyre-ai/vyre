// @ts-check
// holder: one terminal's shell, kept alive apart from vyred (ADR 0029 R4).
//
// vyred starts `node holder.js '<json>'` detached (a session of its own, stdio closed but for one
// "ready <pid>" line), so a vyred restart or crash does not take the shell with it. The holder owns
// the `script` pty (pty.js), keeps the byte-offset ring (ring.js), and listens on a unix socket
// in a folder only this user can open. vyred connects to it:
//  - an attach connection (one per browser socket) says HELLO {mode: "attach", from}, gets AT
//    {from, cut, end, cols, rows}, the ring's bytes after `from`, then live output. It sends keys
//    (IN) and sizes (SIZE). A connection that reads slowly holds the shell's output back.
//  - a control connection (vyred's own, one per terminal) says HELLO {mode: "control"} and can
//    QUERY (answered with INFO) or CLOSE.
// Every connection hears EXIT {reason} before the holder goes: "exited" (the shell ended),
// "closed" (CLOSE, or SIGTERM), "detached" (no attach connection for keepMs), "failed".
//
// With no attach connection the holder keeps the shell for keepMs, then ends itself. It writes
// nothing a terminal prints anywhere but its socket: no log, no file.

import fs from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { Pty } from "./pty.js";
import { Ring, Reader, T, frame, outFrames, json } from "./ring.js";

/** A connection holding more than this unread makes the shell wait. */
const SLOW = 256 * 1024;

/**
 * @param {{ id: string, cwd: string, cols?: number, rows?: number, shell?: string, login?: boolean,
 *   sock: string, ring?: number, keepMs?: number }} o
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

  const info = () => ({ id: o.id, pid: process.pid, cols: pty.cols, rows: pty.rows, end: ring.end, start: ring.start, attached: attached.size, until });

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
            const r = ring.since(m.from);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let o;
  try { o = JSON.parse(process.argv[2] || ""); } catch { process.exit(2); }
  process.chdir("/");
  hold(o);
}
