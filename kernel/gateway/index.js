// kernel/gateway/index.js: assembles the K2 gateway: authorize, records, grants-lite, events and audit over one store.
import { createAuthorizer } from "../core/authorize.js";
import { createRecords, RECORD_ACTIONS } from "./records.js";

/**
 * @param {{ space: string, store: any, log: any, chains: any, grants: any, members: any, actions?: any[], attrs?: any, sealedFields?: any,
 *   sinks?: Set<string>, standing?: any, verifyPresence?: any, hasPresenceSession?: any, clock?: () => number, policy_version?: number }} cfg
 */
export function createGateway(cfg) {
  const authorizer = createAuthorizer({ ...cfg, actions: [...RECORD_ACTIONS, ...(cfg.actions || [])] });
  const records = createRecords({ space: cfg.space, store: cfg.store, authorizer, log: cfg.log, chains: cfg.chains, clock: cfg.clock, sinks: cfg.sinks });
  return Object.freeze({
    authorize: authorizer.authorize,
    records,
    events: Object.freeze({ read: cfg.log.read, latestSeq: cfg.log.latestSeq, subscribe: cfg.log.subscribe }),
    audit: Object.freeze({
      verify: async () => { const v = cfg.log.verify(); return { ok: v.ok, events: cfg.log.latestSeq(), open_intents: records.openIntents(), ...(v.ok ? {} : { detail: v.why }) }; },
    }),
    async health() {
      const h = await cfg.store.health().catch((/** @type {any} */ e) => ({ ok: false, detail: String(e && e.message) }));
      const v = await cfg.store.version().catch(() => ({ store: "unknown", version: "?" }));
      return { ok: Boolean(h.ok), versions: { [v.store]: v.version } };
    },
  });
}
export { RECORD_ACTIONS };
