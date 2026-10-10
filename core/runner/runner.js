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

import { HARNESS_MARK } from "./pipe-home.js";
import { claudeWorkTranscript } from "../sessions/drivers/claude-transcript.js";
import { writeInside } from "./safefs.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLease } from "./lease.js";
import { driverFor, SLOWER_LINE, SWAP_LINE, SIZES_LINE, swapInfo } from "./workspace.js";
import { plan, launch, unavailable } from "./sandbox.js";
import { ensureLauncher, prepare as prepareWin, cleanup as cleanupWin } from "./sandbox-win.js";
import { createEgress } from "./egress.js";
import { openVyreDoor } from "./vyre-door.js";
import { createSessionSync, restore } from "./sync.js";
import { sandboxReader } from "./readerhost.js";
import { place, deviceState } from "./placement.js";
import { createUsage } from "./usage.js";
import { signalTree, pidsUnder } from "./proctree.js";
import { endOrphans, startedOf } from "./orphans.js";
export { endOrphans };

const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "watchdog.js");
/** What a lent session may reach when the Space has not said: the internet (a lent session that cannot clone or install is not usable). The one place to flip it. */
export const LENT_NETWORK_DEFAULT = "internet";
/** Shown when the lender offers the machine and in its settings. */
export const LENDER_NETWORK_LINE = "Sessions you lend can reach the internet from your connection. Sites see your address. You can limit them to the assistant's provider and the space.";
/** The Space's setting, capped by the lender: the lender's cap "provider" always wins (it is their connection and their address). */
export const effectiveNetwork = (space, lenderCap) => (lenderCap === "provider" ? "provider" : (space === "provider" || space === "internet" ? space : LENT_NETWORK_DEFAULT));

const spaceDir = (base, space) => path.join(base, "spaces", crypto.createHash("sha256").update(space).digest("hex").slice(0, 16));
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** How long a hand-over's flush, or the server's answer, may take: past it the hand-over fails and the session runs on. */
const HANDOVER_MS = 20_000;
const within = (p, ms) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("the server did not answer in time")), ms); t.unref?.(); p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); }); });

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
const spaceHash = (/** @type {string} */ space) => crypto.createHash("sha256").update(space).digest("hex").slice(0, 16);

export async function reconcile(o) {
  const platform = o.platform || process.platform;
  const drivers = o.driver ? [o.driver] : platform === "linux" ? [driverFor(platform, { prefer: "fscrypt" }), driverFor(platform, { prefer: "gocryptfs" })] : [driverFor(platform)];
  endOrphans(o.base);
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
 *   limits?: any, server?: () => { available: boolean, hasRoom: boolean, why?: string }, handoverMs?: number, requestServer?: (session: string, reason?: string) => Promise<{ moved?: boolean } | void> | { moved?: boolean } | void, usage?: ReturnType<typeof createUsage>,
 *   lenderCap?: "provider"|"internet", reader?: any, sessionState?: (session: string) => any, labels?: (session: string) => any, sealState?: (state: any) => any, verifyState?: (state: any) => boolean,
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
  const usage = o.usage || createUsage({ platform });
  /** Sessions being started now: a second start of the same session while the first is under way is refused, so no child is ever left untracked. @type {Set<string>} */ const starting = new Set();
  /** Why every session here is frozen right now ("pause": the person's Pause all; "offline": this computer cannot reach the Space's server and must not run ahead of it). Empty: they run. @type {Set<string>} */
  const frozen = new Set();
  const deadlineFile = path.join(o.base, "run", crypto.createHash("sha256").update(o.space).digest("hex").slice(0, 16) + ".deadline");
  let gen = crypto.randomBytes(6).toString("hex");   // one per opening of the workspace; its watchdog belongs to it
  const winPrepFile = path.join(o.base, "run", crypto.createHash("sha256").update(o.space).digest("hex").slice(0, 16) + ".winprep");
  /** @type {{ swap: boolean, hibernation: boolean, line: string }} */ let swap = { swap: false, hibernation: false, line: "" };
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
      // The key is going: hand each session to the space's server first, from its last whole turn, so it carries on there (an expired lease, a Mac that slept, the person locking the workspace). Access ended
      // (revoked) hands nothing over: the work is not this computer's to give. Then stop every session and close the workspace; the data stays encrypted on disk.
      const reason = why === "expired" ? "lease-expired" : why === "slept" ? "asleep" : why === "released" ? "you" : null;
      if (reason && o.requestServer) for (const s of [...live.keys()]) { try { await moveToServer(s, reason); } catch { /* the server takes it after the lapse */ } }
      for (const s of [...live.keys()]) await stop(s, { why: "teardown" });
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
    // which Space this folder is for, in the clear (the folder's own name is a hash): a restarted runner asks that Space's home whether this computer still has access (module start, core/runner/index.js)
    try { fs.writeFileSync(path.join(dir, "space.id"), o.space, { mode: 0o600 }); } catch {}
    // A mount left by a runner that died is closed first, so this runner owns the one that is open.
    if (driver.isMounted(dir)) { try { await driver.unmount(dir); } catch {} }
    mnt = await driver.mount(dir, key);
    swap = swapInfo();
    if (swap.line) emit({ type: "swap-warning", line: swap.line, swap: swap.swap, hibernation: swap.hibernation });   // told once to the lender, kept in status
    startWatchdog();
    for (const d of ["work/files", "work/home", "work/tmp", "state"]) fs.mkdirSync(path.join(mnt, d), { recursive: true, mode: 0o700 });
    return mnt;
  }

  /** Decide where a session should run, from the grants, this computer's state and limits, and the server's. */
  function decide(opts = {}) {
    const g = o.grants();
    const why = unavailable(platform);
    return place({ pinnedToServer: opts.pinnedToServer, spaceAllows: g.spaceAllows, memberAccepts: g.memberAccepts, state: (o.state || deviceState)(), limits: typeof o.limits === "function" ? o.limits() : o.limits, runnerReady: why, server: o.server?.() });
  }

  /**
   * The spec comes from the kernel (the module takes it from the space's own definition of the session, never from the caller):
   * @param {{ session: string, chat?: string, seed?: { native: string, count: number }, command: string, args?: string[], env?: Record<string,string>, routes: any[], readOnly?: string[], resume?: boolean, labels?: any, network?: "provider"|"internet" }} s
   */
  async function start(s) {
    if (starting.has(s.session)) throw Object.assign(new Error("that session is already being started here: wait a moment and ask again"), { code: "conflict" });
    starting.add(s.session);
    try { return await startInner(s); } finally { starting.delete(s.session); }
  }
  async function startInner(s) {
    const g = o.grants();
    if (!g.spaceAllows || !g.memberAccepts) throw new Error("both grants are needed: the space allows it and this computer accepts it");
    if (live.has(s.session)) throw Object.assign(new Error("that session is already running here (runner.places shows where it runs)"), { code: "conflict" });
    const bad = unavailable(platform);
    if (bad) throw new Error(bad);
    const ws = await open();
    const work = workOf(ws), state = stateOf(ws);
    let resumed = null, routes = s.routes, labels = s.labels || { trust: "external" };
    // A chat that began on the server and moves here: the Space's store holds its whole turns as the session's transcript, and this computer writes them into its own agent home before the program starts, in the
    // folder the program will see as its own, so the program's resume finds them. The first checkpoint after the next turn then covers them like any other line.
    if (!s.resume && s.seed && o.sync && typeof o.sync.getTranscript === "function") {
      const lines = await o.sync.getTranscript(s.session, 1);
      if (lines.length) {
        const seen = platform === "linux" ? "/work/files" : path.join(fs.realpathSync(work), "files");
        const file = claudeWorkTranscript(work, seen, String(s.seed.native));
        writeInside(work, path.relative(work, file), Buffer.from(lines.map((/** @type {any} */ e) => e.line).join("\n") + "\n"));
      }
    }
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
    const internet = effectiveNetwork(s.network, o.lenderCap) === "internet" ? { token } : undefined;   // the Space's choice: provider-and-space only (default), or the internet from this computer's connection
    const eg = createEgress({ routes, vault: o.vault, session: s.session, token, internet: Boolean(internet), lease: () => lease.id, onEvent: e => emit({ type: "egress", session: s.session, ...e }) });
    const runDir = path.join(o.base, "run");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const sock = platform === "linux" ? path.join(runDir, crypto.randomBytes(6).toString("hex") + ".sock") : undefined;
    const where = await eg.listen(sock ? { socket: sock } : {});
    // A chat's session reaches Vyre's tools through the home (lent.http): its Vyre MCP server speaks to this door as VYRE_SOCKET
    const door = s.vyre && typeof s.vyre.call === "function" ? await openVyreDoor({ socket: path.join(os.tmpdir(), `vyre-door-${crypto.randomBytes(6).toString("hex")}.sock`), call: s.vyre.call }) : null;
    let launcher;
    if (platform === "win32") {
      launcher = ensureLauncher(path.join(o.base, "bin"));
      const prep = prepareWin({ launcher, space: o.space, workspace: work, readOnly: s.readOnly || [] });
      winPrep = { launcher, workspace: work, readOnly: s.readOnly || [] };
      try { fs.writeFileSync(winPrepFile, JSON.stringify(winPrep), { mode: 0o600 }); } catch {}
      if (!prep.exempt) throw new Error("the Windows sandbox could not allow its loopback proxy: run the Vyre helper as administrator once");
    }
    // and Claude is told about the Vyre MCP server that runs beside it, with the door as its socket (a server of its own folder, which is read-only in the sandbox)
    const env = { ...(s.env || {}), ANTHROPIC_API_KEY: token, VYRE_SPACE_TOKEN: token, VYRE_SESSION: s.session, ...(resumed ? { VYRE_RESUME_TURN: String(resumed.turn) } : {}) };
    const planWith = (/** @type {typeof door} */ dr) => {
      let args = s.args, readOnly = s.readOnly, penv = env;
      const sock = dr ? (platform === "linux" ? "/run/vyre.sock" : dr.socket) : "";
      if (dr && s.vyre && s.vyre.entry && s.vyre.root) {
        args = [...(s.args || []), "--mcp-config", JSON.stringify({ mcpServers: { vyre: { command: process.execPath, args: [s.vyre.entry], env: { VYRE_SOCKET: sock } } } })];
        readOnly = [...(s.readOnly || []), s.vyre.root, ...(s.vyre.also || [])];
        // The box's own Harness is named in the arguments (HARNESS_MARK): with the door up, the lender's copy of it loads and its hooks reach the home through the same door (VYRE_SOCKET in the session's own
        // environment; VYRE_THREAD says this is Vyre's own session, as on the box). Without the door the plugin is taken out and the session runs without hooks, as before.
        if (s.vyre.plugin) { args = args.map(x => (x === HARNESS_MARK ? s.vyre.plugin : x)); penv = { ...env, VYRE_SOCKET: sock, VYRE_THREAD: s.session }; }
      }
      args = dropMark(args);
      return plan({ platform, space: o.space, launcher, internet, workspace: work, command: s.command, args, readOnly, ...(dr ? { vyre: { socket: dr.socket } } : {}), proxy: where, env: penv });
    };
    let p, doorUsed = door;
    try { p = planWith(door); }
    catch (e) {
      // a Vyre folder the sandbox will not bind (it holds a person's secret folder, as a checkout can): the session runs without Vyre's tools, and the person is told
      if (!door) throw e;
      await door.close().catch(() => {}); doorUsed = null;
      emit({ type: "vyre-unavailable", session: s.session, why: String(/** @type {any} */ (e).message).slice(0, 200) });
      p = planWith(null);
    }
    const child = launch(p, { detached: true });
    const pidFile = path.join(runDir, `${spaceHash(o.space)}.${crypto.createHash("sha256").update(s.session).digest("hex").slice(0, 12)}.pid`);
    try { fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, started: startedOf(Number(child.pid)) || undefined, session: s.session }), { mode: 0o600 }); } catch { /* the sweep at the next start has nothing to read */ }
    child.stdin.on("error", () => {});   // a session that already exited must not turn a late write into an unhandled error
    const h = { session: s.session, chat: s.chat || null, child, eg, door: doorUsed, sock, sy, labels, routes, queue: Promise.resolve(), stopped: false, exit: null, done: null, pidFile, released: false };
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
          try { await sy.line(line); } catch (e) { emit({ type: "checkpoint", session: s.session, ok: false, reason: e?.code === "disk_full" ? "disk_full" : "error", turn: sy.turn }); return; }
          if (!endsTurn(line)) return;
          // The reader runs inside the sandbox (reader.js), so a racing helper cannot reach a host file, and it reads only files whose size or
          // modification time changed. The session is NOT paused: stopping it for the length of the read blocked every write (measured:
          // seconds on a big workspace). A file written during the read is picked up by the next turn's checkpoint.
          {
            const cur = o.labels ? mergeLabels(h.labels, o.labels(s.session)) : h.labels;
            h.labels = cur;
            const st = { labels: cur, routes: routes.map(r => r.prefix), session: o.sessionState?.(s.session) };
            const ok = await sy.checkpoint(st);
            emit({ type: "checkpoint", session: s.session, ok, ...(ok || !sy.refused ? {} : { reason: sy.refused }), turn: sy.turn });
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
    if (frozen.size) signal(h, "SIGSTOP");
    emit({ type: "started", session: s.session, pid: child.pid });
    return { pid: child.pid, child, resumed, done: h.done, send: line => child.stdin.write(line.endsWith("\n") ? line : line + "\n"), stop: () => stop(s.session), labels: () => h.labels };
  }

  async function finish(h) {
    live.delete(h.session);
    // Checkpoints happen only at a turn's end. A stop or a crash in the middle of a turn keeps the transcript it already
    // streamed but not the half-finished file changes, so the session continues from the last whole turn.
    try { await h.queue; if (mnt && !h.released) await h.sy.flush(); } catch {}
    usage.forget(Number(h.child.pid));
    try { await h.eg.close(); } catch {}
    if (h.door) { try { await h.door.close(); } catch {} }
    if (h.sock) { try { fs.unlinkSync(h.sock); } catch {} }
    if (h.pidFile) { try { fs.rmSync(h.pidFile, { force: true }); } catch {} }
    // why it ended, for the Space's home: the person stopped it, the program finished by itself, the program died, or it was handed over / fenced (the home already knows)
    emit({ type: "stopped", session: h.session, why: h.released ? "released" : h.stopped ? h.why : h.exit && h.exit.code === 0 ? "finished" : "crashed" });
  }

  /** Send a signal to a session: the process group Vyre started, and, to freeze or thaw it, everything under it (the sandbox gives the agent a session of its own). */
  function signal(h, sig) {
    const pid = Number(h.child.pid);
    if (sig === "SIGSTOP" || sig === "SIGCONT") {
      // nothing found under it (the system would not list its processes) is not a freeze that worked: fall back to the group and the child itself
      if (signalTree(pid, sig) === 0) { try { process.kill(-pid, sig); } catch { try { h.child.kill(sig); } catch { /* gone */ } } }
      return;
    }
    try { process.kill(-pid, sig); } catch { try { h.child.kill(sig); } catch { /* gone */ } }
  }

  /** Stop one session: ask nicely, then end it. Everything under the process Vyre started is asked first (a frozen session wakes to hear it), and whatever is still there when the first has gone is ended. */
  async function stop(session, opt = {}) {
    const h = live.get(session);
    if (!h) return;
    h.stopped = true; h.why = opt.why || "stopped";
    const pid = h.child.pid;
    const under = pidsUnder(Number(pid));   // seen before the first dies: afterwards nothing says whose they were
    const killed = new Promise(r => h.child.once("close", () => r(undefined)));
    const sig = s => { try { process.kill(-Number(pid), s); } catch { try { h.child.kill(s); } catch {} } signalTree(Number(pid), s); };
    sig("SIGCONT"); sig("SIGTERM");
    const t = setTimeout(() => sig("SIGKILL"), 3000);
    if (h.child.exitCode === null && h.child.signalCode === null) await killed;
    clearTimeout(t);
    for (const u of under) { try { process.kill(u, 0); process.kill(u, "SIGKILL"); } catch { /* gone */ } }
    await finish(h);
  }

  const freeze = (/** @type {string} */ why) => { frozen.add(why); for (const h of live.values()) signal(h, "SIGSTOP"); };
  const thawAll = (/** @type {string} */ why) => { if (!frozen.delete(why)) return; if (!frozen.size) for (const h of live.values()) if (!h.moving) signal(h, "SIGCONT"); };

  /**
   * Hand a session to the space's server (R031-95 2.4): freeze it so it takes no new work, flush what it has already said (the last whole turn is the checkpoint), tell the home, and only when the home
   * has taken it stop it for good. A home that holds the move back (inside the cooldown) or cannot be reached leaves the session running. A turn cut in the middle is re-run from its start on the server.
   * One hand-over per session at a time: a second ask while the first is under way gets the first's answer, and nothing else wakes a session that is being handed over.
   * @param {string} session @param {string} [reason] why, as the chat says it (placement-book.js REASONS)
   */
  function moveToServer(session, reason = "you") {
    const h = live.get(session);
    if (h && h.handing) return h.handing;
    const run = async () => {
      if (h) {
        h.moving = true;
        signal(h, "SIGSTOP");
        try { await within(Promise.resolve(h.queue).then(() => (mnt ? h.sy.flush() : undefined)), o.handoverMs ?? HANDOVER_MS); } catch { /* the last acknowledged checkpoint is what the server resumes from */ }
      }
      const thaw = () => { if (h) { h.moving = false; if (!frozen.size) signal(h, "SIGCONT"); } };
      let r;
      try { r = await within(Promise.resolve(o.requestServer?.(session, reason)), o.handoverMs ?? HANDOVER_MS); } catch (e) { thaw(); throw e; }   // a server that does not answer leaves the session running, not frozen for ever
      if (r && r.moved === false) { thaw(); return { moved: false, why: /** @type {any} */ (r).why }; }
      if (h) { h.released = true; await stop(session); }
      emit({ type: "moved", session, to: "server", reason });
      return { moved: true };
    };
    if (!h) return run();
    h.handing = run().finally(() => { h.handing = null; });
    return h.handing;
  }

  async function stopAll() { for (const s of [...live.keys()]) await stop(s, { why: "teardown" }); }

  return {
    decide, start, stop, stopAll, open,
    /** The member stops using this computer for the space: close the workspace; the data stays. */
    async lock() { await lease.release(); },
    /** Access ended: lock and delete. Called when the kernel withdraws an offer or removes the member, not by a tool. */
    async revoke() { await lease.revoke(); },
    /** Ask the vault again. If access ended while this computer was locked or offline, the workspace is deleted now. */
    async contact() { const r = await lease.acquire(); if (r.ok && !mnt) await open(); return r; },
    moveToServer,
    /** The sessions running here, with what each uses now. */
    info() { return [...live.values()].map(h => ({ session: h.session, chat: h.chat, pid: h.child.pid, paused: frozen.has("pause"), ...usage.sample(Number(h.child.pid)) })); },
    /** Freeze every session here (Pause all) until `resume`. They keep their place; nothing is checkpointed or lost. */
    pause() { freeze("pause"); },
    resume() { thawAll("pause"); },
    get paused() { return frozen.has("pause"); },
    /** Is every session here held still (the person's pause, no link to the home, asleep)? A frozen session says and hears nothing. */
    get frozenNow() { return frozen.size > 0; },
    /** This computer cannot reach the Space's server: its sessions wait where they are rather than run ahead of the server, which takes them after a lapse. @param {string} why */
    freeze(why) { freeze(why); },
    thaw(why) { thawAll(why); },
    get held() { return frozen.size > 0; },
    /** The home no longer has this session at the epoch this computer holds: end it without writing anything more. */
    async fence(session) { const h = live.get(session); if (!h || h.released) return false; h.released = true; await stop(session); emit({ type: "fenced", session }); return true; },
    status() { return { workspace: driver.name, notices: [LENDER_NETWORK_LINE, ...(driver.name === "gocryptfs" ? [SLOWER_LINE] : []), ...(swap.line ? [SWAP_LINE] : []), SIZES_LINE], swap: swap.swap || swap.hibernation, state: lease.state, expiresAt: lease.expiresAt, open: !!mnt && driver.isMounted(dir), mounted: driver.isMounted(dir), sessions: [...live.keys()], dir }; },
    get lease() { return lease; },
    get dir() { return dir; },
    get mnt() { return mnt; },
  };
}

/** A Harness placeholder nobody replaced (no door, or a Vyre folder with no plugin): the flag before it goes too, and the session runs without the box's hooks. @param {string[] | undefined} args */
function dropMark(args) {
  if (!Array.isArray(args)) return args;
  const out = /** @type {string[]} */ ([]);
  for (const x of args) { if (x === HARNESS_MARK) { out.pop(); continue; } out.push(x); }
  return out;
}
