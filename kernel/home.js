// kernel/home.js: the kernel on a home (the daemon's own folder), behind VYRE_KERNEL=1 and off by default. It gives the home what a kernel needs and a
// legacy home does not have: a Space id and a first owner (made once, kept in `<home>/kernel/space.json`), the kernel's secret (`<home>/kernel/kernel.key`,
// 0600, never leaves), the durable log and store in the home's own SQLite, and the module host with a supervisor that proves its sandbox before any added
// module runs. Added modules reach the registry's `deps.moduleHost` only through this; with the flag off nothing here runs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootKernel } from "./boot.js";
import { startSealer } from "./seal/client.js";
import { fileKernelKey } from "./keys.js";
import { createSpaceKernels } from "./spaces/index.js";
import { KernelError } from "./core/errors.js";
import { createSupervisor } from "./modules/supervisor.js";
import { createModuleHost } from "./modules/host.js";
import { createEgress } from "./modules/egress.js";
import { createFirstPartyCheck, acceptMinimums, verifyMinimums } from "./modules/firstparty.js";
import { RELEASE_KEY } from "../lib/release-sig.js";
import { devSwitch } from "./devbuild.js";

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
  return { ...id, dir, keyFile };
}

/**
 * @param {{ releaseKey?: any, pathRule?: boolean, fileKey?: boolean, db: import("node:sqlite").DatabaseSync, root: string, log?: (m: string) => void, isFirstParty: (dir: string) => boolean,
 *   approvals?: (name: string) => string[], sealer?: any, door?: any, onStageEnter?: any, stageTasks?: any, stageFactory?: (space: string, kernel: any, meta: any) => Promise<any> | any, storeFor?: (space: string, meta: any) => Promise<any> | any }} cfg
 */
export async function bootHomeKernel(cfg) {
  const id = homeIdentity(cfg.root);
  // K-3: the kernel key comes from the sealing process, never from a file. A sealing process is started here unless one was given; if it cannot run safely on this
  // host the kernel does not start (a developer may opt into a file key with VYRE_KERNEL_FILE_KEY=1).
  const log = cfg.log || (() => {});
  let sealer = cfg.sealer, ownSealer = false, key, legacyKeys = [];
  const devFileKey = cfg.fileKey === true || devSwitch(process.env.VYRE_KERNEL_FILE_KEY);
  if (process.env.VYRE_KERNEL_FILE_KEY === "1" && !devFileKey) log("kernel: VYRE_KERNEL_FILE_KEY ignored (this is a packaged daemon)");
  if (!sealer && !devFileKey) {
    try { sealer = startSealer({ dir: path.join(id.dir, "seal"), dev: process.env.VYRE_SEAL_DEV === "1", ...(process.env.VYRE_SEAL_PROFILE ? { profile: process.env.VYRE_SEAL_PROFILE } : {}) }); ownSealer = true; await sealer.health(); }
    catch (e) { if (sealer) await sealer.close().catch(() => {}); throw new KernelError("key_custody", "the kernel will not start here: its key must live in the sealing process, and the sealing process cannot run safely on this machine (a server with its own OS user, or the OS keystore)", String(e && /** @type {any} */ (e).code || e)); }
  }
  if (sealer) {
    // K-3: no key is held here. The grants store and the chain builder ask the sealing process to MAC and verify (kernel/core/seal.js). A key file from before custody
    // moved only verifies what it already sealed; once that is read a snapshot is written under the new seal and the file is deleted.
    if (fs.existsSync(id.keyFile)) { try { legacyKeys = [Buffer.from(fs.readFileSync(id.keyFile, "utf8").trim(), "hex")]; } catch { /* unreadable: nothing to verify against */ } }
  } else { log("kernel: DEVELOPER file key in use (VYRE_KERNEL_FILE_KEY=1); never the default, never for a real home"); key = fileKernelKey(id.dir); }
  const personalStore = cfg.storeFor ? await cfg.storeFor(id.space, { owner: id.owner, personal: true }) : undefined;
  const k = await bootKernel({ db: cfg.db, space: id.space, owner: id.owner, owner_uid: process.getuid ? process.getuid() : 0, ...(key ? { key } : {}), legacyKeys, sealer, door: cfg.door, ...(personalStore ? { store: personalStore } : {}), ...(cfg.onStageEnter ? { onStageEnter: cfg.onStageEnter } : {}), ...(cfg.stageTasks ? { stageTasks: cfg.stageTasks } : {}) });
  // The migration pass ran inside the rebuild if there was anything to migrate; once the log holds a snapshot under the new seal the old key file has no use.
  if (sealer && legacyKeys.length && k.migrated) { try { fs.rmSync(id.keyFile, { force: true }); } catch { /* the file is harmless now */ } }
  // First party is a signature by the COMPILED release key (lib/release-sig.js), and a counter-signed list of minimum versions the release ships beside it
  // (`<home>/kernel/minimums.json`, written by the updater; never taken from a file that decides the key). There is no fallback to a path rule: a checkout whose modules are
  // not signed (development) must say so with VYRE_KERNEL_PATH_RULE=1, which is loud and never the default. A production kernel without a signature check does not start.
  /** @type {((dir: string) => boolean) | null} */ let firstPartyCheck = cfg.firstPartyCheck || null;
  if (!firstPartyCheck) {
    if (process.env.VYRE_KERNEL_PATH_RULE === "1" && !devSwitch("1")) log("kernel: VYRE_KERNEL_PATH_RULE ignored (this is a packaged daemon)");
    if (cfg.pathRule === true || devSwitch(process.env.VYRE_KERNEL_PATH_RULE)) (cfg.log || (() => {}))("kernel: DEVELOPER path rule for first-party modules (VYRE_KERNEL_PATH_RULE=1); never the default, never for a real home");
    else {
      // M-1: the highest counter accepted, with the minimums that came with it, is kept in the kernel's own log (`kernel.minimums` events), not in a file the user can write. An
      // event carries the release-SIGNED document itself and is re-verified against the release key at every boot: the counter and the minimums come from the verified
      // document, never from the event's own fields, and an event that does not verify is ignored and logged. The highest VERIFIED counter wins. A missing, unsigned, older
      // or unreadable `minimums.json` never relaxes it. A fresh home (nothing accepted yet) needs a signature only.
      const relKey = cfg.releaseKey || RELEASE_KEY;
      const note = /** @type {any} */ ({ type: "kernel.minimums", sv: 2, subject: `vyre://${id.space}/kernel/minimums`, vis: "owner", red: "internal" });
      /** @type {{ counter: number, minimums: Record<string, string> } | null} */ let seen = null;
      for (const e of k.log.read({ type: "kernel.minimums" })) {
        const v = e.data && e.data.doc ? verifyMinimums(e.data.doc, relKey) : null;
        if (!v) { log("kernel: a kernel.minimums event does not carry a document the release key signed; ignored"); continue; }
        if (!seen || v.counter > seen.counter) seen = v;
      }
      let minimums = seen ? seen.minimums : null;
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(id.dir, "minimums.json"), "utf8"));
        const d = acceptMinimums(doc, relKey, seen ? seen.counter : 0);
        if (d) { minimums = d.minimums; if (!seen || d.counter > seen.counter) await k.log.append(k.chains.fromFacts({ kind: "module", module: "home", first_party: true }), { ...note, data: { counter: d.counter, minimums: d.minimums, doc: { body: doc.body, sig: doc.sig } } }); }
        else if (seen) log("kernel: the minimum-versions document is older than one already accepted, or does not verify; the last accepted one stays in force");
      } catch { if (seen) log("kernel: no readable minimum-versions document; the last accepted one stays in force"); }
      firstPartyCheck = createFirstPartyCheck({ releaseKey: cfg.releaseKey || RELEASE_KEY, minimums });
    }
  }
  /** @type {any} */ let host;
  const egress = createEgress({ space: id.space, log: k.log, chains: k.chains, hostsOf: (/** @type {string} */ n) => host && host.hostsOf(n) });
  const supervisor = createSupervisor({ egress });
  const proof = await supervisor.selfTest();
  (cfg.log || (() => {}))(proof.ok ? `kernel: module sandbox proved (${proof.mechanism})` : `kernel: no module sandbox here (${proof.why}); modules from outside Vyre will not run`);
  host = createModuleHost({ space: id.space, supervisor, isFirstParty: firstPartyCheck || cfg.isFirstParty, log: k.log, chains: k.chains });
  const approvalsFile = path.join(id.dir, "module-approvals.json");
  /** The hosts a person approved on a module's install card, kept by name. */
  const approvals = cfg.approvals || ((/** @type {string} */ name) => { try { return JSON.parse(fs.readFileSync(approvalsFile, "utf8"))[name] || []; } catch { return []; } });
  // The Spaces this home hosts (kernel/spaces): the personal one is this kernel; every other has its own store, log and sealing namespace, opened once here. Each takes the
  // home's sealing client namespaced per Space (kernel.mac and verify cover "<space>\n<data>"), so no key file exists for any of them; without a sealing process the registry
  // refuses a hosted Space unless this boot is the developer file-key one.
  const spaces = createSpaceKernels({ root: cfg.root, personal: { space: id.space, kernel: k }, openDb: (/** @type {string} */ f) => new DatabaseSync(f), ...(cfg.stageFactory ? { stageFactory: cfg.stageFactory } : {}), ...(sealer ? { sealer } : { fileKey: true }), ...(cfg.door ? { doorFor: () => cfg.door } : {}), ...(cfg.storeFor ? { storeFor: cfg.storeFor } : {}) });
  await spaces.start();
  return Object.freeze({ ...k, spaces, id: { space: id.space, owner: id.owner }, kernelFor: k.kernelFor, firstPartyCheck, moduleHost: host, supervisor, moduleApprovals: approvals, stop: async () => { await spaces.stop(); await supervisor.stopAll(); if (ownSealer && sealer) await sealer.close(); } });
}
