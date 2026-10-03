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
import { provisionSpace, spaceDir, realRunner, firewallRules, MEMORY_PROFILES } from "./provision.js";
import { CORE_TYPES } from "../../records/core-types.js";

/** What a Space's Twenty needs on the box, in MB: the sum of the `small` profile plus headroom for the gateway and the OS. */
export const REQUIRE = Object.freeze({ memoryMb: Object.values(/** @type {any} */ (MEMORY_PROFILES.small)).reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) + 300, diskMb: 6144 });

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
 * @param {{ mode?: string, log?: (line: string) => void, runner?: any, memory?: any, preflight?: typeof preflight, provision?: typeof provisionSpace, reach?: "alias" | "ip" }} [cfg]
 * @returns {(space: string, dir: string) => Promise<any | undefined>}
 */
export function createStoreFor(cfg = {}) {
  const mode = cfg.mode ?? process.env.VYRE_STORE ?? "sqlite";
  const log = cfg.log ?? (() => {});
  return async function storeFor(space, dir) {
    if (!["sqlite", "auto", "twenty"].includes(mode)) throw new Error(`VYRE_STORE is sqlite, auto or twenty, not ${mode}`);
    const choiceFile = path.join(dir, "store.json");
    /** @type {{ kind?: string } | null} */ let chosen = null;
    try { chosen = JSON.parse(fs.readFileSync(choiceFile, "utf8")); } catch { /* first start */ }
    if (chosen?.kind === "sqlite") return undefined;
    if (!chosen && mode === "sqlite") return undefined;
    const pf = await (cfg.preflight ?? preflight)({ dir });
    if (!pf.ok) {
      if (chosen?.kind === "twenty" || mode === "twenty") throw Object.assign(new Error(`the Twenty store for ${space} cannot start here: ${pf.reasons.join("; ")}`), { code: "unavailable", reasons: pf.reasons });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, "twenty-unavailable.json"), JSON.stringify({ at: new Date().toISOString(), reasons: pf.reasons, facts: pf.facts }, null, 2), { mode: 0o600 });
      fs.writeFileSync(choiceFile, JSON.stringify({ kind: "sqlite", why: pf.reasons }), { mode: 0o600 });
      log(`store for ${space}: SQLite (${pf.reasons.join("; ")})`);
      return undefined;
    }
    const name = nameOf(space), twentyHome = path.join(dir, "twenty-home");
    log(`store for ${space}: provisioning Twenty`);
    const p = await (cfg.provision ?? provisionSpace)({ home: twentyHome, space: name, runner: cfg.runner ?? realRunner(), reach: cfg.reach ?? "ip", memory: cfg.memory ?? "small", log });
    const sdir = path.join(spaceDir(twentyHome, name), "state");
    fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
    const store = createTwentyStore({ space: name, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: sdir, webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });
    // the kernel's own types are a kernel act at start (idempotent), like a module's `needs.types`
    await store.define({ add_types: [...CORE_TYPES] });
    fs.writeFileSync(path.join(dir, "firewall.rules"), firewallRules({ space: name, subnet: "172.30.0.0/16" }), { mode: 0o600 });
    fs.writeFileSync(choiceFile, JSON.stringify({ kind: "twenty", name }), { mode: 0o600 });
    log(`store for ${space}: Twenty ready`);
    return store;
  };
}
