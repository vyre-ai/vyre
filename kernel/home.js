// kernel/home.js: the kernel on a home (the daemon's own folder), behind VYRE_KERNEL=1 and off by default. It gives the home what a kernel needs and a
// legacy home does not have: a Space id and a first owner (made once, kept in `<home>/kernel/space.json`), the kernel's secret (`<home>/kernel/kernel.key`,
// 0600, never leaves), the durable log and store in the home's own SQLite, and the module host with a supervisor that proves its sandbox before any added
// module runs. Added modules reach the registry's `deps.moduleHost` only through this; with the flag off nothing here runs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bootKernel } from "./boot.js";
import { createSupervisor } from "./modules/supervisor.js";
import { createModuleHost } from "./modules/host.js";
import { createEgress } from "./modules/egress.js";
import { createFirstPartyCheck, verifyMinimums } from "./modules/firstparty.js";

/** The release-signed minimum versions kept beside the pinned key, or null when absent or not signed by that key. */
function readMinimums(dir, releaseFile) { try { return verifyMinimums(JSON.parse(fs.readFileSync(path.join(dir, "minimums.json"), "utf8")), fs.readFileSync(releaseFile, "utf8")); } catch { return null; } }

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rand32 = (/** @type {number} */ n) => Array.from(crypto.randomBytes(n), b => B32[b & 31]).join("");

/** The home's Space identity and kernel key, made on first use. @param {string} root */
export function homeIdentity(root) {
  const dir = path.join(root, "kernel");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const idFile = path.join(dir, "space.json"), keyFile = path.join(dir, "kernel.key");
  let id;
  try { id = JSON.parse(fs.readFileSync(idFile, "utf8")); } catch { id = null; }
  if (!id || !/^spc_[a-z2-7]{12}$/.test(id.space) || !/^per_[a-z2-7]{26}$/.test(id.owner)) {
    id = { space: `spc_${rand32(12)}`, owner: `per_${rand32(26)}`, made_at: Date.now() };
    fs.writeFileSync(idFile, JSON.stringify(id), { mode: 0o600 });
  }
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  if (key.length !== 32) throw new Error("the kernel key is not 32 bytes: refusing to start the kernel");
  return { ...id, key, dir };
}

/**
 * @param {{ db: import("node:sqlite").DatabaseSync, root: string, log?: (m: string) => void, isFirstParty: (dir: string) => boolean,
 *   approvals?: (name: string) => string[], sealer?: any, door?: any }} cfg
 */
export async function bootHomeKernel(cfg) {
  const id = homeIdentity(cfg.root);
  const k = bootKernel({ db: cfg.db, space: id.space, owner: id.owner, owner_uid: process.getuid ? process.getuid() : 0, key: id.key, sealer: cfg.sealer, door: cfg.door });
  const releaseFile = path.join(id.dir, "release.pub");
  // A pinned release key turns first party into a signature check (and a minimum version, if the release signed minimums); without one the registry keeps its path rule
  // and the flip is not safe (team/0.3/KERNEL-default-on.md).
  const firstPartyCheck = cfg.firstPartyCheck || (fs.existsSync(releaseFile) ? createFirstPartyCheck({ releaseKey: fs.readFileSync(releaseFile, "utf8"), minimums: readMinimums(id.dir, releaseFile) }) : null);
  /** @type {any} */ let host;
  const egress = createEgress({ space: id.space, log: k.log, chains: k.chains, hostsOf: (/** @type {string} */ n) => host && host.hostsOf(n) });
  const supervisor = createSupervisor({ egress });
  const proof = await supervisor.selfTest();
  (cfg.log || (() => {}))(proof.ok ? `kernel: module sandbox proved (${proof.mechanism})` : `kernel: no module sandbox here (${proof.why}); modules from outside Vyre will not run`);
  host = createModuleHost({ space: id.space, supervisor, isFirstParty: firstPartyCheck || cfg.isFirstParty, log: k.log, chains: k.chains });
  const approvalsFile = path.join(id.dir, "module-approvals.json");
  /** The hosts a person approved on a module's install card, kept by name. */
  const approvals = cfg.approvals || ((/** @type {string} */ name) => { try { return JSON.parse(fs.readFileSync(approvalsFile, "utf8"))[name] || []; } catch { return []; } });
  return Object.freeze({ ...k, id: { space: id.space, owner: id.owner }, firstPartyCheck, moduleHost: host, supervisor, moduleApprovals: approvals, stop: async () => { await supervisor.stopAll(); } });
}
