// @ts-check
// The runner: start, stream, checkpoint and stop a space's session on this computer (DESIGN-local-runner).
//
// One runner per (space, device). It owns the lease, the encrypted workspace, and one sandboxed process plus one
// egress proxy per running session. Its guarantees, each tested on a real machine (test/runner-*.test.js):
//   - it starts nothing unless both grants exist (the space allows, this member accepts) and the lease holds;
//   - the process sees only its workspace and reaches only the proxy; the credentials it uses never touch this disk;
//   - every turn is checkpointed to the space, so the session continues elsewhere from the last turn;
//   - when the lease ends the workspace locks and the sessions stop; when access is revoked the workspace is deleted.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createLease } from "./lease.js";
import { driverFor } from "./workspace.js";
import { plan, unavailable } from "./sandbox.js";
import { ensureLauncher, prepare as prepareWin } from "./sandbox-win.js";
import { createEgress } from "./egress.js";
import { createSessionSync, restore } from "./sync.js";
import { place, deviceState } from "./placement.js";

const spaceDir = (base, space) => path.join(base, "spaces", crypto.createHash("sha256").update(space).digest("hex").slice(0, 16));

/** A stream-json line that ends a turn. Claude Code prints { type: "result" }; other agents use turn.end. */
const endsTurn = line => { try { const j = JSON.parse(line); return j && (j.type === "result" || j.type === "turn.end"); } catch { return false; } };

/**
 * @param {{ platform?: "darwin"|"linux"|"win32", base: string, space: string, device: string,
 *   vault: any, sync: any, grants: () => { spaceAllows: boolean, memberAccepts: boolean },
 *   limits?: any, server?: () => { available: boolean, hasRoom: boolean, why?: string }, requestServer?: (session: string) => Promise<void>|void,
 *   driver?: any, state?: () => any, onEvent?: (e: any) => void, retryMs?: number, ttlMs?: number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} o
 */
export function createRunner(o) {
  const platform = /** @type {"darwin"|"linux"|"win32"} */ (o.platform || process.platform);
  const dir = spaceDir(o.base, o.space);
  const driver = o.driver || driverFor(platform);
  const emit = e => { try { o.onEvent?.(e); } catch {} };
  /** @type {string|null} */ let mnt = null;
  /** @type {Map<string, any>} */ const live = new Map();

  const lease = createLease({
    vault: o.vault, space: o.space, device: o.device, retryMs: o.retryMs, setTimer: o.setTimer, clearTimer: o.clearTimer,
    async onLock(why) {
      // The key is gone: stop every session, close the workspace. The data stays encrypted on disk (expired or released).
      for (const s of [...live.keys()]) await stop(s, { final: why === "released" });
      try { await driver.unmount(dir); } catch (e) { emit({ type: "lock-failed", why: String(e.message) }); }
      mnt = null;
      emit({ type: "locked", why });
    },
    async onRevoke() {
      try { await driver.destroy(dir); } catch (e) { emit({ type: "destroy-failed", why: String(e.message) }); }
      emit({ type: "deleted" });
    },
  });

  /** Open the workspace (take the lease first). */
  async function open() {
    if (mnt && lease.key()) return mnt;
    const r = await lease.acquire();
    if (!r.ok) throw new Error(r.why);
    const key = lease.key();
    if (!key) throw new Error("the key lease did not hold");
    if (!driver.exists(dir)) await driver.create(dir, key);
    mnt = driver.isMounted(dir) ? path.join(dir, "mnt") : await driver.mount(dir, key);
    for (const d of ["files", "home", "tmp", ".vyre"]) fs.mkdirSync(path.join(mnt, d), { recursive: true, mode: 0o700 });
    return mnt;
  }

  /** Decide where a session should run, from the grants, this computer's state and limits, and the server's. */
  function decide(opts = {}) {
    const g = o.grants();
    const why = unavailable(platform);
    return place({ pinnedToServer: opts.pinnedToServer, spaceAllows: g.spaceAllows, memberAccepts: g.memberAccepts, state: (o.state || deviceState)(), limits: o.limits, runnerReady: why, server: o.server?.() });
  }

  /**
   * @param {{ session: string, command: string, args?: string[], env?: Record<string,string>, routes: any[], readOnly?: string[], resume?: boolean }} s
   */
  async function start(s) {
    const g = o.grants();
    if (!g.spaceAllows || !g.memberAccepts) throw new Error("both grants are needed: the space allows it and this computer accepts it");
    if (live.has(s.session)) throw new Error("that session is already running here");
    const bad = unavailable(platform);
    if (bad) throw new Error(bad);
    const ws = await open();
    let resumed = null;
    if (s.resume) resumed = await restore({ space: o.sync, session: s.session, mnt: ws });
    const sy = createSessionSync({ space: o.sync, session: s.session, mnt: ws, log: m => emit({ type: "sync", session: s.session, m }) });
    const token = crypto.randomBytes(24).toString("base64url");
    const eg = createEgress({ routes: s.routes, vault: o.vault, session: s.session, token, lease: () => lease.id, onEvent: e => emit({ type: "egress", session: s.session, ...e }) });
    const runDir = path.join(o.base, "run");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const sock = platform === "linux" ? path.join(runDir, crypto.randomBytes(6).toString("hex") + ".sock") : undefined;
    const where = await eg.listen(sock ? { socket: sock } : {});
    let launcher;
    if (platform === "win32") {
      launcher = ensureLauncher(path.join(o.base, "bin"));
      const prep = prepareWin({ launcher, space: o.space, workspace: ws, readOnly: [...(s.readOnly || []), path.dirname(s.command)] });
      if (!prep.exempt) throw new Error("the Windows sandbox could not allow its loopback proxy: run the Vyre helper as administrator once");
    }
    const p = plan({ platform, space: o.space, launcher, workspace: ws, command: s.command, args: s.args, readOnly: s.readOnly,
      proxy: where, env: { ...(s.env || {}), ANTHROPIC_API_KEY: token, VYRE_SPACE_TOKEN: token, VYRE_SESSION: s.session, ...(resumed ? { VYRE_RESUME_TURN: String(resumed.turn) } : {}) } });
    const child = spawn(p.argv[0], p.argv.slice(1), { env: p.env, cwd: p.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const h = { session: s.session, child, eg, sock, sy, queue: Promise.resolve(), stopped: false, exit: null };
    live.set(s.session, h);
    let buf = "";
    child.stdout.on("data", d => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line) continue;
        h.queue = h.queue.then(async () => { await sy.line(line); if (endsTurn(line)) { const ok = await sy.checkpoint(); emit({ type: "checkpoint", session: s.session, ok, turn: sy.turn }); } }).catch(() => {});
      }
    });
    child.stderr.on("data", d => emit({ type: "stderr", session: s.session, text: String(d).slice(0, 2000) }));
    h.done = new Promise(resolve => child.on("close", async (code, sig) => {
      h.exit = { code, sig };
      await h.queue;
      if (!h.stopped) await finish(h, { final: true });
      resolve({ code, signal: sig });
    }));
    emit({ type: "started", session: s.session, pid: child.pid });
    return { pid: child.pid, child, done: h.done, send: line => child.stdin.write(line.endsWith("\n") ? line : line + "\n"), stop: () => stop(s.session) };
  }

  async function finish(h, { final }) {
    live.delete(h.session);
    // Checkpoints happen only at a turn's end. A stop or a crash in the middle of a turn keeps the transcript it already
    // streamed but not the half-finished file changes, so the session continues from the last whole turn.
    try { await h.queue; if (mnt) await h.sy.flush(); } catch {}
    try { await h.eg.close(); } catch {}
    if (h.sock) { try { fs.unlinkSync(h.sock); } catch {} }
    emit({ type: "stopped", session: h.session });
  }

  /** Stop one session: ask nicely, then end it, then take a last checkpoint if the workspace is still open. */
  async function stop(session, { final = true } = {}) {
    const h = live.get(session);
    if (!h) return;
    h.stopped = true;
    const pid = h.child.pid;
    const killed = new Promise(r => h.child.once("close", () => r(undefined)));
    const sig = s => { try { process.kill(-Number(pid), s); } catch { try { h.child.kill(s); } catch {} } };
    sig("SIGTERM");
    const t = setTimeout(() => sig("SIGKILL"), 3000);
    if (h.child.exitCode === null && h.child.signalCode === null) await killed;
    clearTimeout(t);
    await finish(h, { final });
  }

  async function stopAll() { for (const s of [...live.keys()]) await stop(s); }

  return {
    decide, start, stop, stopAll, open,
    /** The member stops using this computer for the space: close the workspace; the data stays. */
    async lock() { await lease.release(); },
    /** Access ended: lock and delete. */
    async revoke() { await lease.revoke(); },
    /** Ask the vault again. If access ended while this computer was locked or offline, the workspace is deleted now. */
    async contact() { const r = await lease.acquire(); if (r.ok && !mnt) await open(); return r; },
    /** "Move to server": a last checkpoint here, stop, and ask the space's server to resume from it. */
    async moveToServer(session) {
      await stop(session, { final: true });
      await o.requestServer?.(session);
      emit({ type: "moved", session, to: "server" });
    },
    status() { return { state: lease.state, expiresAt: lease.expiresAt, open: !!mnt, sessions: [...live.keys()], dir }; },
    get lease() { return lease; },
    get dir() { return dir; },
    get mnt() { return mnt; },
  };
}
