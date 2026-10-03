// @ts-check
// The runner: start, stream, checkpoint and stop a space's session on this computer (DESIGN-local-runner).
//
// One runner per (space, device). It owns the lease, the encrypted workspace, and one sandboxed process plus one
// egress proxy per running session. Its guarantees, each tested on a real machine (core/runner/*.test.js):
//   - it starts nothing unless both grants exist (the space allows, this member accepts) and the lease holds;
//   - the process sees only <workspace>/work and reaches only the proxy; the credentials it uses never touch this disk;
//   - every turn is checkpointed to the space, so the session continues elsewhere from the last turn, with its trust labels;
//   - when the lease ends the workspace locks and the sessions stop; when access is revoked the workspace is deleted;
//   - "locked" and "deleted" are only ever said once they are verified, a watchdog outside this process closes the workspace if
//     this process dies, and the wall clock, not a timer, decides when the lease is over.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLease } from "./lease.js";
import { driverFor } from "./workspace.js";
import { plan, launch, unavailable } from "./sandbox.js";
import { ensureLauncher, prepare as prepareWin, cleanup as cleanupWin } from "./sandbox-win.js";
import { createEgress } from "./egress.js";
import { createSessionSync, restore } from "./sync.js";
import { sandboxReader } from "./readerhost.js";
import { place, deviceState } from "./placement.js";

const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "watchdog.js");
const spaceDir = (base, space) => path.join(base, "spaces", crypto.createHash("sha256").update(space).digest("hex").slice(0, 16));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A stream-json line that ends a turn. Claude Code prints { type: "result" }; other agents use turn.end. */
const endsTurn = line => { try { const j = JSON.parse(line); return j && (j.type === "result" || j.type === "turn.end"); } catch { return false; } };

const TRUST = ["system", "member", "external", "untrusted"];
/** The weaker of two trust labels (a derived item carries the weakest label of its inputs, invariant 9). */
export const weakest = (a, b) => TRUST[Math.max(TRUST.indexOf(a), TRUST.indexOf(b), 0)];
const mergeLabels = (a, b) => ({ trust: weakest(a?.trust ?? "untrusted", b?.trust ?? "untrusted"), red: b?.red ?? a?.red, source_spaces: [...new Set([...(a?.source_spaces || []), ...(b?.source_spaces || [])])] });

/**
 * Close any workspace of this computer that nobody holds a lease for. Run at start-up: a runner that was killed, or a power cut,
 * must not leave a space's files mounted and readable (reviewer-2 R2).
 * @param {{ base: string, platform?: any, driver?: any }} o @returns {Promise<string[]>} the folders it closed
 */
export async function reconcile(o) {
  const platform = o.platform || process.platform;
  const drivers = o.driver ? [o.driver] : platform === "linux" ? [driverFor(platform, { prefer: "fscrypt" }), driverFor(platform, { prefer: "gocryptfs" })] : [driverFor(platform)];
  const root = path.join(o.base, "spaces"), closed = [];
  let ents = []; try { ents = fs.readdirSync(root); } catch {}
  for (const e of ents) {
    const dir = path.join(root, e);
    for (const driver of drivers) if (driver.isMounted(dir)) { try { await driver.unmount(dir); } catch {} if (!driver.isMounted(dir)) closed.push(dir); }
  }
  return closed;
}

/**
 * @param {{ platform?: "darwin"|"linux"|"win32", base: string, space: string, device: string,
 *   vault: any, sync: any, grants: () => { spaceAllows: boolean, memberAccepts: boolean },
 *   limits?: any, server?: () => { available: boolean, hasRoom: boolean, why?: string }, requestServer?: (session: string) => Promise<void>|void,
 *   reader?: any, sessionState?: (session: string) => any, labels?: (session: string) => any, sealState?: (state: any) => any, verifyState?: (state: any) => boolean,
 *   driver?: any, state?: () => any, onEvent?: (e: any) => void, retryMs?: number, watchdog?: boolean, lockRetryMs?: number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, now?: () => number }} o
 */
export function createRunner(o) {
  const platform = /** @type {"darwin"|"linux"|"win32"} */ (o.platform || process.platform);
  const dir = spaceDir(o.base, o.space);
  const driver = o.driver || driverFor(platform, { base: o.base });
  const now = o.now || Date.now;
  const emit = e => { try { o.onEvent?.(e); } catch {} };
  /** @type {string|null} */ let mnt = null;
  /** @type {Map<string, any>} */ const live = new Map();
  const deadlineFile = path.join(o.base, "run", crypto.createHash("sha256").update(o.space).digest("hex").slice(0, 16) + ".deadline");
  let gen = crypto.randomBytes(6).toString("hex");   // one per opening of the workspace; its watchdog belongs to it
  const winPrepFile = path.join(o.base, "run", crypto.createHash("sha256").update(o.space).digest("hex").slice(0, 16) + ".winprep");
  let winPrep = null;   // what prepare() touched on Windows, for cleanup at revoke
  let pending = null;   // a retry timer while the workspace could not be closed yet
  const workOf = m => path.join(m, "work");
  const stateOf = m => path.join(m, "state");

  /** Close the workspace and VERIFY it is closed. Retries with growing waits, forcing as the driver allows; never claims more than it saw. */
  async function lockHard() {
    for (let i = 0; i < 6; i++) {
      try { await driver.unmount(dir); } catch {}
      if (!driver.isMounted(dir)) { mnt = null; return true; }
      await sleep(Math.min(2000, (o.lockRetryMs ?? 100) * 2 ** i));
    }
    return false;
  }
  /** Keep trying in the background while it is still mounted, so a held file cannot leave it readable for ever. */
  function chase(what) {
    if (pending) return;
    const step = async () => {
      pending = null;
      if (!driver.isMounted(dir)) { mnt = null; await settled(what); return; }
      try { await driver.unmount(dir); } catch {}
      if (!driver.isMounted(dir)) { mnt = null; await settled(what); return; }
      pending = (o.setTimer || setTimeout)(step, 5000); pending.unref?.();
    };
    pending = (o.setTimer || setTimeout)(step, 2000); pending.unref?.();
  }
  async function settled(what) {
    if (what === "revoked") { await destroyHard(); return; }
    emit({ type: "locked", why: what });
  }
  async function destroyHard() {
    // Windows: the container's rights on the folders above the workspace are removed with the workspace.
    if (platform === "win32") {
      try { const prep = winPrep || JSON.parse(fs.readFileSync(winPrepFile, "utf8")); cleanupWin({ ...prep, space: o.space }); fs.rmSync(winPrepFile, { force: true }); } catch {}
      winPrep = null;
    }
    try { await driver.destroy(dir); } catch (e) { emit({ type: "destroy-failed", why: String(/** @type {any} */ (e).message) }); }
    if (!fs.existsSync(dir)) emit({ type: "deleted" }); else { emit({ type: "delete-pending" }); chase("revoked"); }
  }

  const lease = createLease({
    vault: o.vault, space: o.space, device: o.device, retryMs: o.retryMs, setTimer: o.setTimer, clearTimer: o.clearTimer, now,
    onArm: at => { try { fs.mkdirSync(path.dirname(deadlineFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(deadlineFile, JSON.stringify({ gen, at }), { mode: 0o600 }); } catch {} },
    async onLock(why) {
      // The key is gone: stop every session, close the workspace. The data stays encrypted on disk (expired, slept or released).
      for (const s of [...live.keys()]) await stop(s, { final: false });
      if (await lockHard()) { emit({ type: "locked", why }); } else { emit({ type: "lock-pending", why }); chase(why === "revoked" ? "revoked" : why); }
    },
    async onRevoke() {
      if (!driver.isMounted(dir) && !pending) await destroyHard();   // lock-pending case: chase() deletes once it is closed
    },
  });

  function startWatchdog() {
    if (o.watchdog === false || process.env.VYRE_NO_WATCHDOG) return;
    try {
      const p = spawn(process.execPath, [WATCHDOG, platform, dir, String(process.pid), deadlineFile, gen, driver.name], { detached: true, stdio: "ignore" });
      p.unref();
    } catch (e) { emit({ type: "watchdog-failed", why: String(/** @type {any} */ (e).message) }); }
  }

  /** Open the workspace (take the lease first). */
  async function open() {
    if (mnt && lease.key() && driver.isMounted(dir)) return mnt;
    gen = crypto.randomBytes(6).toString("hex");   // a new opening supersedes any older watchdog
    const r = await lease.acquire();
    if (!r.ok) throw new Error(r.why);
    const key = lease.key();
    if (!key) throw new Error("the key lease did not hold");
    if (!driver.exists(dir)) await driver.create(dir, key);
    // A mount left by a runner that died is closed first, so this runner owns the one that is open.
    if (driver.isMounted(dir)) { try { await driver.unmount(dir); } catch {} }
    mnt = await driver.mount(dir, key);
    startWatchdog();
    for (const d of ["work/files", "work/home", "work/tmp", "state"]) fs.mkdirSync(path.join(mnt, d), { recursive: true, mode: 0o700 });
    return mnt;
  }

  /** Decide where a session should run, from the grants, this computer's state and limits, and the server's. */
  function decide(opts = {}) {
    const g = o.grants();
    const why = unavailable(platform);
    return place({ pinnedToServer: opts.pinnedToServer, spaceAllows: g.spaceAllows, memberAccepts: g.memberAccepts, state: (o.state || deviceState)(), limits: o.limits, runnerReady: why, server: o.server?.() });
  }

  /**
   * The spec comes from the kernel (the module takes it from the space's own definition of the session, never from the caller):
   * @param {{ session: string, command: string, args?: string[], env?: Record<string,string>, routes: any[], readOnly?: string[], resume?: boolean, labels?: any }} s
   */
  async function start(s) {
    const g = o.grants();
    if (!g.spaceAllows || !g.memberAccepts) throw new Error("both grants are needed: the space allows it and this computer accepts it");
    if (live.has(s.session)) throw new Error("that session is already running here");
    const bad = unavailable(platform);
    if (bad) throw new Error(bad);
    const ws = await open();
    const work = workOf(ws), state = stateOf(ws);
    let resumed = null, routes = s.routes, labels = s.labels || { trust: "external" };
    if (s.resume) {
      resumed = await restore({ space: o.sync, session: s.session, work, state, verify: o.verifyState });   // required: no verifier, no resume
      if (resumed) {
        // Resume never launders: the session starts at the weaker of its old and current trust, with only the routes it had before.
        labels = mergeLabels(resumed.state?.labels, labels);
        const had = resumed.state?.routes;
        if (Array.isArray(had)) routes = routes.filter(r => had.includes(r.prefix));
      }
    }
    const reader = o.reader || sandboxReader({ platform, space: o.space, work, base: o.base });
    const sy = createSessionSync({ space: o.sync, session: s.session, work, state, reader, seal: o.sealState || (st => st), log: m => emit({ type: "sync", session: s.session, m }) });
    const token = crypto.randomBytes(24).toString("base64url");
    const eg = createEgress({ routes, vault: o.vault, session: s.session, token, lease: () => lease.id, onEvent: e => emit({ type: "egress", session: s.session, ...e }) });
    const runDir = path.join(o.base, "run");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const sock = platform === "linux" ? path.join(runDir, crypto.randomBytes(6).toString("hex") + ".sock") : undefined;
    const where = await eg.listen(sock ? { socket: sock } : {});
    let launcher;
    if (platform === "win32") {
      launcher = ensureLauncher(path.join(o.base, "bin"));
      const prep = prepareWin({ launcher, space: o.space, workspace: work, readOnly: s.readOnly || [] });
      winPrep = { launcher, workspace: work, readOnly: s.readOnly || [] };
      try { fs.writeFileSync(winPrepFile, JSON.stringify(winPrep), { mode: 0o600 }); } catch {}
      if (!prep.exempt) throw new Error("the Windows sandbox could not allow its loopback proxy: run the Vyre helper as administrator once");
    }
    const p = plan({ platform, space: o.space, launcher, workspace: work, command: s.command, args: s.args, readOnly: s.readOnly,
      proxy: where, env: { ...(s.env || {}), ANTHROPIC_API_KEY: token, VYRE_SPACE_TOKEN: token, VYRE_SESSION: s.session, ...(resumed ? { VYRE_RESUME_TURN: String(resumed.turn) } : {}) } });
    const child = launch(p, { detached: true });
    const h = { session: s.session, child, eg, sock, sy, labels, routes, queue: Promise.resolve(), stopped: false, exit: null, done: null };
    live.set(s.session, h);
    const group = sig => { if (process.platform === "win32") return; try { process.kill(-Number(child.pid), sig); } catch {} };
    let buf = "";
    child.stdout.on("data", d => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line) continue;
        h.queue = h.queue.then(async () => {
          await sy.line(line);
          if (!endsTurn(line)) return;
          // The reader runs inside the sandbox (reader.js), so a racing helper cannot reach a host file, and it reads only files whose size or
          // modification time changed. The session is NOT paused: stopping it for the length of the read blocked every write (measured:
          // seconds on a big workspace). A file written during the read is picked up by the next turn's checkpoint.
          {
            const cur = o.labels ? mergeLabels(h.labels, o.labels(s.session)) : h.labels;
            h.labels = cur;
            const st = { labels: cur, routes: routes.map(r => r.prefix), session: o.sessionState?.(s.session) };
            const ok = await sy.checkpoint(st);
            emit({ type: "checkpoint", session: s.session, ok, turn: sy.turn });
          }
        }).catch(() => {});
      }
    });
    child.stderr.on("data", d => emit({ type: "stderr", session: s.session, text: String(d).slice(0, 2000) }));
    h.done = new Promise(resolve => child.on("close", async (code, sig) => {
      h.exit = { code, sig };
      emit({ type: "exit", session: s.session, code, signal: sig });
      await h.queue;
      if (!h.stopped) await finish(h);
      resolve({ code, signal: sig });
    }));
    emit({ type: "started", session: s.session, pid: child.pid });
    return { pid: child.pid, child, resumed, done: h.done, send: line => child.stdin.write(line.endsWith("\n") ? line : line + "\n"), stop: () => stop(s.session), labels: () => h.labels };
  }

  async function finish(h) {
    live.delete(h.session);
    // Checkpoints happen only at a turn's end. A stop or a crash in the middle of a turn keeps the transcript it already
    // streamed but not the half-finished file changes, so the session continues from the last whole turn.
    try { await h.queue; if (mnt) await h.sy.flush(); } catch {}
    try { await h.eg.close(); } catch {}
    if (h.sock) { try { fs.unlinkSync(h.sock); } catch {} }
    emit({ type: "stopped", session: h.session });
  }

  /** Stop one session: ask nicely, then end it. */
  async function stop(session, _o = {}) {
    const h = live.get(session);
    if (!h) return;
    h.stopped = true;
    const pid = h.child.pid;
    const killed = new Promise(r => h.child.once("close", () => r(undefined)));
    const sig = s => { try { process.kill(-Number(pid), s); } catch { try { h.child.kill(s); } catch {} } };
    sig("SIGCONT"); sig("SIGTERM");
    const t = setTimeout(() => sig("SIGKILL"), 3000);
    if (h.child.exitCode === null && h.child.signalCode === null) await killed;
    clearTimeout(t);
    await finish(h);
  }

  async function stopAll() { for (const s of [...live.keys()]) await stop(s); }

  return {
    decide, start, stop, stopAll, open,
    /** The member stops using this computer for the space: close the workspace; the data stays. */
    async lock() { await lease.release(); },
    /** Access ended: lock and delete. Called when the kernel withdraws an offer or removes the member, not by a tool. */
    async revoke() { await lease.revoke(); },
    /** Ask the vault again. If access ended while this computer was locked or offline, the workspace is deleted now. */
    async contact() { const r = await lease.acquire(); if (r.ok && !mnt) await open(); return r; },
    /** "Move to server": a last checkpoint here (the one at the last turn), stop, and ask the space's server to resume from it. */
    async moveToServer(session) {
      await stop(session);
      await o.requestServer?.(session);
      emit({ type: "moved", session, to: "server" });
    },
    status() { return { workspace: driver.name, state: lease.state, expiresAt: lease.expiresAt, open: !!mnt && driver.isMounted(dir), mounted: driver.isMounted(dir), sessions: [...live.keys()], dir }; },
    get lease() { return lease; },
    get dir() { return dir; },
    get mnt() { return mnt; },
  };
}
