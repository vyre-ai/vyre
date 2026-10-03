// kernel/gateway/index.js: assembles the K2 gateway: authorize, records, grants-lite, events and audit over one store.
import { createAuthorizer } from "../core/authorize.js";
import { createRecords, RECORD_ACTIONS } from "./records.js";
import { createSealing } from "./sealing.js";
import { ACTIONS as SEAL_ACTIONS } from "../seal/uses.js";
import { TASK_ACTIONS } from "../tasks/tasks.js";
import { createApprovals } from "../tasks/approvals.js";
import { createGate } from "../core/gate.js";
import { GRANT_ACTIONS } from "../grants/index.js";
import { createLimits } from "../core/limits.js";
import { verifyLog } from "../audit/index.js";
import { createLeases } from "./leases.js";
import { grantProofVerifier } from "../core/presence.js";
import { isChain, actorString, isExactlyPerson } from "../core/chain.js";
import { KernelError } from "../core/errors.js";

/**
 * @param {{ expr?: any, stageTasks?: any, onStageEnter?: any, limits?: any, grantsStore?: any, presence?: any, tasks?: any, sealer?: any, door?: any, approvals?: any, templates?: any, destinations?: any, owner?: string, space: string, store: any, log: any, chains: any, grants: any, members: any, actions?: any[], attrs?: any, sealedFields?: any,
 *   sinks?: Set<string>, standing?: any, verifyPresence?: any, hasPresenceSession?: any, clock?: () => number, policy_version?: number }} cfg
 */
export function createGateway(cfg) {
  if (cfg.door && cfg.door.usesKernelChain !== true) throw new KernelError("bad_input", "the door must be built with the kernel's own isChain");
  const limits = cfg.limits || createLimits({ space: cfg.space, log: cfg.log, clock: cfg.clock });
  const enforce = (/** @type {any} */ chain, /** @type {any} */ d) => limits.enforce(chain, d);
  /** @type {any} */ let records;
  // Kernel attributes come from the gateway's own index (K2-7); a caller-supplied resolver only fills what the gateway does not hold.
  const attrs = (/** @type {string} */ u) => ({ ...((cfg.attrs && cfg.attrs(u)) || {}), ...((records && records.attrsOf(u)) || {}) });
  // `authorize` reads grants and members from the kernel's grants store when one is given; otherwise from the caller (the retrofit path).
  const gs = cfg.grantsStore;
  const wiring = gs ? { grants: gs.provider, members: gs.members, ...(cfg.presence ? { verifyPresence: grantProofVerifier(cfg.presence) } : {}) } : {};
  const authorizer = createAuthorizer({ ...cfg, ...wiring, attrs, actions: [...RECORD_ACTIONS, ...SEAL_ACTIONS, ...TASK_ACTIONS, ...GRANT_ACTIONS, ...(cfg.actions || [])] });
  if (gs) gs.bind({ enforce, authorizer, registry: () => authorizer.actions });
  records = createRecords({ expr: cfg.expr, stageTasks: cfg.stageTasks, onStageEnter: cfg.onStageEnter, enforce, members: wiring.members || cfg.members, space: cfg.space, store: cfg.store, authorizer, log: cfg.log, chains: cfg.chains, clock: cfg.clock, sinks: cfg.sinks });
  const { allowed, gate } = createGate({ authorizer, log: cfg.log, enforce });

  /** May this chain see this event? `events.read` on the subject, then the event's own `vis` (contract 7.4). Anything unknown is no. */
  async function canSee(/** @type {any} */ chain, /** @type {any} */ e) {
    if (!(await allowed(chain, "events.read", e.subject))) return false;
    const vis = e.vis;
    if (vis === "space") return true;
    if (vis === "subject") return allowed(chain, "records.read", e.subject);
    const mem = wiring.members || cfg.members;
    const owner = isExactlyPerson(chain) && cfg.owner !== undefined && chain.hops[0].actor.id === cfg.owner;
    if (vis === "owner") return owner;
    if (vis === "actor") return owner || chain.hops.some((/** @type {any} */ h) => actorString(h.actor) === e.actor);
    if (typeof vis === "string" && vis.startsWith("members:")) {
      const role = vis.slice(8);
      return chain.hops.some((/** @type {any} */ h) => h.actor.kind === "person" && mem.membership && mem.membership(h.actor)?.role === role);
    }
    return false;
  }

  /** The log through `authorize`: events the chain may not read are absent, never marked. */
  async function read(/** @type {any} */ chain, /** @type {any} */ filter = {}) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    const { limit, ...rest } = filter;
    const out = [];
    for (const e of cfg.log.read(rest)) { if (await canSee(chain, e)) out.push(await records.viewEvent(chain, e)); if (limit && out.length >= limit) break; }
    return out;
  }

  /** A consumer name belongs to the actor that first used it; every delivered event is checked the way `read` checks it. */
  function subscribe(/** @type {any} */ chain, /** @type {string} */ consumer, /** @type {any} */ filter, /** @type {(e: any) => any} */ onEvent) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    const name = `${actorString(chain.hops[chain.hops.length - 1].actor)}:${consumer}`;
    return cfg.log.subscribe(name, filter, async (/** @type {any} */ e) => { if (await canSee(chain, e)) await onEvent(await records.viewEvent(chain, e)); });
  }

  const seal = cfg.sealer ? createSealing({ enforce, clock: cfg.clock, approval_max_age: cfg.approval_max_age, space: cfg.space, sealer: cfg.sealer, authorizer, log: cfg.log, door: cfg.door, approvals: cfg.approvals || (cfg.tasks ? createApprovals({ tasks: cfg.tasks }) : undefined), templates: cfg.templates, destinations: cfg.destinations }) : undefined;

  const leases = cfg.sealer && gs && cfg.sealer.lease ? createLeases({ space: cfg.space, sealer: cfg.sealer, grantsStore: gs, authorize: authorizer.authorize, log: cfg.log, chains: cfg.chains, resolve: cfg.resolveCredential, routeAction: cfg.routeAction }) : undefined;

  return Object.freeze({
    authorize: authorizer.authorize,
    ...(leases ? { leases } : {}),
    /** The action registry as the authorizer holds it (a Map of ActionDef): tasks read the risk of an action from here. */
    registry: authorizer.actions,
    limits,
    ...(seal ? { seal } : {}),
    ...(gs ? { grants: Object.freeze({ create: gs.create, revoke: gs.revoke, narrow: gs.narrow, list: gs.list, setRole: gs.setRole, removeMember: gs.removeMember, addActor: gs.addActor, sweep: gs.sweep, invites: Object.freeze({ create: gs.inviteCreate, confirm: gs.inviteConfirm, accept: gs.inviteAccept }), rebuild: gs.rebuild, offers: Object.freeze({ offer: gs.offer, unoffer: gs.unoffer, active: gs.active, onRevoke: gs.onRevoke }) }) } : {}),
    /** The Space's type definitions, read through authorize like any record read (the tool surface and Customize list from here). */
    async definitions(chain) {
      await gate(chain, "records.read", `vyre://${cfg.space}/definition/types`);
      try { return await cfg.store.types(); } catch (e) { throw new KernelError("unavailable", "the store could not list its types", String(e && e.message)); }
    },
    /** The action registry: what each action is and how risky (ActionDef). */
    actions: () => [...authorizer.actions.values()],
    members: Object.freeze({
      /** The role a member holds in this Space, or null. A role is read from the membership the kernel holds, never from the caller. */
      roleOf: (/** @type {any} */ a) => ((wiring.members || cfg.members).has(a) && (wiring.members || cfg.members).membership ? (wiring.members || cfg.members).membership(a)?.role ?? null : null),
      isAdmin: (/** @type {any} */ a) => { const m = wiring.members || cfg.members; const r = m.has(a) && m.membership ? m.membership(a)?.role : null; return r === "owner" || r === "admin"; },
    }),
    /** A service chain for the kernel's own module (memory, hooks): first-party, built by the kernel, never by a caller. */
    serviceChain: (/** @type {string} */ name) => cfg.chains.fromFacts({ kind: "module", module: String(name), first_party: true }),
    ...(cfg.tasks ? { tasks: Object.freeze({ list: (/** @type {any} */ chain) => cfg.tasks.needsYou(chain) }), ask: cfg.tasks } : {}),
    ...(cfg.door ? { model: Object.freeze({ call: (/** @type {any} */ i) => cfg.door.call(i) }) } : {}),
    records,
    events: Object.freeze({ read, latestSeq: cfg.log.latestSeq, subscribe }),
    audit: Object.freeze({
      verify: async () => {
        const v = cfg.log.verify();
        // Every event that still holds its data must also match its salted commitment (K1 item 9b); an erased event keeps only its envelope.
        let bad = null;
        if (v.ok) for (const e of cfg.log.read()) if (!(e.data && e.data.erased === true) && !cfg.log.proves(e.seq)) { bad = e.seq; break; }
        // With the Space's public key, every signed checkpoint is checked too (K5): signatures, and that the event each names is in the log as signed.
        const cps = v.ok && cfg.checkpointKey ? verifyLog({ space: cfg.space, log: cfg.log, publicKey: cfg.checkpointKey }) : null;
        const ok = v.ok && bad === null && (!cps || cps.ok);
        return { ok, events: cfg.log.latestSeq(), open_intents: records.openIntents(), ...(cps ? { checkpoints: cps.checkpoints } : {}), ...(ok ? {} : { detail: v.ok ? (bad !== null ? `event ${bad} does not match its commitment` : cps && cps.problems[0].why) : v.why }) };
      },
    }),
    async health() {
      const h = await cfg.store.health().catch((/** @type {any} */ e) => ({ ok: false, detail: String(e && e.message) }));
      const v = await cfg.store.version().catch(() => ({ store: "unknown", version: "?" }));
      return { ok: Boolean(h.ok), versions: { [v.store]: v.version } };
    },
  });
}
export { RECORD_ACTIONS };
