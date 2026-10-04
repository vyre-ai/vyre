// kernel/spaces/index.js: one kernel per Space on a home, and `for(spaceId)` to reach any Space the same way. A home hosts several Spaces: the first is the personal
// one (the home's own kernel, `kernel/space.json`), each other is its own directory under `kernel/spaces/<id>/` with its own SQLite store and log, its own kernel key
// (so its grants MACs and tokens verify nowhere else) and its own sealing namespace (`sealerFor(spaceId)`), each booted through `bootKernel`. A Space this home does not
// host is reached through `remote(spaceId)`: a RemoteKernel over the transport port (kernel/remote), with the same gateway API, so a caller does not care where it lives.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bootKernel } from "../boot.js";
import { KernelError } from "../core/errors.js";
import { namespaced } from "./namespace.js";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rand32 = (/** @type {number} */ n) => Array.from(crypto.randomBytes(n), b => B32[b & 31]).join("");
const SPACE_ID = /^spc_[a-z2-7]{12}$/;

/** The handle `for` returns, hosted or remote: the same gateway and Surfaces door. @param {string} space @param {any} k */
const hostedHandle = (space, k) => Object.freeze({ space, hosted: true, gateway: k.gateway, surfaces: k.surfaces, kernel: k });

/**
 * @param {{ root: string, personal: { space: string, kernel: any }, openDb: (file: string) => import("node:sqlite").DatabaseSync, boot?: (cfg: any) => any,
 *   sealer?: any, fileKey?: boolean, doorFor?: (space: string) => any, storeFor?: (space: string, meta: any) => Promise<any> | any, stageFactory?: (space: string, kernel: any, meta: any) => Promise<any> | any, remote?: (space: string) => any, bootOptions?: Record<string, any>, clock?: () => number }} cfg
 *   `personal` is the home's own, already booted kernel (bootHomeKernel's), so the first Space is never booted twice. `sealer` is the home's sealing client: each Space gets
 *   it namespaced (K-3), and no key file is kept. Without it a Space is refused unless `fileKey` is true (development and tests: a 0600 key file per Space).
 */
export function createSpaceKernels(cfg) {
  const dir = path.join(cfg.root, "kernel", "spaces");
  const boot = cfg.boot || bootKernel;
  /** @type {Map<string, any>} */ const live = new Map([[cfg.personal.space, cfg.personal.kernel]]);
  /** @type {Map<string, any>} */ const remotes = new Map();
  const ofDir = (/** @type {string} */ id) => path.join(dir, id);
  const tell = (/** @type {any} */ k) => { if (typeof k.bindSpaces === "function") k.bindSpaces(api); return k; };

  async function open(/** @type {string} */ id) {
    const d = ofDir(id), f = path.join(d, "space.json"), kf = path.join(d, "kernel.key");
    let meta; try { meta = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
    if (!meta || meta.space !== id) return null;
    /** @type {Record<string, any>} */ let custody;
    if (cfg.sealer) custody = { sealer: namespaced(cfg.sealer, id) };
    else if (cfg.fileKey === true) {
      if (!fs.existsSync(kf)) return null;
      const key = Buffer.from(fs.readFileSync(kf, "utf8").trim(), "hex");
      if (key.length !== 32) throw new KernelError("unavailable", "that Space's kernel key is not 32 bytes: refusing to start it");
      custody = { key };
    } else throw new KernelError("key_custody", "a hosted Space's kernel key must live in the sealing process: give the registry the home's sealer");
    const store = cfg.storeFor ? await cfg.storeFor(id, meta) : undefined;
    // Stages made of tasks for this Space (the daemon's stageFactory builds the module over this Space's own kernel): the gateway's two hooks are bound late, because the module needs the booted kernel.
    /** @type {{ stages: any }} */ const late = { stages: null };
    const hooks = cfg.stageFactory ? { onStageEnter: (/** @type {any} */ e) => (late.stages ? late.stages.onStageEnter(e) : Promise.resolve()), stageTasks: (/** @type {string} */ u, /** @type {string} */ st) => (late.stages ? late.stages.stageTasks(u, st) : []) } : {};
    const booted = tell(await boot({ db: cfg.openDb(path.join(d, "kernel.db")), space: id, ...hooks, owner: meta.owner, ...(store ? { store } : {}), owner_uid: process.getuid ? process.getuid() : 0, ...custody, clock: cfg.clock,
      ...(cfg.doorFor ? { door: cfg.doorFor(id) } : {}), ...(cfg.bootOptions || {}) }));
    if (cfg.stageFactory) late.stages = await cfg.stageFactory(id, booted, meta);
    return booted;
  }

  const api = {
    /** The Space ids this home hosts, the personal one first. */
    list() {
      let more = []; try { more = fs.readdirSync(dir).filter(n => SPACE_ID.test(n) && !live.has(n)).sort(); } catch { /* none yet */ }
      return [cfg.personal.space, ...[...live.keys()].filter(n => n !== cfg.personal.space), ...more];
    },
    hosts: (/** @type {string} */ id) => live.has(id) || (SPACE_ID.test(id) && fs.existsSync(path.join(ofDir(id), "space.json"))),
    /**
     * Start hosting a new Space for `owner` (a person id): its own directory, key, store, log and sealing namespace. A first start makes the first owner once.
     * @param {{ owner: string, name?: string }} o @returns the hosted handle
     */
    async host(o) {
      if (!o || typeof o.owner !== "string" || !/^per_[a-z2-7]{26}$/.test(o.owner)) throw new KernelError("bad_input", "a Space is hosted for one first owner (a person id)");
      // `id` lets a creation that was retired (a failed or cancelled spaces.create) be hosted again under the SAME id when the person resumes it; it must be well formed and not live or on disk.
      if (o.id !== undefined && (typeof o.id !== "string" || !SPACE_ID.test(o.id) || live.has(o.id) || fs.existsSync(ofDir(o.id)))) throw new KernelError("bad_input", "that Space id cannot be used");
      const id = o.id !== undefined ? o.id : `spc_${rand32(12)}`, d = ofDir(id);
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      if (!cfg.sealer) { if (cfg.fileKey !== true) throw new KernelError("key_custody", "a hosted Space's kernel key must live in the sealing process: give the registry the home's sealer"); fs.writeFileSync(path.join(d, "kernel.key"), crypto.randomBytes(32).toString("hex"), { mode: 0o600 }); }
      fs.writeFileSync(path.join(d, "space.json"), JSON.stringify({ space: id, owner: o.owner, ...(o.name ? { name: String(o.name).slice(0, 80) } : {}), ...(o.accept_builtin_store === true ? { accept_builtin_store: true } : {}), made_at: (cfg.clock || Date.now)() }), { mode: 0o600 });
      // a Space that cannot be opened (the box cannot run its store and the person has not agreed to the built-in one) is not left half made
      let k;
      try { k = await open(id); } catch (e) { fs.rmSync(d, { recursive: true, force: true }); throw e; }
      live.set(id, k);
      return hostedHandle(id, k);
    },
    /**
     * Take back a Space that was only started (a failed or cancelled create): stop its kernel, remove its folder (key, store, log) and forget it. Refused for the personal Space and for a Space that
     * has anything in it beyond its first owner (a record, a task, a chat, an invite, an offer, another member): that is somebody's data and is never deleted here.
     * @param {string} id @returns {Promise<{ retired: boolean }>}
     */
    async retire(id) {
      if (id === cfg.personal.space) throw new KernelError("not_allowed", "the personal Space is never retired");
      if (!SPACE_ID.test(id)) throw new KernelError("bad_input", "not a Space id");
      const d = ofDir(id);
      let k = live.get(id);
      if (!k && !fs.existsSync(d)) return { retired: false };
      if (!k) { k = await open(id); if (k) live.set(id, k); }
      if (k && k.log && typeof k.log.read === "function") {
        const owner = (() => { try { return JSON.parse(fs.readFileSync(path.join(d, "space.json"), "utf8")).owner; } catch { return null; } })();
        for (const e of k.log.read({})) {
          const t = String(e.type);
          const other = t === "member.set" && e.data && e.data.membership && e.data.membership.person !== owner && e.data.membership.role !== "owner";
          if (/^(record|task|chat|invite|offer)\./.test(t) || other) throw new KernelError("not_allowed", "that Space has content and is not retired");
        }
      }
      live.delete(id);
      if (k && typeof k.stop === "function") await k.stop();
      fs.rmSync(d, { recursive: true, force: true });
      return { retired: true };
    },
    /** What a Space made here now would be stored in, and the confirmation to show BEFORE it is made (`confirm`: text and choices). Nothing is created. */
    storePlan: () => (cfg.storeFor && /** @type {any} */ (cfg.storeFor).plan ? /** @type {any} */ (cfg.storeFor).plan() : Promise.resolve({ store: "sqlite", reasons: [] })),
    /** Open every Space this home hosts (at start); after this `for` answers without waiting. */
    async start() { for (const id of api.list()) await api.open(id); },
    /** Open one hosted Space, or null when this home does not host it. */
    async open(/** @type {string} */ id) {
      if (!live.has(id)) { if (!SPACE_ID.test(id)) return null; const k = await open(id); if (!k) return null; live.set(id, k); }
      return hostedHandle(id, live.get(id));
    },
    /** The kernel this home hosts for a Space and has open, or null. */
    hosted: (/** @type {string} */ id) => (live.has(id) ? hostedHandle(id, live.get(id)) : null),
    /** `ctx.kernel.for(spaceId)`: this home's own kernel when it hosts the Space, else a remote client over the transport port. Same gateway either way. */
    for(/** @type {string} */ id) {
      if (typeof id !== "string") throw new KernelError("bad_input", "name a Space");
      const here = api.hosted(id);
      if (here) return here;
      let r = remotes.get(id);
      if (!r && cfg.remote) { r = cfg.remote(id); if (r) remotes.set(id, r); }
      if (!r) throw new KernelError("not_found", "no such Space");
      return r;
    },
    /** Stop the kernels this home opened itself (never the personal one, which the daemon owns). */
    async stop() { for (const [id, k] of live) if (id !== cfg.personal.space && k && typeof k.stop === "function") await k.stop(); },
  };
  tell(cfg.personal.kernel);
  return Object.freeze(api);
}
