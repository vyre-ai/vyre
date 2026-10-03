// kernel/gateway/index.js: assembles the K2 gateway: authorize, records, grants-lite, events and audit over one store.
import { createAuthorizer } from "../core/authorize.js";
import { createRecords, RECORD_ACTIONS } from "./records.js";
import { createSealing } from "./sealing.js";
import { ACTIONS as SEAL_ACTIONS } from "../seal/uses.js";
import { TASK_ACTIONS } from "../tasks/tasks.js";
import { createApprovals } from "../tasks/approvals.js";
import { createGate } from "../core/gate.js";
import { isChain, actorString, isExactlyPerson } from "../core/chain.js";
import { KernelError } from "../core/errors.js";

/**
 * @param {{ tasks?: any, sealer?: any, door?: any, approvals?: any, templates?: any, destinations?: any, owner?: string, space: string, store: any, log: any, chains: any, grants: any, members: any, actions?: any[], attrs?: any, sealedFields?: any,
 *   sinks?: Set<string>, standing?: any, verifyPresence?: any, hasPresenceSession?: any, clock?: () => number, policy_version?: number }} cfg
 */
export function createGateway(cfg) {
  /** @type {any} */ let records;
  // Kernel attributes come from the gateway's own index (K2-7); a caller-supplied resolver only fills what the gateway does not hold.
  const attrs = (/** @type {string} */ u) => ({ ...((cfg.attrs && cfg.attrs(u)) || {}), ...((records && records.attrsOf(u)) || {}) });
  const authorizer = createAuthorizer({ ...cfg, attrs, actions: [...RECORD_ACTIONS, ...SEAL_ACTIONS, ...TASK_ACTIONS, ...(cfg.actions || [])] });
  records = createRecords({ space: cfg.space, store: cfg.store, authorizer, log: cfg.log, chains: cfg.chains, clock: cfg.clock, sinks: cfg.sinks });
  const { allowed } = createGate({ authorizer, log: cfg.log });

  /** May this chain see this event? `events.read` on the subject, then the event's own `vis` (contract 7.4). Anything unknown is no. */
  async function canSee(/** @type {any} */ chain, /** @type {any} */ e) {
    if (!(await allowed(chain, "events.read", e.subject))) return false;
    const vis = e.vis;
    if (vis === "space") return true;
    if (vis === "subject") return allowed(chain, "records.read", e.subject);
    const owner = isExactlyPerson(chain) && cfg.owner !== undefined && chain.hops[0].actor.id === cfg.owner;
    if (vis === "owner") return owner;
    if (vis === "actor") return owner || chain.hops.some((/** @type {any} */ h) => actorString(h.actor) === e.actor);
    if (typeof vis === "string" && vis.startsWith("members:")) {
      const role = vis.slice(8);
      return chain.hops.some((/** @type {any} */ h) => h.actor.kind === "person" && cfg.members.membership && cfg.members.membership(h.actor)?.role === role);
    }
    return false;
  }

  /** The log through `authorize`: events the chain may not read are absent, never marked. */
  async function read(/** @type {any} */ chain, /** @type {any} */ filter = {}) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    const { limit, ...rest } = filter;
    const out = [];
    for (const e of cfg.log.read(rest)) { if (await canSee(chain, e)) out.push(e); if (limit && out.length >= limit) break; }
    return out;
  }

  /** A consumer name belongs to the actor that first used it; every delivered event is checked the way `read` checks it. */
  function subscribe(/** @type {any} */ chain, /** @type {string} */ consumer, /** @type {any} */ filter, /** @type {(e: any) => any} */ onEvent) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    const name = `${actorString(chain.hops[chain.hops.length - 1].actor)}:${consumer}`;
    return cfg.log.subscribe(name, filter, async (/** @type {any} */ e) => { if (await canSee(chain, e)) await onEvent(e); });
  }

  const seal = cfg.sealer ? createSealing({ space: cfg.space, sealer: cfg.sealer, authorizer, log: cfg.log, door: cfg.door, approvals: cfg.approvals || (cfg.tasks ? createApprovals({ tasks: cfg.tasks }) : undefined), templates: cfg.templates, destinations: cfg.destinations }) : undefined;

  return Object.freeze({
    authorize: authorizer.authorize,
    ...(seal ? { seal } : {}),
    records,
    events: Object.freeze({ read, latestSeq: cfg.log.latestSeq, subscribe }),
    audit: Object.freeze({
      verify: async () => {
        const v = cfg.log.verify();
        // Every event that still holds its data must also match its salted commitment (K1 item 9b); an erased event keeps only its envelope.
        let bad = null;
        if (v.ok) for (const e of cfg.log.read()) if (!(e.data && e.data.erased === true) && !cfg.log.proves(e.seq)) { bad = e.seq; break; }
        const ok = v.ok && bad === null;
        return { ok, events: cfg.log.latestSeq(), open_intents: records.openIntents(), ...(ok ? {} : { detail: v.ok ? `event ${bad} does not match its commitment` : v.why }) };
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
