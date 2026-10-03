// kernel/index.js: the composition root. `createKernel` wires one Space's kernel from safe defaults, so no consumer and no test rig assembles the parts by
// hand: the event log, the store, the chain builder, the grants store (or the caller's own grants and members, for the retrofit path), the limits, the
// tasks, the rule evaluator (kernel/expr), the sealing client and the door when given, and the gateway over them. A part the caller passes replaces its
// default; nothing is left unwired that would make a decision fail open (no evaluator means the kernel's own, not none).
//
//   const k = createKernel({ space, owner: "per_owner", owner_uid: process.getuid(), key });          // in memory, a first owner, everything wired
//   const k = createKernel({ space, ..., store, log, grants: { forSubject, get }, members: { has } }); // your own store, log or grants (a test rig)
//   k.gateway.records / .events / .grants / .seal / .audit / .tasks   k.chains.fromFacts(...)   k.log   k.store   k.limits
import { createGateway } from "./gateway/index.js";
import { createMemoryStore } from "./store/memory.js";
import { createEventLog } from "./core/events.js";
import { createChainBuilder, isExactlyPerson } from "./core/chain.js";
import { createGrantsStore } from "./grants/index.js";
import { createLimits } from "./core/limits.js";
import { createTasks } from "./tasks/tasks.js";
import { sealerPresence } from "./core/presence.js";
import { expr as defaultExpr } from "./expr/index.js";
import { createSurfaces } from "./core/surfaces.js";
import { runnerPorts } from "./gateway/runner-ports.js";

/**
 * @param {{ space: string, owner: string, owner_uid: number, key: Uint8Array | string, clock?: () => number,
 *   legacyKeys?: (Uint8Array | string)[], store?: any, log?: any, chains?: any, grantsStore?: any, grants?: any, members?: any, bootstrap?: boolean, presence?: any, sealer?: any, door?: any,
 *   expr?: any, hasPresenceSession?: (chain: any) => boolean, onStageEnter?: any, stageTasks?: any, checkpointKey?: any,
 *   drive?: any, resolveCredential?: any, routeAction?: any, templates?: any, destinations?: any, resolve?: any, actions?: any[], attrs?: any, sinks?: Set<string> }} cfg
 *   grants and members together replace the grants store (the retrofit path and test rigs); otherwise a grants store is made and, on an empty log, its first owner
 */
export function createKernel(cfg) {
  const clock = cfg.clock || Date.now;
  const log = cfg.log || createEventLog({ space: cfg.space, clock });
  const store = cfg.store || createMemoryStore({ clock });
  const chains = cfg.chains || createChainBuilder({ space: cfg.space, owner: cfg.owner, owner_uid: cfg.owner_uid, key: cfg.key, clock, is_person: () => true });
  const own = Boolean(cfg.grants && cfg.members);
  const grantsStore = own ? undefined : cfg.grantsStore || createGrantsStore({ legacyKeys: cfg.legacyKeys, space: cfg.space, log, chains, key: cfg.key, clock, presence: cfg.presence || (cfg.sealer ? sealerPresence(cfg.sealer) : undefined) });
  const presence = cfg.presence || (cfg.sealer ? sealerPresence(cfg.sealer) : undefined);
  const limits = createLimits({ space: cfg.space, log, clock });
  let fresh = false;
  if (grantsStore && cfg.bootstrap !== false) { if (log.latestSeq() === 0) { grantsStore.bootstrap({ owner: cfg.owner }); fresh = true; } else { grantsStore.rebuild(); limits.rebuild(); } }
  // A presence session (the person signed in with their passkey on this device) stands for admin acts only for a chain that is exactly one person.
  const hasPresenceSession = cfg.hasPresenceSession || ((/** @type {any} */ chain) => isExactlyPerson(chain) && Boolean(chain.hops[0].via && chain.hops[0].via.session));
  /** @type {any} */ let gateway;
  const members = grantsStore ? grantsStore.members : cfg.members;
  const tasks = createTasks({
    space: cfg.space, log, chains, clock, presence: presence || { check: async () => "no_presence_verifier" }, members: { has: (/** @type {any} */ a) => members.has(a) },
    authorizer: { authorize: (/** @type {any} */ i) => gateway.authorize(i), get actions() { return gateway.registry; } },
    approver: () => ({ kind: "person", id: cfg.owner, space: cfg.space }), resolve: cfg.resolve, enforce: (/** @type {any} */ c, /** @type {any} */ d) => limits.enforce(c, d),
  });
  gateway = createGateway({
    space: cfg.space, store, log, chains, clock, limits, tasks, approvedAct: (/** @type {any} */ q) => tasks.useApproval(q), owner: cfg.owner, presence, hasPresenceSession, expr: cfg.expr === undefined ? defaultExpr : cfg.expr,
    ...(grantsStore ? { grantsStore } : { grants: cfg.grants, members: cfg.members }),
    sealer: cfg.sealer, door: cfg.door, onStageEnter: cfg.onStageEnter, stageTasks: cfg.stageTasks, checkpointKey: cfg.checkpointKey, templates: cfg.templates, destinations: cfg.destinations,
    actions: cfg.actions, attrs: cfg.attrs, sinks: cfg.sinks, drive: cfg.drive, resolveCredential: cfg.resolveCredential, routeAction: cfg.routeAction,
  });
  const surfaces = createSurfaces({ space: cfg.space, chains, key: cfg.key, door: cfg.door, clock });
  /**
   * `ctx.kernel` for one first-party module (the registry calls this when it builds the module's context): the gateway's own surfaces, bound to this Space, and the
   * module's own service chain. A module declares what it needs under `needs.kernel` ({ actions, prefixes, types }) and is given exactly that: grants whose source is
   * `install:<module>`, and the record types it declared, defined by the kernel itself (a kernel act at install, not a call a module can make). With nothing declared it
   * is a service of the Space that can do nothing. `chain(meta)` is the Surfaces door's chain for a call that carries a session token, else the module's own service
   * chain: a module never builds a chain. Record calls wait for the module's types to be defined.
   * @param {any} m the module's manifest
   */
  const kernelFor = (/** @type {any} */ m) => {
    if (!grantsStore) throw new Error("ctx.kernel needs the kernel's own grants store");
    const needs = (m.needs && m.needs.kernel) || { actions: [] };
    grantsStore.installModule(m.name, { actions: Array.isArray(needs.actions) ? needs.actions : [], prefixes: Array.isArray(needs.prefixes) ? needs.prefixes : undefined });
    const ready = Array.isArray(needs.types) && needs.types.length ? store.define({ add_types: needs.types }) : Promise.resolve();
    const records = new Proxy(gateway.records, { get: (t, k) => (typeof t[k] === "function" ? async (/** @type {any[]} */ ...a) => { await ready; return t[k](...a); } : t[k]) });
    return Object.freeze({
      space: cfg.space, records, events: gateway.events, grants: gateway.grants, tasks: gateway.ask, audit: gateway.audit, authorize: gateway.authorize, limits: gateway.limits,
      model: surfaces.model,
      leases: gateway.leases, drive: gateway.drive,
      /** The runner's ports from the kernel's own pieces (see kernel/gateway/runner-ports.js): allowed, revocation and the device key are the kernel's. */
      runnerPorts: (/** @type {any} */ o) => runnerPorts({ leases: gateway.leases, offers: gateway.grants && gateway.grants.offers }, o),
      serviceChain: () => gateway.serviceChain(m.name),
      chain: (/** @type {any} */ meta) => (meta && typeof meta.token === "string" ? surfaces.chainFor(meta.token) : gateway.serviceChain(m.name)),
    });
  };
  return Object.freeze({ gateway, log, store, chains, grants: grantsStore, limits, tasks, surfaces, kernelFor, fresh });
}
