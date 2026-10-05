// @ts-check
// The store a Space's kernel uses: `storeFor(space, dir)` returns the Space's Twenty store (provisioning it the first time). The daemon's assembly
// (kernel/home.js) calls it once per Space on a SERVER install. A device install is Basic: no Twenty, `storeFor` is not made, and the kernel keeps
// its records in the home's own SQLite (kernel/store/sqlite.js), limited to the fixed personal types. A server has no SQLite record store.
//
//   VYRE_STORE=twenty   (default on a packaged server) Twenty, or the Space does not start: a new Space says so and offers the person's server;
//                       the home's own Space boots with every record call answering one plain refusal
//   VYRE_STORE=sqlite   (default on a device and on a development build) the home's SQLite; refused on a packaged server
//
// A Space remembers that it was made on Twenty (<dir>/store.json). There is no fallback to another store: that would be a second,
// empty store under the same Space.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createTwentyStore } from "./store.js";
import { TwentyClient } from "./client.js";
import { provisionSpace, spaceDir, realRunner, MEMORY_PROFILES, keyHealth, rotateApiKey, KEY_WARN_DAYS } from "./provision.js";
import { CORE_TYPES } from "../../records/core-types.js";
import { helperPresent, helperRunner } from "./helper.js";
import { isPackaged } from "../../kernel/devbuild.js";
import { createRefusingStore } from "../../kernel/store/refusing.js";

/**
 * The record store a Space gets when nothing says otherwise. Two tiers (the user's ruling, 5 Oct): a SERVER install (the person's own always-on server, or a team server) gives every Space its own Twenty; a DEVICE install
 * (a laptop or desktop that is not a server) is Basic, with no Twenty and no Docker: its records are the device kernel's own index. A development build keeps the built-in store everywhere so the test suites need no Docker.
 * VYRE_STORE overrides only in a development build. @param {Record<string, string | undefined>} [env] @param {{ server?: boolean, root?: string }} [o] `server`: this install is a server; `root`: read the build kind from that folder (tests)
 */
export const storeMode = (env = process.env, o = {}) => {
  // a packaged build has no override: a server is always Twenty (never sqlite or auto), a device is always Basic (the built-in store, fixed personal types only)
  if (isPackaged(o.root)) return o.server === true ? "twenty" : "sqlite";
  return env.VYRE_STORE || "sqlite";
};
import { kitFromLibrary } from "../../records/kits/library.js";

/** What a Space's Twenty needs on the box, in MB: the sum of the `small` profile plus headroom for the gateway and the OS. */
export const REQUIRE = Object.freeze({ memoryMb: Object.values(/** @type {any} */ (MEMORY_PROFILES.small)).reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) + 300, diskMb: 6144 });

/** The one plain line the person is told when this machine cannot run the record store (Twenty) for a new Space: nothing is made, and the person's server is offered. */
export const SMALL_BOX_NOTE = "This machine cannot run the record store for a new space (Twenty), so the space was not made here. Put it on your server instead.";
/** What the person may do about it: host the space on their server, or stop. */
export const SMALL_BOX_CHOICES = Object.freeze(["server", "cancel"]);

/** How many more Spaces' Twenty this box can take now: what is free beyond one Space's measured need, plus headroom, divided by the need. @param {number} availableMb */
export const spacesThatFit = (availableMb) => Math.max(0, Math.floor((availableMb - 300) / (REQUIRE.memoryMb - 300)));

/** `spc_abcdefghijkl` -> `spc-abcdefghijkl` (a compose project name has no underscore). @param {string} space */
export const nameOf = (space) => space.replace(/_/g, "-");

const sh = (/** @type {string} */ cmd, /** @type {string[]} */ args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15000 }, (err, stdout) => resolve(err ? null : String(stdout))));

/**
 * Can this box run a Space's Twenty? Never throws. `memoryMb` is what is available now (free plus reclaimable), not what is installed.
 * On a box the daemon runs in a container with no Docker of its own: the capability is the Space helper (a root helper on the host, reached through a spool), so the check asks for IT, not for `docker`.
 * On a Mac, Docker is Colima's, reached through the docker context the install set.
 * @param {{ dir: string, readMeminfo?: () => string, docker?: () => Promise<boolean>, helper?: { spool?: string, state?: string } | false, statfs?: (p: string) => { bavail: number, bsize: number } }} o
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
  if (mem !== null && mem < REQUIRE.memoryMb) reasons.push(`not enough free memory: ${mem} MB available, a Space's Twenty needs about ${REQUIRE.memoryMb} MB`);
  if (disk !== null && disk < REQUIRE.diskMb) reasons.push(`not enough disk: ${disk} MB free, a Space's Twenty needs about ${REQUIRE.diskMb} MB`);
  return { ok: reasons.length === 0, reasons, facts: { memoryAvailableMb: mem, diskFreeMb: disk, docker, helper, root, platform: process.platform } };
}

/**
 * What a Space created here now would be stored in, to show the person BEFORE it is created. `confirm` is set when this server cannot run Twenty: show its `text`
 * with its `choices` (host it on the person's server, or cancel). Nothing is made on a server without Twenty. Never creates anything.
 * @param {{ dir: string, mode?: string, server?: boolean, helper?: { spool?: string, state?: string } | false, preflight?: typeof preflight }} o
 * @returns {Promise<{ store: "twenty" | "sqlite" | "none", reasons: string[], confirm?: { text: string, choices: readonly string[] }, facts?: any }>}
 */
export async function planStore(o) {
  const mode = checkMode(o.mode ?? storeMode(process.env, { server: o.server }), { server: o.server });
  if (mode === "sqlite") return { store: "sqlite", reasons: ["VYRE_STORE is sqlite"] };
  const pf = await (o.preflight ?? preflight)({ dir: o.dir, helper: o.helper });
  if (pf.ok) return { store: "twenty", reasons: [], facts: pf.facts };
  return { store: "none", reasons: pf.reasons, facts: pf.facts, confirm: { text: SMALL_BOX_NOTE, choices: SMALL_BOX_CHOICES } };
}

/**
 * VYRE_STORE is twenty or sqlite. `auto` is gone, and a packaged SERVER never uses SQLite for records (a development build may, so the suites need no Docker).
 * @param {string} mode @param {{ server?: boolean, packaged?: boolean }} [o]
 */
export function checkMode(mode, o = {}) {
  if (mode !== "twenty" && mode !== "sqlite") throw new Error(`VYRE_STORE is twenty or sqlite, not ${mode} (auto is gone: a server keeps records in Twenty, a device in its own store)`);
  if (mode === "sqlite" && o.server === true && (o.packaged ?? isPackaged())) throw new Error("VYRE_STORE=sqlite is for a device install and development builds only: a server keeps records in Twenty");
  return mode;
}

/**
 * The kernel's `storeFor(spaceId, meta)` seam (kernel/boot.js, kernel/home.js, kernel/spaces): `meta` is the Space's own record (`personal: true` for the home's first
 * Space; for a hosted one its space.json). Returns the Space's Twenty store; undefined for SQLite (Basic); for the home's own Space on a server that cannot run Twenty, a store that refuses every record call with one plain line.
 * Options, all with defaults: `home` (the daemon's root; a Space's state lives under <home>/kernel), `reach` ("ip", or "alias" with `gatewayContainer` attached to the
 * Space's network), `memory` ("small"), `runner` (docker through the box's proxy), `mode` (VYRE_STORE).
 * @param {{ home: string, mode?: string, log?: (line: string) => void, runner?: any, memory?: any, preflight?: typeof preflight, provision?: typeof provisionSpace, reach?: "alias" | "ip", gatewayContainer?: string | null, rotate?: typeof rotateApiKey, keyCheckEveryMs?: number }} cfg
 * @returns {(space: string, meta?: any) => Promise<any | undefined>}
 */
export function createStoreFor(cfg) {
  const mode = checkMode(cfg.mode ?? storeMode(process.env, { server: cfg.server }), { server: cfg.server });
  const log = cfg.log ?? (() => {});
  /** @type {any} */
  const storeFor = async function (/** @type {string} */ space, /** @type {any} */ meta = {}) {
    const dir = meta.personal ? path.join(cfg.home, "kernel") : path.join(cfg.home, "kernel", "spaces", space);
    const choiceFile = path.join(dir, "store.json");
    /** @type {{ kind?: string } | null} */ let chosen = null;
    try { chosen = JSON.parse(fs.readFileSync(choiceFile, "utf8")); } catch { /* first start */ }
    if (mode === "sqlite") return undefined;
    const pf = await (cfg.preflight ?? preflight)({ dir, helper: cfg.helper });
    if (!pf.ok) {
      if (chosen?.kind === "twenty") throw Object.assign(new Error(`the Records store for ${space} cannot start here: ${pf.reasons.join("; ")}`), { code: "unavailable", reasons: pf.reasons });
      if (!meta.personal) throw Object.assign(new Error(SMALL_BOX_NOTE), { code: "needs_confirmation", plan: { store: "none", reasons: pf.reasons, confirm: { text: SMALL_BOX_NOTE, choices: SMALL_BOX_CHOICES } } });
      // the home's own Space: the daemon starts, records answer one plain refusal, and the reasons are written beside it for `vyre status`
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, "twenty-unavailable.json"), JSON.stringify({ at: new Date().toISOString(), reasons: pf.reasons, facts: pf.facts }, null, 2), { mode: 0o600 });
      const refusing = createRefusingStore(pf.reasons.join("; "));
      log(`store for ${space}: none. ${refusing.message}`);
      return refusing;
    }
    const name = nameOf(space), twentyHome = path.join(dir, "twenty-home");
    // on a box the Space helper on the host starts Twenty (the container has no Docker): provisioning asks it, and reaches Twenty by its alias on the network the helper joins this container to
    const viaHelper = cfg.runner === undefined && cfg.helper !== false && helperPresent(cfg.helper || undefined);
    const runner = cfg.runner ?? (viaHelper ? helperRunner(name, { ...(cfg.helper || {}), log }) : realRunner());
    const reach = cfg.reach ?? (viaHelper || cfg.gatewayContainer ? "alias" : "ip");
    log(`store for ${space}: provisioning Twenty`);
    const p = await (cfg.provision ?? provisionSpace)({ home: twentyHome, space: name, runner, reach, memory: cfg.memory ?? "small", gatewayContainer: cfg.gatewayContainer ?? null, log });
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
    await defineCore(store, log);
    log(`phase core types: ${((Date.now() - tc) / 1000).toFixed(1)}s`);
    // the firewall rules are the root helper's to derive from the Space's real network (docs/work/records.md, "Root helper"); a guessed subnet written here would be wrong
    fs.writeFileSync(choiceFile, JSON.stringify({ kind: "twenty", name, ...(/** @type {any} */ (p).port ? { host: "127.0.0.1", port: /** @type {any} */ (p).port } : {}) }), { mode: 0o600 });
    log(`store for ${space}: Records ready`);
    /** @type {any} */ (store).keyCheck = checkKey;
    /** @type {any} */ (store).stopKeyCheck = () => clearInterval(timer);
    return store;
  };
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
