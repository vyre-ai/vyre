// @ts-check
// The store a Space's kernel uses when the box can run Twenty: `storeFor(space, dir)` returns the Space's Twenty store (provisioning
// it the first time), or undefined, which means "use the home's SQLite". The daemon's assembly (kernel/home.js) calls it once per
// Space when VYRE_STORE is `twenty` or `auto`; nothing else changes about how the kernel is built.
//
//   VYRE_STORE=sqlite   (default) never Twenty
//   VYRE_STORE=auto     Twenty if the preflight passes, else SQLite with the reasons written to <dir>/twenty-unavailable.json and logged
//   VYRE_STORE=twenty   Twenty or fail to start the Space (the reasons are the error)
//
// A Space remembers its choice (<dir>/store.json). A Space that was made on Twenty never falls back to SQLite: that would be a
// second, empty store under the same Space, so it fails to start instead and says why.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createTwentyStore } from "./store.js";
import { TwentyClient } from "./client.js";
import { provisionSpace, spaceDir, realRunner, MEMORY_PROFILES } from "./provision.js";
import { CORE_TYPES } from "../../records/core-types.js";

/** What a Space's Twenty needs on the box, in MB: the sum of the `small` profile plus headroom for the gateway and the OS. */
export const REQUIRE = Object.freeze({ memoryMb: Object.values(/** @type {any} */ (MEMORY_PROFILES.small)).reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) + 300, diskMb: 6144 });

/** The one plain line the person is told when a new Space is created on a box too small for Twenty. */
export const SMALL_BOX_NOTE = "This server has room for the built-in store only. Everything works, and very large record sets will be slower. A space can't be moved to the larger store yet, so add memory first if you expect this space to grow.";
/** The two choices the person has when a new Space would be created on the built-in store. */
export const SMALL_BOX_CHOICES = Object.freeze(["create", "cancel"]);

/** How many more Spaces' Twenty this box can take now: what is free beyond one Space's measured need, plus headroom, divided by the need. @param {number} availableMb */
export const spacesThatFit = (availableMb) => Math.max(0, Math.floor((availableMb - 300) / (REQUIRE.memoryMb - 300)));

/** `spc_abcdefghijkl` -> `spc-abcdefghijkl` (a compose project name has no underscore). @param {string} space */
export const nameOf = (space) => space.replace(/_/g, "-");

const sh = (/** @type {string} */ cmd, /** @type {string[]} */ args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15000 }, (err, stdout) => resolve(err ? null : String(stdout))));

/**
 * Can this box run a Space's Twenty? Never throws. `memoryMb` is what is available now (free plus reclaimable), not what is installed.
 * @param {{ dir: string, readMeminfo?: () => string, docker?: () => Promise<boolean>, statfs?: (p: string) => { bavail: number, bsize: number } }} o
 * @returns {Promise<{ ok: boolean, reasons: string[], facts: { memoryAvailableMb: number | null, diskFreeMb: number | null, docker: boolean, root: boolean, platform: string } }>}
 */
export async function preflight(o) {
  /** @type {string[]} */ const reasons = [];
  let mem = null;
  try { const m = /MemAvailable:\s+(\d+) kB/.exec((o.readMeminfo ?? (() => fs.readFileSync("/proc/meminfo", "utf8")))()); if (m) mem = Math.floor(Number(m[1]) / 1024); } catch { mem = Math.floor(os.freemem() / 1048576); }
  let disk = null;
  try { const s = (o.statfs ?? ((p) => fs.statfsSync(p)))(fs.existsSync(o.dir) ? o.dir : path.dirname(o.dir)); disk = Math.floor((s.bavail * s.bsize) / 1048576); } catch { /* unknown */ }
  const docker = await (o.docker ?? (async () => (await sh("docker", ["info", "--format", "{{.ServerVersion}}"])) !== null))();
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  if (process.platform !== "linux") reasons.push(`Twenty runs on a Linux box, and this is ${process.platform}`);
  if (!docker) reasons.push("Docker is not installed or this user cannot use it");
  if (mem !== null && mem < REQUIRE.memoryMb) reasons.push(`not enough free memory: ${mem} MB available, a Space's Twenty needs about ${REQUIRE.memoryMb} MB`);
  if (disk !== null && disk < REQUIRE.diskMb) reasons.push(`not enough disk: ${disk} MB free, a Space's Twenty needs about ${REQUIRE.diskMb} MB`);
  return { ok: reasons.length === 0, reasons, facts: { memoryAvailableMb: mem, diskFreeMb: disk, docker, root, platform: process.platform } };
}

/**
 * What a Space created here now would be stored in, to show the person BEFORE it is created. `confirm` is set when the answer is the built-in store
 * on a box that could not run Twenty: show its `text` with its `choices` (create anyway or cancel), and only on "create" call `spaces.host` with
 * `accept_builtin_store: true`. Never creates anything.
 * @param {{ dir: string, mode?: string, preflight?: typeof preflight }} o
 * @returns {Promise<{ store: "twenty" | "sqlite", reasons: string[], confirm?: { text: string, choices: readonly string[] }, facts?: any }>}
 */
export async function planStore(o) {
  const mode = o.mode ?? process.env.VYRE_STORE ?? "sqlite";
  if (mode === "sqlite") return { store: "sqlite", reasons: ["VYRE_STORE is sqlite"] };
  const pf = await (o.preflight ?? preflight)({ dir: o.dir });
  if (pf.ok) return { store: "twenty", reasons: [], facts: pf.facts };
  if (mode === "twenty") return { store: "twenty", reasons: pf.reasons, facts: pf.facts };
  return { store: "sqlite", reasons: pf.reasons, facts: pf.facts, confirm: { text: SMALL_BOX_NOTE, choices: SMALL_BOX_CHOICES } };
}

/**
 * The kernel's `storeFor(spaceId, meta)` seam (kernel/boot.js, kernel/home.js, kernel/spaces): `meta` is the Space's own record (`personal: true` for the home's first
 * Space; for a hosted one its space.json, which carries `accept_builtin_store` when the person agreed to the built-in store). Returns a store, or undefined for SQLite.
 * Options, all with defaults: `home` (the daemon's root; a Space's state lives under <home>/kernel), `reach` ("ip", or "alias" with `gatewayContainer` attached to the
 * Space's network), `memory` ("small"), `runner` (docker through the box's proxy), `mode` (VYRE_STORE).
 * @param {{ home: string, mode?: string, log?: (line: string) => void, runner?: any, memory?: any, preflight?: typeof preflight, provision?: typeof provisionSpace, reach?: "alias" | "ip", gatewayContainer?: string | null }} cfg
 * @returns {(space: string, meta?: any) => Promise<any | undefined>}
 */
export function createStoreFor(cfg) {
  const mode = cfg.mode ?? process.env.VYRE_STORE ?? "sqlite";
  const log = cfg.log ?? (() => {});
  /** @type {any} */
  const storeFor = async function (/** @type {string} */ space, /** @type {any} */ meta = {}) {
    const dir = meta.personal ? path.join(cfg.home, "kernel") : path.join(cfg.home, "kernel", "spaces", space);
    const opts = { requireConfirm: !meta.personal && meta.accept_builtin_store !== true };
    if (!["sqlite", "auto", "twenty"].includes(mode)) throw new Error(`VYRE_STORE is sqlite, auto or twenty, not ${mode}`);
    const choiceFile = path.join(dir, "store.json");
    /** @type {{ kind?: string } | null} */ let chosen = null;
    try { chosen = JSON.parse(fs.readFileSync(choiceFile, "utf8")); } catch { /* first start */ }
    if (chosen?.kind === "sqlite") return undefined;
    if (!chosen && mode === "sqlite") return undefined;
    const pf = await (cfg.preflight ?? preflight)({ dir });
    if (!pf.ok) {
      if (chosen?.kind === "twenty" || mode === "twenty") throw Object.assign(new Error(`the Twenty store for ${space} cannot start here: ${pf.reasons.join("; ")}`), { code: "unavailable", reasons: pf.reasons });
      // a new Space the person has not agreed to put on the built-in store is not created: the answer comes first, never after
      if (opts.requireConfirm) throw Object.assign(new Error(SMALL_BOX_NOTE), { code: "needs_confirmation", plan: { store: "sqlite", reasons: pf.reasons, confirm: { text: SMALL_BOX_NOTE, choices: SMALL_BOX_CHOICES } } });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, "twenty-unavailable.json"), JSON.stringify({ at: new Date().toISOString(), reasons: pf.reasons, facts: pf.facts }, null, 2), { mode: 0o600 });
      fs.writeFileSync(choiceFile, JSON.stringify({ kind: "sqlite", why: pf.reasons, note: SMALL_BOX_NOTE }), { mode: 0o600 });
      log(`store for ${space}: SQLite (${pf.reasons.join("; ")}). ${SMALL_BOX_NOTE}`);
      return undefined;
    }
    const name = nameOf(space), twentyHome = path.join(dir, "twenty-home");
    log(`store for ${space}: provisioning Twenty`);
    const p = await (cfg.provision ?? provisionSpace)({ home: twentyHome, space: name, runner: cfg.runner ?? realRunner(), reach: cfg.reach ?? (cfg.gatewayContainer ? "alias" : "ip"), memory: cfg.memory ?? "small", gatewayContainer: cfg.gatewayContainer ?? null, log });
    const sdir = path.join(spaceDir(twentyHome, name), "state");
    fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
    const store = createTwentyStore({ space: name, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: sdir, webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });
    // the kernel's own types are a kernel act at start (idempotent), like a module's `needs.types`
    await store.define({ add_types: [...CORE_TYPES] });
    // the firewall rules are the root helper's to derive from the Space's real network (docs/work/records.md, "Root helper"); a guessed subnet written here would be wrong
    fs.writeFileSync(choiceFile, JSON.stringify({ kind: "twenty", name }), { mode: 0o600 });
    log(`store for ${space}: Twenty ready`);
    return store;
  };
  storeFor.plan = () => planStore({ dir: path.join(cfg.home, "kernel"), mode, ...(cfg.preflight ? { preflight: cfg.preflight } : {}) });
  return storeFor;
}
