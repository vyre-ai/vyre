// @ts-check
// core/daemon/flows-host.js: the one place Flows (and stages made of tasks) run in a real vyred. For each Space this home hosts it assembles `createFlows` (kernel/flows) over THAT
// Space's own kernel: the records-backed run store, the Kit store, the stages module, the log subscription, the timer, and the ports (roles, service). The first-party module
// `core/flows` only registers the tools; it is handed this host (the daemon alone builds it), so there is one assembly and no second one.
//
//   const host = createFlowsHost({ log, tzFor, service, watchers });
//   const f = await host.attach(space, kernel, ownerId);       // once per Space: the home's own, and each hosted one (Spaces registry stageFactory)
//   f.flows.tools["flows.define"](chain, input)                  every tool takes the caller's chain first
//   host.get(space) / host.spaces()                              for the module; `host.stop()` at shutdown
//
// What it relies on: the kernel treats a Flow run's automation hop as a job label under its approving person (kernel/core/authorize.js), so a run can do exactly what its approver can
// and no more, and the runner's declared caps narrow it further.
import { createFlows, RecordsFlowStore } from "../../kernel/flows/index.js";
import { createStages } from "../../kernel/flows/stages.js";

const MIN_TICK_MS = 60_000;

/**
 * @param {{ log?: (m: string) => void, clock?: () => number, tzFor?: (space: string) => string | undefined,
 * }} o
 */
export function createFlowsHost(o) {
  const log = o.log || (() => {});
  const clock = o.clock || Date.now;
  /** @type {Map<string, any>} */ const spaces = new Map();

  /** @param {string} space @param {any} k the Space's kernel (kernel/index.js) @param {string} ownerId the Space's first owner */
  async function attach(space, k, ownerId) {
    if (spaces.has(space)) return spaces.get(space);
    const gw = k.gateway;
    const actor = (/** @type {string} */ id) => ({ kind: "person", id, space });
    // The host acts for the Space's owner only for housekeeping (defining its own record types); everything a person's Flow does runs under that person's chain.
    const owner = () => k.chains.fromFacts({ kind: "device", device_key_id: "flows-host", person: ownerId, path: "direct", session: "flows-host" });
    const personChain = (/** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: "flows-host", person: id, path: "direct" });
    const sh = k.kernelFor({ name: "flows", needs: { kernel: { actions: ["records.read", "records.create", "records.update", "records.remove", "events.read", "tasks.request", "tasks.read"], prefixes: ["*"] } } });
    const flowsChain = () => k.chains.appendService(owner(), "flows", true);
    // The module's service grant is written asynchronously; any call through the handle's records waits for it, so wait here before anything runs under the service chain.
    await sh.records.query(sh.serviceChain(), "def_flow", { page: { limit: 1 } }).catch(() => {});

    const kernel = {
      records: gw.records, ask: gw.ask, authorize: (/** @type {any} */ i) => gw.authorize(i), grants: gw.grants,
      events: { read: (/** @type {any} */ c, /** @type {any} */ f) => gw.events.read(c, f), subscribe: (/** @type {any} */ c, /** @type {string} */ n, /** @type {any} */ f, /** @type {any} */ cb) => gw.events.subscribe(c, n, f, cb), latestSeq: async () => k.log.latestSeq() },
      model: { call: async () => { throw Object.assign(new Error("no model door is wired to Flows yet"), { code: "unavailable" }); } },
    };
    const chains = {
      forFlow: (/** @type {any} */ x) => k.chains.forFlow({ ...x, approver: personChain(x.approver.id) }),
      forModule: (/** @type {any} */ x) => k.chains.forModule({ ...x, approver: personChain(x.approver.id) }),
    };
    const catalog = async () => {
      const types = Object.fromEntries((await k.store.types()).map((/** @type {any} */ t) => [t.name, t]));
      const actions = Object.fromEntries(gw.actions().map((/** @type {any} */ a) => [a.action, { risk: a.risk, ...(a.label ? { label: a.label } : {}) }]));
      const tz = (o.tzFor && o.tzFor(space)) || "UTC";
      return { space, types, actions, tz, roles: ["owner", "admin", "manager", "member"], teammates: ["assistant"], templates: [], connectors: o.connectors ? await o.connectors().catch(() => ({})) : {} };
    };
    const roleHolders = async (/** @type {string} */ role) => {
      try { return (await gw.grants.members.list(owner())).filter((/** @type {any} */ m) => m.role === role).map((/** @type {any} */ m) => actor(m.person)); } catch { return []; }
    };
    const ports = {
      roles: async (/** @type {string} */ _space, /** @type {string} */ role) => roleHolders(role),
      // "Call a service": the gateway authorizes it for the run's chain against the route (service.read, or service.call held as outward) BEFORE the vault is asked, then the vault's
      // forward does it with the Space's own credential (kernel/gateway/leases.js forward).
      service: async (/** @type {{ chain: any, connector: string, request: any, idem?: string, approval?: string }} */ q) => {
        if (!gw.leases) throw Object.assign(new Error("this home has no vault forward"), { code: "unavailable" });
        const r = q.request || {};
        return gw.leases.forward(q.chain, { connector: q.connector, method: r.method || "GET", path: r.path || "/", ...(r.query ? { query: r.query } : {}), ...(r.headers ? { headers: r.headers } : {}), ...(r.body !== undefined ? { body: r.body } : {}), ...(r.upload ? { upload: r.upload } : {}), ...(r.saveTo ? { saveTo: r.saveTo } : {}), ...(q.idem ? { idem: q.idem } : {}), ...(q.approval ? { approval: q.approval } : {}), ...(q.bind ? { bind: q.bind } : {}) });
      },
    };

    const store = new RecordsFlowStore({ kernel, chain: flowsChain(), space });
    // Define the Flow record types the Space lacks (a new Space has none; an existing home gains `flow_schedule` here), by the owner: an admin act on the Space's own types.
    {
      const { FLOW_TYPES } = await import("../../kernel/flows/store.js");
      const have = new Set((await k.store.types()).map((/** @type {any} */ t) => t.name));
      const missing = FLOW_TYPES.filter(t => !have.has(t.name));
      if (missing.length) await gw.records.define(owner(), { add_types: [...missing] }).catch((/** @type {any} */ e) => { log(`flows: could not define the Flow record types for ${space}: ${e && e.message}`); });
    }

    const emit = (/** @type {string} */ type, /** @type {any} */ data) => { if (/error|failed/.test(type)) log(`flows ${space}: ${type} ${JSON.stringify(data).slice(0, 200)}`); };
    const flows = createFlows({ kernel, chains, catalog, store, clock, emit, ports });
    const stages = createStages({ kernel: { ask: gw.ask, records: gw.records }, catalog, hook: true, ports: { roles: ports.roles }, clock, emit,
      chain: () => k.chains.appendService(owner(), "flows", true) });

    // One subscription feeds triggers, waits, Kit approvals and stages.
    k.log.subscribe("flows", {}, async (/** @type {any} */ e) => { try { await flows.onEvent(e); } catch (err) { log(`flows ${space}: ${/** @type {Error} */ (err).message}`); } await stages.onEvent(e); });

    // The timer: time triggers and waits. It sleeps until the runner's next wake, never longer than a minute and never faster than a second.
    /** @type {NodeJS.Timeout | null} */ let timer = null;
    let stopped = false;
    const arm = async () => {
      if (stopped) return;
      let wait = MIN_TICK_MS;
      try { const next = await flows.nextWake(); if (typeof next === "number") wait = Math.max(1000, Math.min(MIN_TICK_MS, next - clock())); } catch (err) { log(`flows ${space}: no next wake (${/** @type {Error} */ (err).message})`); }
      if (stopped) return;
      timer = setTimeout(async () => { try { await flows.tick(); } catch (err) { log(`flows ${space}: tick failed (${/** @type {Error} */ (err).message})`); } void arm(); }, wait);
      timer.unref();
    };
    try { await flows.recover(); } catch (err) { log(`flows ${space}: recover failed (${/** @type {Error} */ (err).message})`); }
    void arm();

    const host = Object.freeze({ space, flows, stages, owner: ownerId,
      /** The chain of a session token this Space's door minted (an assistant's session, a person's), or null. */
      chainForToken: async (/** @type {string} */ token) => { try { return await k.surfaces.chainFor(token); } catch { return null; } },
      /** The Space owner's own chain for a call the module has itself checked came from the person's own surface (no presence session: approving still asks for the person's proof). */
      personChain: () => personChain(ownerId),
      stop: () => { stopped = true; if (timer) clearTimeout(timer); } });
    spaces.set(space, host);
    return host;
  }

  return Object.freeze({
    attach,
    get: (/** @type {string} */ space) => spaces.get(space) || null,
    spaces: () => [...spaces.keys()],
    stop: () => { for (const h of spaces.values()) h.stop(); spaces.clear(); },
  });
}
