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
 * @param {{ home: string, mode?: string, degrade?: boolean, retryBaseMs?: number, retryMaxMs?: number, log?: (line: string) => void, runner?: any, memory?: any, preflight?: typeof preflight, provision?: typeof provisionSpace, reach?: "alias" | "ip", gatewayContainer?: string | null, rotate?: typeof rotateApiKey, keyCheckEveryMs?: number }} cfg
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
  /** @type {Map<string, { phase?: string, since: number }>} where each Space's first start is */
  const progress = new Map();
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
    const store = createTwentyStore({ space, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: sdir, webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });
    // the kernel's own types are a kernel act at start (idempotent), like a module's `needs.types`
    const tc = Date.now();
    { const g = progress.get(space); if (g) g.phase = "core types"; }
    log("phase core types: started");
    await defineCore(store, log);
    log(`phase core types: ${((Date.now() - tc) / 1000).toFixed(1)}s`);
    // the firewall rules are the root helper's to derive from the Space's real network (docs/work/records.md, "Root helper"); a guessed subnet written here would be wrong
    fs.writeFileSync(choiceFile, JSON.stringify({ kind: "twenty", name, ...(/** @type {any} */ (p).port ? { host: "127.0.0.1", port: /** @type {any} */ (p).port } : {}) }), { mode: 0o600 });
    log(`store for ${space}: Records ready`);
    /** @type {any} */ (store).keyCheck = checkKey;
    /** @type {any} */ (store).stopKeyCheck = () => clearInterval(timer);
    return store;
  };
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
    w.running = true;
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    try {
      const real = await open(space, w.meta);
      if (real) await w.store.attach(real);
      waiting.delete(space);
      try { fs.rmSync(stateFile(w.dir), { force: true }); } catch { /* none */ }
      log(`store for ${space}: Records are available now`);
    } catch (e) {
      w.starting = false; w.attempts++; w.reason = /** @type {Error} */ (e).message;
      const wait = backoff(w.attempts);
      writeState(w, { next_try_at: new Date(Date.now() + wait).toISOString() });
      log(`store for ${space}: still not available (${w.reason}); trying again in ${Math.round(wait / 1000)} s`);
      w.timer = setTimeout(() => { attempt(space).catch(() => {}); }, wait); w.timer.unref?.();
    } finally { w.running = false; }
  };
  const storeFor = async function (/** @type {string} */ space, /** @type {any} */ meta = {}) {
    if (!cfg.degrade) return open(space, meta);
    const dir = meta.personal ? path.join(cfg.home, "kernel") : path.join(cfg.home, "kernel", "spaces", space);
    // A first start makes the Space's database (minutes, and on a box it needs the root helper, which the installer adds once the server answers): past `startWaitMs` the
    // server goes on with the waiting store and the setup finishes in the background, so a slow store never keeps the server's socket closed.
    const opening = open(space, meta);
    /** @type {any} */ let slow = null;
    const late = new Promise((r) => { slow = setTimeout(() => r(LATE), cfg.startWaitMs ?? 20_000); });
    try {
      const got = await Promise.race([opening, late]);
      clearTimeout(slow);
      if (got !== LATE) return got;
      const w = waiting.get(space) ?? { store: null, dir, meta, attempts: 0, reason: "", since: new Date().toISOString(), timer: null, running: true };
      w.reason = "the record store is still starting"; w.running = true; w.starting = true;
      if (!w.store) w.store = createDeferredStore({ waits: () => w.starting === true, reason: () => (w.starting ? startingWords(progress.get(space)?.phase, Date.now() - (progress.get(space)?.since ?? Date.now())) : `the record store for this space is not available yet: ${w.reason}`), log });
      waiting.set(space, w);
      log(`store for ${space}: still starting; the server goes on and the store joins when it is ready`);
      opening.then(async (real) => {
        if (real) await w.store.attach(real);
        waiting.delete(space);
        try { fs.rmSync(stateFile(w.dir), { force: true }); } catch { /* none */ }
        log(`store for ${space}: Records are available now`);
      }, (e) => {
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
      if (!w.store) w.store = createDeferredStore({ waits: () => w.starting === true, reason: () => `the record store for this space is not available yet: ${w.reason}`, log });
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
  // A new Space starts with the base Kit (Contact, Lead, Appointment, Client, Subscriber, Project): once, when its core types are made, never on a restart or on an older Space.
  if (fresh.length === CORE_TYPES.length) {
    const base = kitFromLibrary("base").includes.types;
    await store.define({ add_types: base.filter((/** @type {any} */ t) => !known.has(t.name) && !CORE_TYPES.some((c) => c.name === t.name)), change_types: base.filter((/** @type {any} */ t) => CORE_TYPES.some((c) => c.name === t.name)) });
  }
  // a Space made when links were urn text is moved onto relations once, here (a Space already on relations: one metadata read)
  { const up = await store.upgradeLinks(); if (up.applied) log(`links moved to relations: ${up.changes.join("; ")}`); }
}
