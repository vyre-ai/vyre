// @ts-check
// previews/supervisor: keeps a preview's server process running. It starts `command` in its folder on a port Vyre leased and handed over as PORT, notices when the port answers (the preview is live), restarts it
// when it dies (three times in two minutes, then it is `crashed` and says so), keeps the last 200 KB of its output for the log, and stops it by killing the process group it started. It only ever kills a process
// it started itself: it holds that process's pid, nothing is found by name. The environment is a short list (a path, a home, a locale) plus what the caller gives; the person's own shell environment, with its keys,
// never goes in. Pure of Vyre: spawn and the clock are injected so tests can run a real tiny server.
import { spawn as realSpawn } from "node:child_process";
import net from "node:net";

export const LOG_BYTES = 200 * 1024;
const SAFE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "USER", "SHELL", "TERM", "TMPDIR"];
const RESTARTS = 3, WINDOW_MS = 120_000, BACKOFF = [1000, 3000, 9000];

/** Is something accepting connections on this loopback port? @param {number} port @param {number} [ms] */
export const answers = (port, ms = 400) => new Promise(resolve => {
  const s = net.connect({ host: "127.0.0.1", port });
  const done = (/** @type {boolean} */ v) => { s.destroy(); resolve(v); };
  s.setTimeout(ms, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
});

/** Can this loopback port be bound now (nobody has it)? @param {number} port */
export const free = port => new Promise(resolve => {
  const s = net.createServer();
  s.once("error", () => resolve(false));
  s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
});

/**
 * @typedef {"starting"|"live"|"crashed"|"stopped"} State
 * @param {{ spawn?: typeof realSpawn, log?: (m: string) => void, onState?: (id: string, state: State, info: { error?: string }) => void, now?: () => number, pollMs?: number, giveUpMs?: number }} [o]
 */
export function createSupervisor(o = {}) {
  const spawn = o.spawn || realSpawn;
  const log = o.log || (() => {});
  const now = o.now || Date.now;
  const pollMs = o.pollMs ?? 300;
  const giveUpMs = o.giveUpMs ?? 90_000;
  /** @type {Map<string, { id: string, opts: { command: string, cwd: string, port: number, env: Record<string, string> }, child: import("node:child_process").ChildProcess | null, state: State, wanted: boolean, out: string, restarts: number[], timer: ReturnType<typeof setTimeout> | null, since: number }>} */
  const entries = new Map();

  const set = (/** @type {any} */ e, /** @type {State} */ state, /** @type {string} */ error = "") => {
    if (e.state === state && !error) return;
    e.state = state;
    try { o.onState?.(e.id, state, error ? { error } : {}); } catch { /* a listener's fault is not the supervisor's */ }
  };
  const append = (/** @type {any} */ e, /** @type {Buffer | string} */ d) => { e.out += String(d); if (e.out.length > LOG_BYTES) e.out = e.out.slice(e.out.length - LOG_BYTES); };

  /** Poll the port until it answers (live), or give up saying so after `giveUpMs` (and keep trying, slowly). @param {any} e */
  function watch(e) {
    const t0 = now();
    const tick = async () => {
      if (!e.wanted || !e.child) return;
      if (await answers(e.opts.port)) { if (e.wanted) set(e, "live"); return; }
      const late = now() - t0 > giveUpMs;
      if (late && e.state === "starting") set(e, "crashed", "nothing answered on its port, so it is not running as a web page yet");
      e.timer = setTimeout(tick, late ? 2000 : pollMs);
    };
    e.timer = setTimeout(tick, pollMs);
  }

  /** @param {any} e */
  function begin(e) {
    /** @type {Record<string, string>} */ const env = {};
    for (const k of SAFE_ENV) if (process.env[k]) env[k] = /** @type {string} */ (process.env[k]);
    Object.assign(env, e.opts.env, { PORT: String(e.opts.port), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1" });
    const child = spawn("/bin/sh", ["-c", e.opts.command], { cwd: e.opts.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    e.child = child;
    e.since = now();
    set(e, "starting");
    child.stdout?.on("data", d => append(e, d));
    child.stderr?.on("data", d => append(e, d));
    child.on("error", err => { append(e, `\n[could not start: ${err.message}]\n`); });
    child.on("exit", (code, sig) => {
      if (e.child !== child) return;
      e.child = null;
      if (e.timer) clearTimeout(e.timer);
      append(e, `\n[exited ${sig ? "on " + sig : "with " + code}]\n`);
      if (!e.wanted) { set(e, "stopped"); return; }
      const t = now();
      e.restarts = e.restarts.filter((/** @type {number} */ x) => t - x < WINDOW_MS);
      if (e.restarts.length >= RESTARTS) { e.wanted = false; set(e, "crashed", "it keeps stopping, so Vyre gave up restarting it"); return; }
      const wait = BACKOFF[Math.min(e.restarts.length, BACKOFF.length - 1)];
      e.restarts.push(t);
      set(e, "starting");
      e.timer = setTimeout(() => { if (e.wanted) begin(e); }, wait);
    });
    watch(e);
  }

  /** Kill the process group this supervisor started: polite first, then for good. @param {import("node:child_process").ChildProcess | null} child */
  function kill(child) {
    if (!child || !child.pid) return;
    const pid = child.pid;
    try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
    const t = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, 3000);
    t.unref?.();
    child.once("exit", () => clearTimeout(t));
  }

  /** @type {any} */ const api = {
    /** Start (or start again) a preview's process. @param {string} id @param {{ command: string, cwd: string, port: number, env?: Record<string, string> }} opts */
    start(id, opts) {
      const old = entries.get(id);
      if (old) { old.wanted = false; if (old.timer) clearTimeout(old.timer); kill(old.child); }
      const e = { id, opts: { command: opts.command, cwd: opts.cwd, port: opts.port, env: opts.env || {} }, child: null, state: /** @type {State} */ ("stopped"), wanted: true, out: "", restarts: [], timer: null, since: now() };
      entries.set(id, e);
      begin(e);
    },
    /** Restart what is already known: the same command on the same port, once the old process group has left. @param {string} id */
    restart(id) {
      const e = entries.get(id);
      if (!e) return false;
      const opts = e.opts, c = e.child;
      e.wanted = false; if (e.timer) clearTimeout(e.timer); kill(c);
      const go = () => api.start(id, opts);
      if (c) { let done = false; const once = () => { if (!done) { done = true; setTimeout(go, 150); } }; c.once("exit", once); setTimeout(once, 3500).unref?.(); } else go();
      return true;
    },
    /** @param {string} id */
    stop(id) {
      const e = entries.get(id);
      if (!e) return false;
      e.wanted = false; if (e.timer) clearTimeout(e.timer);
      if (e.child) kill(e.child); else set(e, "stopped");
      return true;
    },
    /** Forget a preview: stop it and drop its log. @param {string} id */
    forget(id) { const e = entries.get(id); if (e) { e.wanted = false; if (e.timer) clearTimeout(e.timer); kill(e.child); } entries.delete(id); },
    /** @param {string} id */ state: id => (entries.get(id) || { state: /** @type {State} */ ("stopped") }).state,
    /** The tail of its output, last `lines` lines. @param {string} id @param {number} [lines] */
    tail(id, lines = 200) { const e = entries.get(id); return e ? e.out.split("\n").slice(-lines).join("\n") : ""; },
    has: (/** @type {string} */ id) => entries.has(id),
    /** Stop everything this supervisor started (the daemon is going down; the rows keep `wanted` so they come back). */
    shutdown() { for (const e of entries.values()) { e.wanted = false; if (e.timer) clearTimeout(e.timer); kill(e.child); } },
  };
  return api;
}

/** The first free port in the pool that no preview row holds. @param {Set<number>} taken @param {[number, number]} [range] */
export async function lease(taken, range = [5100, 5999]) {
  for (let p = range[0]; p <= range[1]; p++) if (!taken.has(p) && (await free(p))) return p;
  throw Object.assign(new Error("no port is free for another preview: stop one you no longer need, then open this again"), { code: "unavailable" });
}
