// @ts-check
// The store a Space's kernel uses when the box can run Twenty: `storeFor(space, dir)` returns the Space's Twenty store (provisioning
// it the first time), or undefined, which means "use the home's SQLite". The daemon's assembly (kernel/home.js) calls it once per
// Space when VYRE_STORE is `twenty` or `auto`; nothing else changes about how the kernel is built.
//
//   VYRE_STORE=sqlite   (default) never Twenty
//   VYRE_STORE=auto     Twenty if the preflight passes; on a box too SMALL for it, SQLite with the reasons written to <dir>/twenty-unavailable.json and logged;
//                       on a box that cannot run it for any other reason (no Docker, another platform), the Space fails to start with the reasons
//   VYRE_STORE=twenty   Twenty or fail to start the Space (the reasons are the error)
//
// A Space remembers its choice (<dir>/store.json). A Space that was made on Twenty never falls back to SQLite: that would be a
// second, empty store under the same Space, so it fails to start instead and says why.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createTwentyStore } from "./store.js";
import { createDeferredStore } from "./deferred-store.js";
import { TwentyClient } from "./client.js";
import { provisionSpace, spaceDir, realRunner, MEMORY_PROFILES, autoProfile, keyHealth, rotateApiKey, KEY_WARN_DAYS } from "./provision.js";
import { CORE_TYPES } from "../../records/core-types.js";
import { typesChanged } from "../../kernel/store/types-signal.js";
import { helperPresent, helperRunner } from "./helper.js";
import { isPackaged } from "../../kernel/devbuild.js";

/**
 * The record store a Space gets when nothing says otherwise. Two tiers (the user's ruling, 5 Oct): a SERVER install (the person's own always-on server, or a team server) gives every Space its own Twenty; a DEVICE install
 * (a laptop or desktop that is not a server) is Basic, with no Twenty and no Docker: its records are the device kernel's own index. A development build keeps the built-in store everywhere so the test suites need no Docker.
 * VYRE_STORE overrides only in a development build. @param {Record<string, string | undefined>} [env] @param {{ server?: boolean, root?: string }} [o] `server`: this install is a server; `root`: read the build kind from that folder (tests)
 */
export const storeMode = (env = process.env, o = {}) => {
  // a packaged build has almost no override: a server is Twenty unless the person said sqlite (never auto), a device is always Basic (the built-in store, fixed personal types only)
  // The one thing a person may say on a server is `sqlite`: an explicit VYRE_STORE=sqlite (in vyre.env) is their choice and is honored; anything else on a server is Twenty.
  if (isPackaged(o.root)) return o.server === true ? (env.VYRE_STORE === "sqlite" ? "sqlite" : "twenty") : "sqlite";
  return env.VYRE_STORE || "sqlite";
};
import { kitFromLibrary } from "../../records/kits/library.js";

/** What a Space's Twenty needs on the box, in MB: the sum of the `small` profile plus headroom for the gateway and the OS. */
export const REQUIRE = Object.freeze({ memoryMb: Object.values(/** @type {any} */ (MEMORY_PROFILES.small)).reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) + 300, diskMb: 6144 });

/** The one plain line the person is told when this machine cannot run the record store (Twenty) for a new Space: nothing is made, and the person's server is offered. */
export const SMALL_BOX_NOTE = "This machine cannot run the record store for a new space (Twenty), so the space was not made here. Put it on your server instead. (The built-in store still exists, and is used only if you choose it on purpose: it works, and very large record sets are slower.)";
/** What the person may do about it: host the space on their server, or stop. ("create", the built-in store, is accepted when the owner asks for it by name, and is not offered.) */
export const SMALL_BOX_CHOICES = Object.freeze(["server", "cancel"]);

/** What one Space's Twenty has been MEASURED to hold at its peak, in MB, per profile (stores/twenty/live/measure-live.mjs on a real box). `small` is its caps (not measured). */
export const MEASURED = Object.freeze({ tiny: 2221 });
/** What a Space's Twenty needs now on a machine with `totalMb` of memory: the profile the machine gets (tiny under about 6 GB) with its measured peak plus headroom for the gateway and the OS. @param {number} [totalMb] */
export const requireFor = (totalMb = os.totalmem() / 1048576) => (autoProfile(totalMb) === "tiny" ? Object.freeze({ memoryMb: MEASURED.tiny + 300, diskMb: REQUIRE.diskMb }) : REQUIRE);
/** The one plain line a person reads when a server has no room for another Space's store. */
export const SERVER_FULL = "This server is full. Use a bigger server for another space.";

/** How many more Spaces' Twenty this box can take now: what is free beyond one Space's measured need, plus headroom, divided by the need. @param {number} availableMb */
export const spacesThatFit = (availableMb, totalMb = os.totalmem() / 1048576) => { const need = requireFor(totalMb).memoryMb; return Math.max(0, Math.floor((availableMb - 300) / (need - 300))); };

/** `spc_abcdefghijkl` -> `spc-abcdefghijkl` (a compose project name has no underscore). @param {string} space */
export const nameOf = (space) => space.replace(/_/g, "-");

const sh = (/** @type {string} */ cmd, /** @type {string[]} */ args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15000 }, (err, stdout) => resolve(err ? null : String(stdout))));
// what the first start of a slow store resolves to once the server has stopped waiting for it
const LATE = Symbol("late");

/**
 * Can this box run a Space's Twenty? Never throws. `memoryMb` is what is available now (free plus reclaimable), not what is installed.
 * On a box the daemon runs in a container with no Docker of its own: the capability is the Space helper (a root helper on the host, reached through a spool), so the check asks for IT, not for `docker`.
 * On a Mac, Docker is Colima's, reached through the docker context the install set.
 * @param {{ dir: string, totalMb?: number, readMeminfo?: () => string, docker?: () => Promise<boolean>, helper?: { spool?: string, state?: string } | false, statfs?: (p: string) => { bavail: number, bsize: number } }} o
 * @returns {Promise<{ ok: boolean, reasons: string[], facts: { memoryAvailableMb: number | null, diskFreeMb: number | null, docker: boolean, helper: boolean, root: boolean, platform: string } }>}
 */
export async function preflight(o) {
  /** @type {string[]} */ const reasons = [];
  let mem = null;
  try { const m = /MemAvailable:\s+(\d+) kB/.exec((o.readMeminfo ?? (() => fs.readFileSync("/proc/meminfo", "utf8")))()); if (m) mem = Math.floor(Number(m[1]) / 1024); } catch { mem = Math.floor(os.freemem() / 1048576); }
  let disk = null;
  try { const s = (o.statfs ?? ((p) => fs.statfsSync(p)))(fs.existsSync(o.dir) ? o.dir : path.dirname(o.dir)); disk = Math.floor((s.bavail * s.bsize) / 1048576); } catch { /* unknown */ }
  const helper = o.helper === false ? false : helperPresent(o.helper || undefined);
  const docker = helper || await (o.docker ?? (async () => (await sh("docker", ["info", "--format", "{{.ServerVersion}}"])) !== null))();
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  if (!docker) reasons.push(process.platform === "darwin" ? "Docker is not running on this Mac (Twenty runs in Colima)" : "this machine cannot run Docker for the space's store (no Space helper here and no Docker for this user)");
  const need = requireFor(o.totalMb);
  if (mem !== null && mem < need.memoryMb) reasons.push(`${SERVER_FULL} (${mem} MB of memory free, a Space's Twenty needs about ${need.memoryMb} MB)`);
  if (disk !== null && disk < REQUIRE.diskMb) reasons.push(`not enough disk: ${disk} MB free, a Space's Twenty needs about ${REQUIRE.diskMb} MB`);
  return { ok: reasons.length === 0, reasons, facts: { memoryAvailableMb: mem, diskFreeMb: disk, docker, helper, root, platform: process.platform } };
}

/**
 * What a Space created here now would be stored in, to show the person BEFORE it is created. `confirm` is set when the answer is the built-in store
 * on a box that could not run Twenty: show its `text` with its `choices` (create anyway or cancel), and only on "create" call `spaces.host` with
 * `accept_builtin_store: true`. Never creates anything.
 * @param {{ dir: string, mode?: string, server?: boolean, helper?: { spool?: string, state?: string } | false, preflight?: typeof preflight }} o
 * @returns {Promise<{ store: "twenty" | "sqlite", reasons: string[], confirm?: { text: string, choices: readonly string[] }, facts?: any }>}
 */
export async function planStore(o) {
  const mode = o.mode ?? storeMode(process.env, { server: o.server });
  if (mode === "sqlite") return { store: "sqlite", reasons: ["VYRE_STORE is sqlite"] };
  const pf = await (o.preflight ?? preflight)({ dir: o.dir, helper: o.helper });
  if (pf.ok) return { store: "twenty", reasons: [], facts: pf.facts };
  if (mode === "twenty") return { store: "twenty", reasons: pf.reasons, facts: pf.facts };
  return { store: "sqlite", reasons: pf.reasons, facts: pf.facts, confirm: { text: SMALL_BOX_NOTE, choices: SMALL_BOX_CHOICES } };
}

/**
 * The kernel's `storeFor(spaceId, meta)` seam (kernel/boot.js, kernel/home.js, kernel/spaces): `meta` is the Space's own record (`personal: true` for the home's first
 * Space; for a hosted one its space.json, which carries `accept_builtin_store` when the person agreed to the built-in store). Returns a store, or undefined for SQLite.
 * Options, all with defaults: `home` (the daemon's root; a Space's state lives under <home>/kernel), `reach` ("ip", or "alias" with `gatewayContainer` attached to the
 * Space's network), `memory` ("small"), `runner` (docker through the box's proxy), `mode` (VYRE_STORE).
 * @param {{ home: string, mode?: string, degrade?: boolean, retryBaseMs?: number, retryMaxMs?: number, log?: (line: string) => void, runner?: any, memory?: any, preflight?: typeof preflight, provision?: typeof provisionSpace, reach?: "alias" | "ip", gatewayContainer?: string | null, rotate?: typeof rotateApiKey, keyCheckEveryMs?: number, makeStore?: (o: { space: string, name: string, p: any }) => any, coreTypes?: boolean }} cfg
 * @returns {(space: string, meta?: any) => Promise<any | undefined>}
 */
/** What the first start is doing, in words a person can read, for each phase the provisioning reports (stores/twenty/provision.js `phase`). */
export const PHASE_WORDS = Object.freeze([
  [/^reach/, "checking that it is running"], [/^pull images/, "downloading it (the first time only)"], [/^start database/, "starting its database"],
  [/^start Records/, "starting Records (the first start takes a few minutes)"], [/^workspace and key/, "setting up its workspace"], [/^core types/, "preparing its record types (about a minute the first time)"],
]);
/** The sentence for a store still starting: where it is and how long it has been. @param {string | undefined} phase @param {number} sinceMs */
export function startingWords(phase, sinceMs) {
  const doing = phase ? (PHASE_WORDS.find(([re]) => re.test(phase)) || [null, phase])[1] : "getting ready";
  const secs = Math.round(sinceMs / 1000);
  const took = secs < 90 ? `${Math.max(1, secs)} second${Math.max(1, secs) === 1 ? "" : "s"}` : `${Math.round(secs / 60)} minutes`;
  return `the record store is still starting: ${doing} (${took} so far)`;
}

export function createStoreFor(cfg) {
  const mode = cfg.mode ?? storeMode(process.env, { server: cfg.server });
  const log = cfg.log ?? (() => {});
  /** @type {Map<string, { phase?: string, since: number, upgrade?: { done: number, total: number } | null }>} where each Space's first start is */
  const progress = new Map();
  /** How far the new core types are while the store is still away and in its core-types phase, or null. @param {string} space */
  const upgradeOf = (space) => { const g = progress.get(space); return g && g.upgrade && /^core types/.test(g.phase || "") ? g.upgrade : null; };
  /** @type {any} */
  const open = async function (/** @type {string} */ space, /** @type {any} */ meta = {}) {
    if (!progress.has(space)) progress.set(space, { since: Date.now() });
    const dir = meta.personal ? path.join(cfg.home, "kernel") : path.join(cfg.home, "kernel", "spaces", space);
    const opts = { requireConfirm: !meta.personal && meta.accept_builtin_store !== true };
    if (!["sqlite", "auto", "twenty"].includes(mode)) throw new Error(`VYRE_STORE is sqlite, auto or twenty, not ${mode}`);
    const choiceFile = path.join(dir, "store.json");
    /** @type {{ kind?: string } | null} */ let chosen = null;
    try { chosen = JSON.parse(fs.readFileSync(choiceFile, "utf8")); } catch { /* first start */ }
    if (chosen?.kind === "sqlite") return undefined;
    if (!chosen && mode === "sqlite") return undefined;
    const pf = await (cfg.preflight ?? preflight)({ dir, helper: cfg.helper });
    if (!pf.ok) {
      if (chosen?.kind === "twenty" || mode === "twenty") throw Object.assign(new Error(`the Records store for ${space} cannot start here: ${pf.reasons.join("; ")} (fix what it lists, then start the Space again)`), { code: "unavailable", reasons: pf.reasons });
      // Only a box too SMALL for Twenty may use the built-in store (the person was told at install, and a new Space asks first). A box that should run Twenty and cannot
      // (no Docker, the helper missing, another platform) is broken, and a broken box never falls back to SQLite quietly: the Space does not start and says why.
      const broken = pf.reasons.filter((/** @type {string} */ r) => !/^not enough (free memory|disk)/.test(r));
      if (broken.length) throw Object.assign(new Error(`the Records store for ${space} cannot start here: ${broken.join("; ")} (fix what it lists, then start the Space again)`), { code: "unavailable", reasons: broken });
      // a new Space the person has not agreed to put on the built-in store is not created: the answer comes first, never after
      if (opts.requireConfirm) throw Object.assign(new Error(SMALL_BOX_NOTE), { code: "needs_confirmation", plan: { store: "sqlite", reasons: pf.reasons, confirm: { text: SMALL_BOX_NOTE, choices: SMALL_BOX_CHOICES } } });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, "twenty-unavailable.json"), JSON.stringify({ at: new Date().toISOString(), reasons: pf.reasons, facts: pf.facts }, null, 2), { mode: 0o600 });
      fs.writeFileSync(choiceFile, JSON.stringify({ kind: "sqlite", why: pf.reasons, note: SMALL_BOX_NOTE }), { mode: 0o600 });
      log(`store for ${space}: SQLite (${pf.reasons.join("; ")}). ${SMALL_BOX_NOTE}`);
      return undefined;
    }
    const name = nameOf(space), twentyHome = path.join(dir, "twenty-home");
    // on a box the Space helper on the host starts Twenty (the container has no Docker): provisioning asks it, and reaches Twenty by its alias on the network the helper joins this container to
    const viaHelper = cfg.runner === undefined && cfg.helper !== false && helperPresent(cfg.helper || undefined);
    const runner = cfg.runner ?? (viaHelper ? helperRunner(name, { ...(cfg.helper || {}), log }) : realRunner());
    const reach = cfg.reach ?? (viaHelper || cfg.gatewayContainer ? "alias" : "ip");
    log(`store for ${space}: provisioning Twenty`);
    const p = await (cfg.provision ?? provisionSpace)({ home: twentyHome, space: name, runner, reach, memory: cfg.memory ?? "auto", gatewayContainer: cfg.gatewayContainer ?? null, log, onPhase: (/** @type {string} */ name) => { const g = progress.get(space); if (g) g.phase = name; } });
    // the Space's key lives a year: checked now and every day, rotated well before the end, and a failure to rotate is loud (never a quiet countdown)
    const checkKey = async () => {
      const h = keyHealth({ home: twentyHome, space: name });
      if (!h.rotate) { try { fs.rmSync(path.join(dir, "key-warning.json"), { force: true }); } catch { /* none */ } return h; }
      try { await (cfg.rotate ?? rotateApiKey)({ home: twentyHome, space: name, runner, reach, log }); try { fs.rmSync(path.join(dir, "key-warning.json"), { force: true }); } catch { /* none */ } }
      catch (e) {
        const msg = `WARNING: the API key for ${space}'s Records could not be rotated (${/** @type {Error} */ (e).message}); it ${h.daysLeft === null ? "cannot be read" : h.daysLeft <= 0 ? "has expired" : `expires in ${h.daysLeft} days`}. Records will stop being readable when it does.`;
        log(msg);
        fs.writeFileSync(path.join(dir, "key-warning.json"), JSON.stringify({ at: new Date().toISOString(), daysLeft: h.daysLeft, expiresAt: h.expiresAt, error: String(/** @type {Error} */ (e).message) }), { mode: 0o600 });
        if (!h.ok) throw Object.assign(new Error(msg), { code: "unavailable" });
      }
      return keyHealth({ home: twentyHome, space: name });
    };
    await checkKey();
    const timer = setInterval(() => { checkKey().catch((e) => log(`the daily key check failed: ${e.message}`)); }, (cfg.keyCheckEveryMs ?? 24 * 3600 * 1000)); timer.unref();
    const sdir = path.join(spaceDir(twentyHome, name), "state");
    fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
    // `cfg.makeStore` (a test seam) stands in for the Twenty store and its core types, so the attach paths can be exercised without a Twenty; with `cfg.coreTypes` the core types are still added to it.
    const store = cfg.makeStore ? cfg.makeStore({ space, name, p }) : createTwentyStore({ space, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: sdir, webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim(), log });
    // the kernel's own types are a kernel act at start (idempotent), like a module's `needs.types`. A Space that already has its types opens on them; the core types an update brought are added
    // after "Records ready", in the background (openCore): Twenty pays a cache rebuild per field, and 13 new types held a live server's Records, Flows and Kits for 25 minutes.
    const tc = Date.now();
    { const g = progress.get(space); if (g) g.phase = "core types"; }
    log("phase core types: started");
    /** @type {any} */ let opened = store;
    if (!cfg.makeStore || cfg.coreTypes) opened = await openCore(store, log, { onUpgrade: (u) => { const g = progress.get(space); if (g) g.upgrade = u; } });
    log(`phase core types: ${((Date.now() - tc) / 1000).toFixed(1)}s`);
    // the firewall rules are the root helper's to derive from the Space's real network (docs/work/records.md, "Root helper"); a guessed subnet written here would be wrong
    fs.writeFileSync(choiceFile, JSON.stringify({ kind: "twenty", name, ...(/** @type {any} */ (p).port ? { host: "127.0.0.1", port: /** @type {any} */ (p).port } : {}) }), { mode: 0o600 });
    log(`store for ${space}: Records ready`);
    // The first list a person opens is the slow one (Twenty's first query of a fresh server: p95 316 ms against 41 ms after, stores/twenty/live/perf-live.mjs): ask once now, throwaway, so they never meet it.
    if (!cfg.makeStore) void Promise.resolve().then(() => store.query("contact", { page: { limit: 50 } })).catch(() => {});
    /** @type {any} */ (opened).keyCheck = checkKey;
    /** @type {any} */ (opened).stopKeyCheck = () => clearInterval(timer);
    return opened;
  };
  /** The new core types start once whoever holds the store has it: at once for a store handed straight over, after the replay for one that joins a waiting store (`holder`, told when each type lands). @param {any} real @param {any} [holder] */
  const begin = (real, holder) => { if (real && typeof real.startUpgrade === "function") real.startUpgrade(holder); return real; };
  // `cfg.degrade` (the daemon sets it): a store that cannot be set up must not stop the daemon, or the supervisor starts it again forever. The Space gets a store that
  // answers `unavailable` in plain words, `<dir>/store-state.json` says why, and the setup is tried again in the background (5 s, doubling to a minute, or now with `retry`).
  // A refusal that is an answer to a person (`needs_confirmation`) and a bad VYRE_STORE value still throw.
  /** @type {Map<string, { store: any, dir: string, meta: any, attempts: number, reason: string, since: string, timer: any, running: boolean, starting?: boolean }>} */
  const waiting = new Map();
  const stateFile = (/** @type {string} */ dir) => path.join(dir, "store-state.json");
  const writeState = (/** @type {any} */ w, /** @type {any} */ extra) => {
    try { fs.mkdirSync(w.dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile(w.dir), JSON.stringify({ state: "unavailable", reason: w.reason, since: w.since, attempts: w.attempts, ...extra }), { mode: 0o600 }); } catch { /* the state is a convenience */ }
  };
  const backoff = (/** @type {number} */ n) => Math.min((cfg.retryBaseMs ?? 5_000) * 2 ** Math.max(0, n - 1), cfg.retryMaxMs ?? 60_000);
  const attempt = async (/** @type {string} */ space) => {
    const w = waiting.get(space);
    if (!w || w.running) return;
    w.running = true; w.starting = true;   // a retry is a start: calls say it is starting, with where it is, not the first attempt's error
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    try {
      const real = await open(space, w.meta);
      // The record of the failed attempt stops being true the moment a real store exists. attach() replays everything the kernel defined while the store was away and starts the modules that waited
      // for it, which takes minutes on a first start: the record must not outlive Records being ready by all that time (`vyre status` said "not available yet" for it).
      try { fs.rmSync(stateFile(w.dir), { force: true }); } catch { /* none */ }
      if (real) await w.store.attach(real);
      waiting.delete(space);
      try { fs.rmSync(stateFile(w.dir), { force: true }); } catch { /* none */ }
      log(`store for ${space}: Records are available now`);
      begin(real, w.store);
    } catch (e) {
      w.starting = false; w.attempts++; w.reason = /** @type {Error} */ (e).message;
      const wait = backoff(w.attempts);
      writeState(w, { next_try_at: new Date(Date.now() + wait).toISOString() });
      log(`store for ${space}: still not available (${w.reason}); trying again in ${Math.round(wait / 1000)} s`);
      w.timer = setTimeout(() => { attempt(space).catch(() => {}); }, wait); w.timer.unref?.();
    } finally { w.running = false; }
  };
  const storeFor = async function (/** @type {string} */ space, /** @type {any} */ meta = {}) {
    if (!cfg.degrade) return begin(await open(space, meta));
    const dir = meta.personal ? path.join(cfg.home, "kernel") : path.join(cfg.home, "kernel", "spaces", space);
    // A first start makes the Space's database (minutes, and on a box it needs the root helper, which the installer adds once the server answers): past `startWaitMs` the
    // server goes on with the waiting store and the setup finishes in the background, so a slow store never keeps the server's socket closed.
    const opening = open(space, meta);
    /** @type {any} */ let slow = null;
    const late = new Promise((r) => { slow = setTimeout(() => r(LATE), cfg.startWaitMs ?? 20_000); });
    try {
      const got = await Promise.race([opening, late]);
      clearTimeout(slow);
      // The store opened at once. A record left by an earlier process that could not (this one has no waiting entry to clear it) is no longer true.
      if (got !== LATE) { if (!waiting.has(space)) { try { fs.rmSync(stateFile(dir), { force: true }); } catch { /* none */ } } return begin(got); }
      const w = waiting.get(space) ?? { store: null, dir, meta, attempts: 0, reason: "", since: new Date().toISOString(), timer: null, running: true };
      w.reason = "the record store is still starting"; w.running = true; w.starting = true;
      if (!w.store) w.store = createDeferredStore({ onProgress: (words) => { const g = progress.get(space); if (g) g.phase = words; }, ...(cfg.storeWaitMs !== undefined ? { waitMs: cfg.storeWaitMs } : {}), waits: () => w.starting === true, upgrade: () => upgradeOf(space), reason: () => (w.starting ? startingWords(progress.get(space)?.phase, Date.now() - (progress.get(space)?.since ?? Date.now())) : `the record store for this space is not available yet: ${w.reason}`), log });
      waiting.set(space, w);
      log(`store for ${space}: still starting; the server goes on and the store joins when it is ready`);
      opening.then(async (real) => {
        try { fs.rmSync(stateFile(w.dir), { force: true }); } catch { /* none */ }   // before attach(), which takes minutes on a first start (see attempt)
        if (real) await w.store.attach(real);
        waiting.delete(space);
        try { fs.rmSync(stateFile(w.dir), { force: true }); } catch { /* none */ }
        log(`store for ${space}: Records are available now`);
        begin(real, w.store);
      }).catch((e) => {
        // A failed open AND an attach() that throws after it come here (a second argument to then() would not catch the attach): the record was removed when the store opened, so it is written again.
        w.starting = false; w.attempts++; w.reason = /** @type {Error} */ (e).message;
        const wait = backoff(w.attempts);
        writeState(w, { next_try_at: new Date(Date.now() + wait).toISOString() });
        log(`store for ${space}: not available (${w.reason}); the server keeps running and tries again in ${Math.round(wait / 1000)} s`);
        w.timer = setTimeout(() => { attempt(space).catch(() => {}); }, wait); w.timer.unref?.();
      }).finally(() => { w.running = false; });
      return w.store;
    } catch (e) {
      clearTimeout(slow);
      const err = /** @type {any} */ (e);
      if (err && (err.code === "needs_confirmation" || /^VYRE_STORE is /.test(String(err.message)))) throw e;
      const w = waiting.get(space) ?? { store: null, dir, meta, attempts: 0, reason: "", since: new Date().toISOString(), timer: null, running: false };
      w.attempts++; w.reason = String(err && err.message || e);
      if (!w.store) w.store = createDeferredStore({ onProgress: (words) => { const g = progress.get(space); if (g) g.phase = words; }, ...(cfg.storeWaitMs !== undefined ? { waitMs: cfg.storeWaitMs } : {}), waits: () => w.starting === true, upgrade: () => upgradeOf(space), reason: () => (w.starting ? startingWords(progress.get(space)?.phase, Date.now() - (progress.get(space)?.since ?? Date.now())) : `the record store for this space is not available yet: ${w.reason}`), log });
      waiting.set(space, w);
      const wait = backoff(w.attempts);
      writeState(w, { next_try_at: new Date(Date.now() + wait).toISOString() });
      log(`store for ${space}: not available (${w.reason}); the server keeps running and tries again in ${Math.round(wait / 1000)} s`);
      if (!w.timer) { w.timer = setTimeout(() => { attempt(space).catch(() => {}); }, wait); w.timer.unref?.(); }
      return w.store;
    }
  };
  /** Try the setup again now, for one Space or for every waiting one. Resolves when the attempts have finished. @param {string} [space] */
  storeFor.retry = async (/** @type {string | undefined} */ space) => { for (const id of space ? [space] : [...waiting.keys()]) await attempt(id); return { waiting: [...waiting.keys()] }; };
  /** The home's kernel has started: a definition made now is a person's, and is refused while its store is away (a hosted Space's store keeps queueing). */
  storeFor.bootDone = () => { for (const w of waiting.values()) if (w.meta && w.meta.personal) w.store.bootDone(); };
  storeFor.waiting = () => [...waiting].map(([space, w]) => ({ space, reason: w.starting ? startingWords(progress.get(space)?.phase, Date.now() - (progress.get(space)?.since ?? Date.now())) : w.reason, since: w.since, attempts: w.attempts }));
  storeFor.plan = () => planStore({ dir: path.join(cfg.home, "kernel"), mode, server: cfg.server, ...(cfg.preflight ? { preflight: cfg.preflight } : {}) });
  return storeFor;
}

/**
 * A Space's own types at start: the core types it does not have yet, then (only when it had none) the base Kit, then links moved onto relations if the Space is older. Idempotent. Also what the saved
 * database for new Spaces is built with (stores/twenty/live/build-golden.mjs), so a Space made from it has already done all of this.
 * @param {any} store @param {(line: string) => void} [log]
 */
export async function defineCore(store, log = () => {}) {
  // Only the ones this Space does not have yet: a core type a Kit extended (contact with its own fields) is never put back to its bare shape on a restart.
  const known = new Set((await store.types()).map((/** @type {any} */ t) => t.name));
  const fresh = CORE_TYPES.filter((t) => !known.has(t.name));
  if (fresh.length) await store.define({ add_types: [...fresh] });
  // A new Space starts with the base Kit (Contact, Appointment, Subscriber, Project): once, when its core types are made, never on a restart or on an older Space.
  if (fresh.length === CORE_TYPES.length) {
    const base = kitFromLibrary("base").includes.types;
    await store.define({ add_types: base.filter((/** @type {any} */ t) => !known.has(t.name) && !CORE_TYPES.some((c) => c.name === t.name)), change_types: base.filter((/** @type {any} */ t) => CORE_TYPES.some((c) => c.name === t.name)) });
  }
  // a Space made when links were urn text is moved onto relations once, here (a Space already on relations: one metadata read)
  { const up = await store.upgradeLinks(); if (up.applied) log(`links moved to relations: ${up.changes.join("; ")}`); }
}

/** What a call gets while an update's new record types are being added: how far it is, and that nobody has to do anything. @param {number} done @param {number} total */
export const upgradeWords = (done, total) => `Records are being upgraded (${done} of ${total} new types). This finishes on its own.`;

/** The store calls that name a type first: refused in words for a new type that has not landed yet. */
const TYPED = new Set(["describe", "get", "query", "aggregate", "create", "update", "remove", "restore", "scrub", "destroy", "verify"]);

/** The types `def` links to. @param {any} def @returns {string[]} */
const linksOf = (def) => (def && Array.isArray(def.fields) ? def.fields : []).filter((/** @type {any} */ f) => f && f.kind === "link" && typeof f.to === "string").map((/** @type {any} */ f) => String(f.to));

/**
 * The new types in an order each can be added on its own: first a type whose links all name a type that is there (or one added before it). Types that link to each other in a ring go in together.
 * @param {any[]} fresh @param {Set<string>} known @returns {any[][]}
 */
export function upgradeOrder(fresh, known) {
  const have = new Set(known), left = [...fresh], out = [];
  while (left.length) {
    const i = left.findIndex((t) => linksOf(t).every((to) => to === t.name || have.has(to) || !left.some((x) => x.name === to)));
    if (i < 0) { out.push(left.splice(0)); break; }
    const [t] = left.splice(i, 1); have.add(t.name); out.push([t]);
  }
  return out;
}

/**
 * A Space's core types when its store opens. A new Space (none of its core types yet) gets them all now, as before. A Space that already has its types opens on them: the types an update added are
 * left for `startUpgrade(holder)` to add in the background, one at a time (each define is short, so a definition anyone else makes waits for one type, not all of them), each said in the log
 * ("adding n of m new record types"). Until a type lands, a record call for it is refused in words (upgradeWords), and a definition that links to it brings it along. The returned store is the
 * real one with that layer on top; its `upgrade()` says { done, total, pending } while types are missing, and null after.
 * @param {any} store @param {(line: string) => void} [log] @param {{ onUpgrade?: (u: { done: number, total: number } | null) => void }} [o]
 */
export async function openCore(store, log = () => {}, o = {}) {
  const known = new Set((await store.types()).map((/** @type {any} */ t) => t.name));
  const fresh = CORE_TYPES.filter((t) => !known.has(t.name));
  if (!fresh.length || fresh.length === CORE_TYPES.length) { await defineCore(store, log); return store; }
  // the links of the types the Space already has are its own: brought onto relations before it opens, as before
  if (typeof store.upgradeLinks === "function") { const up = await store.upgradeLinks(); if (up && up.applied) log(`links moved to relations: ${up.changes.join("; ")}`); }
  return withUpgrade(store, fresh, known, log, o.onUpgrade);
}

/**
 * The store with the new types still to add on top of it (see openCore).
 * @param {any} store @param {any[]} fresh @param {Set<string>} known @param {(line: string) => void} log @param {(u: { done: number, total: number } | null) => void} [onUpgrade]
 */
export function withUpgrade(store, fresh, known, log, onUpgrade = () => {}) {
  const total = fresh.length;
  /** @type {Map<string, any>} */ const pending = new Map(fresh.map((t) => [t.name, t]));
  let done = 0, started = false;
  /** @type {any[]} */ const holders = [];
  const state = () => (pending.size ? { done, total, pending: [...pending.keys()] } : null);
  const say = () => { const u = state(); onUpgrade(u ? { done: u.done, total: u.total } : null); };
  /** @type {any} */ let proxy = null;
  const landed = (/** @type {string[]} */ names) => {
    for (const n of names) if (pending.delete(n)) done++;
    say();
    for (const h of [proxy, ...holders]) if (h) typesChanged(h);   // the gateway keeps a copy of what the store's types say
  };
  /** The pending types `diff` links to (and the ones they link to), which it must bring along. @param {any} diff */
  const needed = (diff) => {
    const mine = [...(diff.add_types ?? []), ...(diff.change_types ?? [])].filter(Boolean);
    const named = new Set(mine.map((t) => t.name));
    /** @type {Map<string, any>} */ const want = new Map();
    const walk = (/** @type {any} */ t) => { for (const to of linksOf(t)) { const p = pending.get(to); if (p && !named.has(to) && !want.has(to)) { want.set(to, p); walk(p); } } };
    for (const t of mine) walk(t);
    return [...want.values()];
  };
  /** @param {any} diff @param {any} [opt] */
  const define = async (diff, opt) => {
    const bring = diff && typeof diff === "object" ? needed(diff) : [];
    if (!bring.length) return store.define(diff, opt);
    log(`a definition links to ${bring.map((t) => t.name).join(", ")}, still being added: added with it`);
    const r = await store.define({ ...diff, add_types: [...bring, ...(diff.add_types ?? [])] }, opt);
    landed(bring.map((t) => t.name));
    return r;
  };
  /** The fields a definition costs on this store, the new types it brings along counted (stores/twenty/deferred-store.js defineTimeout). @param {any} diff */
  const fieldsFor = (diff) => (diff && typeof diff === "object" ? [...needed(diff), ...(diff.add_types ?? []), ...(diff.change_types ?? [])] : []).reduce((n, t) => n + (Array.isArray(t && t.fields) ? t.fields.length : 0), 0);
  const run = async () => {
    log(`adding ${total} new record types in the background: ${fresh.map((t) => t.name).join(", ")}`);
    const t0 = Date.now();
    for (const group of upgradeOrder(fresh, known)) {
      const left = group.filter((t) => pending.has(t.name));
      if (!left.length) continue;
      const names = left.map((t) => t.name).join(", ");
      log(`adding ${done + 1}${left.length > 1 ? `-${done + left.length}` : ""} of ${total} new record types (${names})`);
      const t1 = Date.now();
      try { await store.define({ add_types: left }); }
      catch (e) { log(`new record types ${names} could not be added (${/** @type {Error} */ (e).message}); they are tried again at the next start`); continue; }
      landed(left.map((t) => t.name));
      log(`added ${names} in ${((Date.now() - t1) / 1000).toFixed(1)}s (${done} of ${total})`);
    }
    log(`new record types: ${done} of ${total} added in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // a type that could not be added is not held as "being added" for ever: its calls go to the store and say what it says
    if (pending.size) { log(`not added this time: ${[...pending.keys()].join(", ")}`); pending.clear(); say(); }
  };
  /** @type {Record<string, any>} */ const extra = {
    upgrade: state,
    fieldsFor,
    define,
    /** Start adding the new types (once). `holder`: the store the kernel holds when it is not this one (a waiting store this one joined), told when each type lands. @param {any} [holder] */
    startUpgrade: (/** @type {any} */ holder) => {
      if (holder && !holders.includes(holder)) holders.push(holder);
      if (started) return;
      started = true;
      void run().catch((e) => log(`the new record types stopped: ${/** @type {Error} */ (e).message}`));
    },
  };
  say();
  proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "then") return undefined;
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(extra, prop)) return extra[prop];
      const v = target[prop];
      if (typeof v !== "function") return v;
      if (typeof prop === "string" && TYPED.has(prop)) return (/** @type {any} */ type, /** @type {any[]} */ ...a) => {
        if (pending.has(type)) return Promise.reject(Object.assign(new Error(`${upgradeWords(done, total)} The ${type} records are not there until it does.`), { code: "unavailable", name: "StoreError" }));
        return v.call(target, type, ...a);
      };
      return v.bind(target);
    },
  });
  return proxy;
}
