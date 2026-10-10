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
import { provisionDrive } from "./storage/provision.js";
import { sealedDrive } from "./storage/sealed-drive.js";
import { Keys } from "../lib/keywrap.js";
import { derive } from "../lib/databox.js";
import { ProcessKeys } from "../lib/chat-keys.js";
import { createSpaceKernels } from "./spaces/index.js";
import { KernelError } from "./core/errors.js";
import { isExactlyPerson, isChain } from "./core/chain.js";
import { createDoor } from "./door/door.js";
import { sealerPresence, payloadHash } from "./core/presence.js";
import { createSupervisor } from "./modules/supervisor.js";
import { createModuleHost } from "./modules/host.js";
import { createEgress } from "./modules/egress.js";
import { createFirstPartyCheck, acceptMinimums, verifyMinimums } from "./modules/firstparty.js";
import { RELEASE_KEY } from "../lib/release-sig.js";
import { devSwitch, PKG_ROOT, isPackaged } from "./devbuild.js";
import { readReleaseList, verifyRawList, createListCheck, verifyTrees } from "./modules/release-list.js";

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
 *   resolveCredential?: (i: { space: string, ref: string, route: string, method?: string, path?: string }) => Promise<string>,
 *   approvals?: (name: string) => string[], presence?: any, sealer?: any, door?: any, packageRoot?: string, onStageEnter?: any, stageTasks?: any, stageFactory?: (space: string, kernel: any, meta: any) => Promise<any> | any, forwardCredential?: (q: any) => Promise<any>, storeFor?: (space: string, meta: any) => Promise<any> | any }} cfg
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
    try { sealer = startSealer({ dir: path.join(id.dir, "seal"), dev: devSwitch(process.env.VYRE_SEAL_DEV), ...(devSwitch(process.env.VYRE_SEAL_SOFTWARE) ? { software: true } : {}), ...(!isPackaged() && (process.env.VYRE_SEAL_UNATTESTED === "1" || (typeof cfg.standIn === "function" && cfg.standIn() === true)) ? { unattested: true } : {}), ...(process.env.VYRE_SEAL_PROFILE ? { profile: process.env.VYRE_SEAL_PROFILE } : {}) }); ownSealer = true; await sealer.health(); }
    catch (e) { if (sealer) await sealer.close().catch(() => {}); throw new KernelError("key_custody", "the kernel will not start here: its key must live in the sealing process, and the sealing process cannot run safely on this machine (a server with its own OS user, or the OS keystore)", String(e && /** @type {any} */ (e).code || e)); }
  }
  if (sealer) {
    // K-3: no key is held here. The grants store and the chain builder ask the sealing process to MAC and verify (kernel/core/seal.js). A key file from before custody
    // moved only verifies what it already sealed; once that is read a snapshot is written under the new seal and the file is deleted.
    if (fs.existsSync(id.keyFile)) { try { legacyKeys = [Buffer.from(fs.readFileSync(id.keyFile, "utf8").trim(), "hex")]; } catch { /* unreadable: nothing to verify against */ } }
  } else { log("kernel: DEVELOPER file key in use (VYRE_KERNEL_FILE_KEY=1); never the default, never for a real home"); key = fileKernelKey(id.dir); }
  /** The person claimed their identity: its id is the owner's id from now on, written beside the Space's own id so the next start reads it, and said once in the log. */
  /** @type {((to: string, from: string) => Promise<any>) | null} */ let hostedAdopt = null;
  const adoptedOwner = async (/** @type {string} */ to, /** @type {string} */ from) => {
    id.owner = to;
    try { fs.writeFileSync(path.join(id.dir, "space.json"), JSON.stringify({ space: id.space, owner: to, made_at: id.made_at, previous_owner: from }), { mode: 0o600 }); } catch (e) { (cfg.log || (() => {}))(`kernel: the owner's id could not be written beside the Space (${/** @type {Error} */ (e).message}); it will be adopted again at the next start`); }
    (cfg.log || (() => {}))(`kernel: the owner is now the claimed identity ${to} (was ${from}), once`);
    // every Space this home hosts, whose owner is that same person, takes the identity too
    if (hostedAdopt) { try { await hostedAdopt(to, from); } catch (e) { (cfg.log || (() => {}))(`kernel: a hosted Space could not take the claimed identity as its owner (${/** @type {Error} */ (e).message})`); } }
  };
  const personalStore = cfg.storeFor ? await cfg.storeFor(id.space, { owner: id.owner, personal: true }) : undefined;
  // A home whose record store is Twenty (a server, or VYRE_STORE=twenty) never starts on the built-in SQLite store by falling through: bootKernel uses SQLite only when no store was passed, so no store here is a refusal.
  if (cfg.requireStore === true && !personalStore) { if (sealer) await sealer.close().catch(() => {}); throw new KernelError("store_required", "this home's records live in Twenty, and no record store was made for it, so it will not start on the built-in one"); }
  // The home Space's own Drive (kernel/storage/provision.js): chunks encrypted under a pool key from the sealing process, one directory node on this home; other nodes attach later.
  /** @type {any} */ let drive;
  const chatKeys = new ProcessKeys(() => true);   // who may use a chat is decided at the Drive gateway, before a key is touched
  /** @type {any} */ let chatGrants = null;
  if (sealer) {
    try {
      // The Space's own Drive (kernel/storage/provision.js), with a chat's folders stored sealed over it (kernel/storage/sealed-drive.js): the keys are lent to this process by a participant's
      // device (kernel/gateway/chat-keys.js) and live in memory only.
      const base = await provisionDrive({ dir: id.dir, space: id.space, sealer });
      // A project's own files (`Projects/<id>/files/`) are sealed under a key the server derives for that project from the Space's pool key and never stores: access is enforced at the guard (kernel/core/folders.js)
      const pfMaster = base ? await sealer.poolKey({ owner: id.space }) : null;
      const pfKeys = (/** @type {string} */ c) => new Keys(c, new Map([[1, derive(pfMaster, `project-files key ${c}`)]]), derive(pfMaster, `project-files names ${c}`), 1);
      drive = base ? sealedDrive(base, {
        projectFiles: true,
        keysFor: (/** @type {string} */ chat) => { if (chat.startsWith("project-files:")) return pfKeys(chat); const k = chatKeys.get(chat); return k && chatGrants && k.epoch >= chatGrants.chats.epoch(chat) ? k : null; },
        sealed: (/** @type {string} */ chat) => Boolean(chatGrants && chatGrants.chats.epoch(chat) > 0),
        projectKeysFor: (/** @type {string} */ project) => pfKeys(`project-files:${project}`),
      }) : undefined;
      // what was shared to a project is found again after a restart: each project's sealed share index is read back (kernel/storage/sealed-drive.js)
      if (base && drive) for (const f of await base.list("Projects")) { const m = /^Projects\/([^/]+)\/\.shared$/.exec(f.path); if (m) await drive.loadShared(m[1]); }
    } catch (e) { log(`kernel: no Drive on this home (${/** @type {Error} */ (e).message})`); }
  }
  // The inference door (contract 8.4): every model call, and the ledger a reveal records what a person was shown in. Built here, over the sealing process this home runs, with the kernel's own isChain;
  // a caller that passes its own `door` (a test, a stand-in) replaces it. `modelDrivers` is the providers by name (the daemon's), `modelSinks` the services that may call a model as themselves.
  const door = cfg.door || (sealer ? createDoor({ sealer, drivers: cfg.modelDrivers || {}, sinks: cfg.modelSinks || [], isChain, emit: typeof cfg.emitModel === "function" ? cfg.emitModel : () => {} }) : undefined);
  const k = await bootKernel({ db: cfg.db, space: id.space, ...(drive ? { drive, chatKeys } : {}), ...(cfg.presence ? { presence: cfg.presence } : {}), owner: id.owner, owner_uid: process.getuid ? process.getuid() : 0, ...(key ? { key } : {}), legacyKeys, sealer, ...(sealer ? { checkpoints: true } : {}), door, ...(cfg.forwardCredential ? { forwardCredential: cfg.forwardCredential } : {}), ...(cfg.resolveCredential ? { resolveCredential: cfg.resolveCredential } : {}), ...(personalStore ? { store: personalStore } : {}), ...(cfg.basic ? { basic: cfg.basic } : {}), ...(cfg.deviceEnrolled ? { deviceEnrolled: cfg.deviceEnrolled } : {}), ...(cfg.standIn ? { standIn: cfg.standIn } : {}), ...(cfg.runnerHost ? { runnerHost: cfg.runnerHost } : {}), onOwnerAdopted: (/** @type {string} */ to, /** @type {string} */ from) => { const moved = adoptedOwner(to, from); if (typeof cfg.onOwnerAdopted === "function") { try { cfg.onOwnerAdopted(to, from); } catch { /* a listener never stops an adoption */ } } return moved; }, ...(cfg.onStageEnter ? { onStageEnter: cfg.onStageEnter } : {}), ...(cfg.stageTasks ? { stageTasks: cfg.stageTasks } : {}) });
  // BL-2: the restart's checks. The log against the last signed checkpoint, and against the anchor the sealing process keeps outside the database. A packaged build that finds the log
  // rolled back, rewritten or broken does not start: the owner's own `anchor.reset` (a presence-gated act on the sealing process) is the way out after a restore from backup. A development
  // build says so and goes on.
  if (k.boot && !k.boot.ok) {
    const way = k.boot.why && String(k.boot.why).startsWith("anchor_") ? "; after a restore from a backup the owner's anchor.reset (with their presence) lets it start: run `sudo vyre admin anchor-reset` on this server" : "";
    const msg = `the kernel's log does not match what was signed or anchored (${k.boot.why || "broken"})${way}`;
    if (isPackaged(cfg.packageRoot)) { if (ownSealer && sealer) await sealer.close().catch(() => {}); throw new KernelError("log_rolled_back", `the kernel will not start: ${msg}`); }
    log(`kernel: DEVELOPMENT build, starting anyway: ${msg}`);
  }
  if (k.checkpoints) k.checkpoints.start();   // a 60-second timer that never keeps the process alive; a checkpoint when 1,000 events or 10 minutes have passed
  // The migration pass ran inside the rebuild if there was anything to migrate; once the log holds a snapshot under the new seal the old key file has no use.
  if (sealer && legacyKeys.length && k.migrated) { try { fs.rmSync(id.keyFile, { force: true }); } catch { /* the file is harmless now */ } }
  // First party is a signature by the COMPILED release key (lib/release-sig.js), and a counter-signed list of minimum versions the release ships beside it
  // (`<home>/kernel/minimums.json`, written by the updater; never taken from a file that decides the key). There is no fallback to a path rule: a checkout whose modules are
  // not signed (development) must say so with VYRE_KERNEL_PATH_RULE=1, which is loud and never the default. A production kernel without a signature check does not start.
  /** @type {((dir: string) => boolean) | null} */ let firstPartyCheck = cfg.firstPartyCheck || null;
  // Names no added module may ever take, whatever list is in force (even none): the vault, and `leases`, the only caller the vault's service forward accepts (a folder under either name that is not first
  // party is refused, never loaded as an added module).
  const ALWAYS_RESERVED = new Set(["vault", "leases"]);
  /** @type {(name: string) => boolean} */ let reservedName = n => ALWAYS_RESERVED.has(n);
  /** @type {(chain: any, proof: any) => Promise<{ ok: boolean, why?: string }>} */ let resetModulesList = async (/** @type {any} */ _c, /** @type {any} */ _p, /** @type {string} */ _a) => ({ ok: false, why: "no_signed_list" });
  /** What the owner's phone shows and signs to drop the accepted counter (a rollback): the op, the Space and the counter it forgets, with the hash the signer signs. Null when this build has no signed list. @type {() => { op: string, space: string, fields: { counter: number }, payload_hash: string } | null} */
  let modulesListReset = () => null;
  if (!firstPartyCheck) {
    // Module trust follows the build kind (the same gate as the presence stand-in, isPackaged): a development build trusts the modules in the checkout's own folders by path (a checkout
    // has no module.sig), unless VYRE_KERNEL_PATH_RULE=0 or cfg.pathRule === false asks for the signature check; a release build requires the signature and ignores the variable, once in the log.
    const packaged = isPackaged(cfg.packageRoot);
    if (packaged && process.env.VYRE_KERNEL_PATH_RULE === "1") log("kernel: VYRE_KERNEL_PATH_RULE ignored (this is a packaged daemon)");
    const devPathRule = !packaged && cfg.pathRule !== false && process.env.VYRE_KERNEL_PATH_RULE !== "0";
    if (!packaged && (cfg.pathRule === true || devPathRule)) log("kernel: DEVELOPMENT build, first-party modules are trusted by path (VYRE_KERNEL_PATH_RULE=0 asks for the signature check); a release build requires the signature");
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
      const perModule = createFirstPartyCheck({ releaseKey: relKey, minimums });
      // The release's signed list of first-party modules (kernel/modules/release-list.js): SHA256SUMS signed by the release key lists modules.json, which names every shipped module's
      // tree. The highest counter accepted, with the signed material that carried it, is kept in the sealed log and re-verified here, so a rollback or a missing file never relaxes it.
      /** @type {{ counter: number, modules: Record<string, any> } | null} */ let accepted = null;
      const homeActor = `service:home@${id.space}`;
      // Only the home's own chain writes these events (a forged event from another actor is ignored, SG-6), the list in one is re-verified against the release key, and an owner's
      // reset (presence-gated, `resetModulesList` below) forgets everything before it.
      for (const e of k.log.read({ type: "kernel.*" })) {
        if (e.type !== "kernel.modules-list" && e.type !== "kernel.modules-list-reset") continue;
        if (e.actor !== homeActor) { log("kernel: a kernel.modules-list event was not written by the home; ignored"); continue; }
        if (e.type === "kernel.modules-list-reset") { accepted = null; continue; }
        const v = e.data ? verifyRawList(e.data.raw, relKey) : null;
        if (!v) { log("kernel: a kernel.modules-list event does not carry a list the release key signed; ignored"); continue; }
        if (!accepted || v.counter > accepted.counter) accepted = v;
      }
      const root = cfg.packageRoot || PKG_ROOT;
      const cur = readReleaseList(root, relKey);
      let active = accepted;
      if (cur.ok) {
        // SG-5: at EVERY boot (not only when the counter advances), this build's kernel and lib trees are checked against the hashes the release signed. When either differs, the kernel's own
        // code is not the release's, so NO first-party list is in force (not even the last accepted one): only a module carrying its own signature is first party, and the build says why.
        const t = verifyTrees(root, cur);
        const codeChanged = !t.ok && t.bad.some((/** @type {string} */ n) => n === "kernel" || n === "lib");
        if (codeChanged) { log(`kernel: the kernel or lib tree differs from the release's signed hashes (${t.bad.join(", ")}); no first-party module list is in force`); active = null; }
        else if (!accepted || cur.counter >= accepted.counter) {
          active = { counter: cur.counter, modules: cur.modules };
          // SG-3: the counter moves up only after this build's own listed modules verify against the list; a build whose folders were changed never raises it.
          if (!accepted || cur.counter > accepted.counter) {
            if (t.ok) await k.log.append(k.chains.fromFacts({ kind: "module", module: "home", first_party: true }), { type: "kernel.modules-list", sv: 1, subject: `vyre://${id.space}/kernel/modules-list`, data: { counter: cur.counter, raw: cur.raw }, vis: "owner", red: "internal" });
            else log(`kernel: this build's modules do not all match its signed list (${t.bad.join(", ")}); the list counter is not advanced`);
          }
        } else log(`kernel: this build's module list (counter ${cur.counter}) is older than one already accepted (${accepted.counter}); the accepted one stays in force`);
      } else if (accepted && !isPackaged(root)) log(`kernel: ${cur.why}; the last accepted module list stays in force (a development build)`);
      else if (accepted) {
        // SG-5-3: a packaged build whose signed release files are missing, unreadable or badly signed has NO first-party list, the same as a changed tree: the last accepted list is never a fallback
        // (the kernel's own code could have been changed beside them). The daemon still starts so the owner can see it; the accepted names stay reserved.
        active = null;
        log(`kernel: ${cur.why}; no first-party module list is in force (the last accepted list is not used when this build's own signed files cannot be read)`);
      } else log(`kernel: no first-party module list (${cur.why}); only a module carrying its own signature is first party`);
      const listCheck = active ? createListCheck(active, log) : null;
      // SG-1: the signed list decides for every name it contains. A listed name passes by the list alone (an old per-module signature is not an OR with it); a name it does not
      // contain is decided by the per-module signature as before. SG-2: a listed name stays reserved (`reservedName`), so a folder that fails the list is refused, never loaded as an added module.
      const nameOf = (/** @type {string} */ dir) => { try { return String(JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8")).name); } catch { return ""; } };
      const reserved = (/** @type {string} */ n) => ALWAYS_RESERVED.has(n) || Boolean(active && Object.hasOwn(active.modules, n)) || Boolean(accepted && Object.hasOwn(accepted.modules, n));
      reservedName = reserved;
      firstPartyCheck = listCheck ? (/** @type {string} */ dir) => (reserved(nameOf(dir)) ? listCheck(dir) : perModule(dir)) : perModule;
      /** The owner's reset of the counter, for a build older than the one accepted (a deliberate downgrade): presence-gated, one event, and the next boot reads the build's own list. */
      /** The payload to sign: the counter forgotten, and, for the phone route, the id of the ask it answers (so a proof made for one ask never satisfies another, whatever the sealing process remembers). */
      const resetFields = (/** @type {string} */ ask) => ({ counter: accepted ? accepted.counter : 0, ...(ask ? { ask: String(ask) } : {}) });
      modulesListReset = (/** @type {string} */ ask) => { const fields = resetFields(ask); return { op: "grant.modules_list_reset", space: id.space, fields, payload_hash: payloadHash("grant.modules_list_reset", id.space, fields) }; };
      resetModulesList = async (/** @type {any} */ chain, /** @type {any} */ proof, /** @type {string} */ ask) => {
        if (!isExactlyPerson(chain) || chain.hops[0].actor.id !== id.owner) return { ok: false, why: "owner_only" };
        const why = !sealer ? "no_presence_verifier" : await sealerPresence(sealer).check({ chain, op: "grant.modules_list_reset", fields: resetFields(ask), proof });
        if (why) return { ok: false, why };
        await k.log.append(k.chains.fromFacts({ kind: "module", module: "home", first_party: true }), { type: "kernel.modules-list-reset", sv: 1, subject: `vyre://${id.space}/kernel/modules-list`, data: { from: accepted ? accepted.counter : 0 }, vis: "owner", red: "internal" });
        return { ok: true };
      };
    }
  }
  // The command line's sign-in (`vyre signin`): the owner's phone signs this and the daemon then gives that one terminal a person session. The terminal is named by a hash of the login key the daemon
  // measured (never a label or anything the caller sends), so a proof made for one terminal's ask never satisfies another's. The sealing process checks and uses the proof like any other grant act.
  const cliSigninFields = (/** @type {string} */ ask, /** @type {string} */ terminal) => ({ ask: String(ask), terminal: crypto.createHash("sha256").update(String(terminal)).digest("hex").slice(0, 32) });
  const cliSigninPayload = (/** @type {string} */ ask, /** @type {string} */ terminal) => { const fields = cliSigninFields(ask, terminal); return { op: "grant.cli_signin", space: id.space, fields, payload_hash: payloadHash("grant.cli_signin", id.space, fields) }; };
  const cliSigninCheck = async (/** @type {any} */ chain, /** @type {any} */ proof, /** @type {string} */ ask, /** @type {string} */ terminal) => {
    if (!isExactlyPerson(chain) || chain.hops[0].actor.id !== id.owner) return { ok: false, why: "owner_only" };
    const why = !sealer ? "no_presence_verifier" : await sealerPresence(sealer).check({ chain, op: "grant.cli_signin", fields: cliSigninFields(ask, terminal), proof });
    return why ? { ok: false, why } : { ok: true };
  };
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
  const audit = (/** @type {string} */ type, /** @type {any} */ data) => k.log.append(k.chains.fromFacts({ kind: "module", module: "home", first_party: true }), { type, sv: 1, subject: `vyre://${id.space}/space/${data.space}`, data, vis: "owner", red: "internal" });
  const spaces = createSpaceKernels({ root: cfg.root, audit, ...(cfg.basic ? { basic: cfg.basic } : {}), personal: { space: id.space, kernel: k }, openDb: (/** @type {string} */ f) => new DatabaseSync(f), ...(cfg.stageFactory ? { stageFactory: cfg.stageFactory } : {}), ...(sealer ? { sealer } : { fileKey: true }), ...(door ? { doorFor: () => door } : {}), ...(cfg.storeFor ? { storeFor: cfg.storeFor } : {}), ...(cfg.standIn || cfg.resolveCredential ? { bootOptions: { ...(cfg.standIn ? { standIn: cfg.standIn } : {}), ...(cfg.resolveCredential ? { resolveCredential: cfg.resolveCredential } : {}) } } : {}), ...(cfg.remote ? { remote: cfg.remote } : {}) });
  await spaces.start();
  chatGrants = k.gateway && k.gateway.grants ? k.gateway.grants : null;
  hostedAdopt = (to, from) => spaces.adoptOwner(to, from);
  // at every start: the home's adoption (the log) reaches the Spaces it hosts, including ones made before the claim or cut short by a restart
  { const ad = typeof k.grants.adopted === "function" ? k.grants.adopted() : null; if (ad) { try { await spaces.adoptOwner(ad.to, ad.from); } catch (e) { (cfg.log || (() => {}))(`kernel: a hosted Space could not take the claimed identity as its owner (${/** @type {Error} */ (e).message})`); } } }
  // R031-83: a Space restored from a bundle (lib/space-bundle.js) leaves its grants in kernel/restore.json: they go onto this Space once, under this seal, and the log says so (the old log is not carried, only its head)
  { const rf = path.join(cfg.root, "kernel", "restore.json"); let r = null; try { r = JSON.parse(fs.readFileSync(rf, "utf8")); } catch { /* no restore waiting */ }
    if (r && r.grants) { await k.grants.adopt(r.grants); k.log.append(k.chains.fromFacts({ kind: "module", module: "home", first_party: true }), { type: "space.restored", sv: 1, subject: `vyre://${id.space}/space/${id.space}`, data: { head: r.head, bundle_hash: r.bundle_hash }, vis: "owner", red: "internal" }); fs.rmSync(rf, { force: true }); } }
  return Object.freeze({ ...k, spaces, sealer, id: Object.freeze({ space: id.space, get owner() { return id.owner; } }), kernelFor: k.kernelFor, firstPartyCheck, reservedName, resetModulesList, cliSigninPayload, cliSigninCheck, get modulesListReset() { return modulesListReset; }, moduleHost: host, supervisor, moduleApprovals: approvals, stop: async () => { await spaces.stop(); await supervisor.stopAll(); if (ownSealer && sealer) await sealer.close(); } });
}
