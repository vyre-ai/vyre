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
import { KernelError } from "./core/errors.js";
import { createSurfaces } from "./core/surfaces.js";
import { proofFrom, proofRequest } from "./remote/proof.js";
import { createKernelSeal } from "./core/seal.js";
import { runnerPorts } from "./gateway/runner-ports.js";

/**
 * @param {{ space: string, owner: string, owner_uid: number, key?: Uint8Array | string, seal?: any, label?: () => { name?: string, words?: string }, clock?: () => number,
 *   legacyKeys?: (Uint8Array | string)[], store?: any, log?: any, chains?: any, grantsStore?: any, grants?: any, members?: any, bootstrap?: boolean, presence?: any, sealer?: any, door?: any,
 *   expr?: any, hasPresenceSession?: (chain: any) => boolean, onStageEnter?: any, stageTasks?: any, checkpointKey?: any,
 *   drive?: any, resolveCredential?: any, routeAction?: any, templates?: any, destinations?: any, resolve?: any, actions?: any[], attrs?: any, sinks?: Set<string> }} cfg
 *   grants and members together replace the grants store (the retrofit path and test rigs); otherwise a grants store is made and, on an empty log, its first owner
 */
export async function createKernel(cfg) {
  const clock = cfg.clock || Date.now;
  const log = cfg.log || createEventLog({ space: cfg.space, clock });
  const store = cfg.store || createMemoryStore({ clock });
  // The one sealing handle (K-3): the sealing process when there is one, a development key when there is not. Only the chain builder and the grants store are given it.
  const seal = cfg.seal || createKernelSeal({ sealer: cfg.sealer, key: cfg.key });
  const chains = cfg.chains || createChainBuilder({ space: cfg.space, owner: cfg.owner, owner_uid: cfg.owner_uid, seal, clock, is_person: () => true });
  const own = Boolean(cfg.grants && cfg.members);
  const grantsStore = own ? undefined : cfg.grantsStore || createGrantsStore({ legacyKeys: cfg.legacyKeys, space: cfg.space, log, chains, seal, clock, presence: cfg.presence || (cfg.sealer ? sealerPresence(cfg.sealer) : undefined), label: cfg.label });
  const presence = cfg.presence || (cfg.sealer ? sealerPresence(cfg.sealer) : undefined);
  const limits = createLimits({ space: cfg.space, log, clock });
  let fresh = false, migrated = false;
  if (grantsStore && cfg.bootstrap !== false) { if (log.latestSeq() === 0) { await grantsStore.bootstrap({ owner: cfg.owner }); fresh = true; } else { migrated = (await grantsStore.rebuild()).migrated; limits.rebuild(); } }
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
  const surfaces = createSurfaces({ space: cfg.space, chains, door: cfg.door, clock, isAdmin: (/** @type {string} */ id) => Boolean(grantsStore && grantsStore.isAdmin({ kind: "person", id, space: cfg.space })) });
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
    // Only a module that declared `needs.kernel` is made a service of the Space (one sealed event each); the rest get a handle that can do nothing.
    const installed = m.needs && m.needs.kernel ? grantsStore.installModule(m.name, { actions: Array.isArray(needs.actions) ? needs.actions : [], prefixes: Array.isArray(needs.prefixes) ? needs.prefixes : undefined }) : Promise.resolve();
    const ready = Promise.all([installed, Array.isArray(needs.types) && needs.types.length ? store.define({ add_types: needs.types }) : Promise.resolve()]);
    // A failure here (the sealing process went away) surfaces on the module's first call, not as an unhandled rejection nobody can catch.
    ready.catch(() => {});
    const records = new Proxy(gateway.records, { get: (t, k) => (typeof t[k] === "function" ? async (/** @type {any[]} */ ...a) => { await ready; return t[k](...a); } : t[k]) });
    return Object.freeze({
      space: cfg.space, records, events: gateway.events, grants: gateway.grants, tasks: gateway.ask, audit: gateway.audit, authorize: gateway.authorize, limits: gateway.limits,
      model: surfaces.model,
      /** The `{ presence }` option from what a surface sent beside the request (`meta.kernel_proof`), and what that surface must sign for a grants call. The kernel's verifier checks it. */
      /** Any Space by id: this one, another this home hosts, or a remote client with the same gateway API (the chain argument carries no authority across). */
      for: (/** @type {string} */ id) => (id === cfg.space ? Object.freeze({ space: cfg.space, hosted: true, gateway, surfaces }) : spaces ? spaces.for(id) : (() => { throw new KernelError("unavailable", "this kernel has no Spaces registry"); })()),
      proofFrom, proofRequest: (/** @type {string} */ call, /** @type {any[]} */ ...a) => proofRequest(cfg.space, call, ...a),
      leases: gateway.leases, drive: gateway.drive,
      /** The runner's ports from the kernel's own pieces (see kernel/gateway/runner-ports.js): allowed, revocation and the device key are the kernel's. */
      runnerPorts: (/** @type {any} */ o) => runnerPorts({ leases: gateway.leases, offers: gateway.grants && gateway.grants.offers }, o),
      serviceChain: () => gateway.serviceChain(m.name),
      chain: async (/** @type {any} */ meta) => (meta && typeof meta.token === "string" ? surfaces.chainFor(meta.token) : (await ready, gateway.serviceChain(m.name))),
    });
  };
  /** The home's registry of Spaces (kernel/spaces), set once by it: `ctx.kernel.for(id)` reaches any Space, hosted here or remote, through the same gateway. */
  /** @type {any} */ let spaces = null;
  const bindSpaces = (/** @type {any} */ reg) => { spaces = reg; };
  return Object.freeze({ gateway, log, store, chains, grants: grantsStore, limits, tasks, surfaces, kernelFor, bindSpaces, fresh, migrated });
}
