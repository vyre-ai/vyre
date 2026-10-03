// kernel/boot.js: assembles one Space's kernel on the home (hot data in the home's SQLite): the durable event log, the durable store, the grants store
// rebuilt from the log, the limits, tasks and the gateway over them. It is what the daemon calls when the kernel is on (the default-on path in
// team/0.3/KERNEL-default-on.md); until then nothing calls it. Nothing here holds authority: it wires the pieces and hands back the gateway.
import { createGateway } from "./gateway/index.js";
import { createSqliteStore } from "./store/sqlite.js";
import { createSqliteEventLog } from "./store/sqlite-log.js";
import { createGrantsStore } from "./grants/index.js";
import { createLimits } from "./core/limits.js";
import { createChainBuilder } from "./core/chain.js";
import { createTasks } from "./tasks/tasks.js";
import { sealerPresence } from "./core/presence.js";
import { isExactlyPerson } from "./core/chain.js";

/**
 * @param {{ db: import("node:sqlite").DatabaseSync, space: string, owner: string, owner_uid: number, key: Uint8Array | string, clock?: () => number,
 *   hasPresenceSession?: (chain: any) => boolean, sealer?: any, door?: any, expr?: any, onStageEnter?: any, checkpointKey?: any, templates?: any, destinations?: any, resolve?: any }} cfg
 *   key: the kernel's secret (seals stored chains and the grants store's events); owner: the person id of the Space's first owner
 */
export function bootKernel(cfg) {
  const clock = cfg.clock || Date.now;
  const log = createSqliteEventLog({ db: cfg.db, space: cfg.space, clock });
  const store = createSqliteStore({ db: cfg.db, clock });
  const chains = createChainBuilder({ space: cfg.space, owner: cfg.owner, owner_uid: cfg.owner_uid, key: cfg.key, clock, is_person: () => true });
  const grantsStore = createGrantsStore({ space: cfg.space, log, chains, key: cfg.key, clock });
  const presence = cfg.sealer ? sealerPresence(cfg.sealer) : undefined;
  const limits = createLimits({ space: cfg.space, log, clock });
  /** @type {any} */ let gateway;
  let fresh = false;
  // A first start makes the first owner; a restart rebuilds every grant, member, offer, once-mark, meter and rate window from the log.
  if (log.latestSeq() === 0) { grantsStore.bootstrap({ owner: cfg.owner }); fresh = true; } else { grantsStore.rebuild(); limits.rebuild(); }
  /** @type {any} */ let tasks;
  const gw = () => gateway;
  tasks = createTasks({ space: cfg.space, authorizer: { authorize: (/** @type {any} */ i) => gw().authorize(i), get actions() { return gw().registry; } }, log, presence: presence || { check: async () => "no_presence_verifier" }, chains, clock, members: { has: (/** @type {any} */ a) => grantsStore.members.has(a) }, approver: () => ({ kind: "person", id: cfg.owner, space: cfg.space }), resolve: cfg.resolve, enforce: (/** @type {any} */ c, /** @type {any} */ d) => limits.enforce(c, d) });
  // A presence session (the person signed in with their passkey on this device) stands for admin acts only for a chain that is exactly one person.
  const hasPresenceSession = cfg.hasPresenceSession || ((/** @type {any} */ chain) => isExactlyPerson(chain) && Boolean(chain.hops[0].via && chain.hops[0].via.session));
  gateway = createGateway({ hasPresenceSession, space: cfg.space, store, log, chains, clock, grantsStore, presence, limits, tasks, owner: cfg.owner, sealer: cfg.sealer, door: cfg.door, expr: cfg.expr, onStageEnter: cfg.onStageEnter, checkpointKey: cfg.checkpointKey, templates: cfg.templates, destinations: cfg.destinations });
  return Object.freeze({ gateway, log, store, chains, grants: grantsStore, limits, tasks, fresh });
}
