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
import { createFlows, RecordsFlowStore, RecordsKitStore, KIT_TYPES } from "../../kernel/flows/index.js";
import { createStages } from "../../kernel/flows/stages.js";
import { createCodeSandbox } from "../../kernel/flows/code-sandbox.js";

const MIN_TICK_MS = 60_000;

/**
 * @param {{ log?: (m: string) => void, clock?: () => number, tzFor?: (space: string) => string | undefined, calendarSync?: { attach: (s: any) => any, stop: () => void }, google?: { accounts: () => Promise<{ name: string }[]>, api: (account: string, req: any) => Promise<{ status: number, body: any }> },
 * }} o
 */
export function createFlowsHost(o) {
  const log = o.log || (() => {});
  const clock = o.clock || Date.now;
  /** @type {Map<string, any>} */ const spaces = new Map();
  const sandbox = o.sandbox || createCodeSandbox();

  /** @param {string} space @param {any} k the Space's kernel (kernel/index.js) @param {string} ownerId the Space's first owner */
  async function attach(space, k, ownerArg) {
    /** The Space's first owner, read live: it becomes the claimed identity's id when the person claims one. */
    const ownerOf = () => (typeof ownerArg === "function" ? ownerArg() : ownerArg);
    if (spaces.has(space)) return spaces.get(space);
    const gw = k.gateway;
    const actor = (/** @type {string} */ id) => ({ kind: "person", id, space });
    // The host acts for the Space's owner only for housekeeping (defining its own record types); everything a person's Flow does runs under that person's chain.
    const owner = () => k.chains.fromFacts({ kind: "device", device_key_id: "flows-host", person: ownerOf(), path: "direct", session: "flows-host" });
    const personChain = (/** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: "flows-host", person: id, path: "direct" });
    const sh = k.kernelFor({ name: "flows", needs: { kernel: { actions: ["records.read", "records.create", "records.update", "records.remove", "tasks.request", "tasks.read", "tasks.work"], prefixes: ["*"] } } });
    const flowsChain = () => k.chains.appendService(owner(), "flows", true);
    // The module's service grant is written asynchronously; any call through the handle's records waits for it, so wait here before anything runs under the service chain.
    await sh.records.query(sh.serviceChain(), "def_flow", { page: { limit: 1 } }).catch(() => {});

    const kernel = {
      records: gw.records, ask: gw.ask, ...(gw.kits ? { kits: gw.kits } : {}), authorize: (/** @type {any} */ i) => gw.authorize(i), grants: gw.grants,
      events: { read: (/** @type {any} */ c, /** @type {any} */ f) => gw.events.read(c, f), subscribe: (/** @type {any} */ c, /** @type {string} */ n, /** @type {any} */ f, /** @type {any} */ cb) => gw.events.subscribe(c, n, f, cb), latestSeq: async () => k.log.latestSeq() },
      // The model door is the kernel's own (gateway.model, present when the home was booted with the inference door): every classify step goes through its scan, so a sealed field reaches the
      // model only as a placeholder, and the step passes no tools. Without a door the step fails plainly and the owner is told.
      model: gw.model || { call: async () => { throw Object.assign(new Error("this home has no model door, so a classify step cannot run"), { code: "unavailable" }); } },
    };
    const chains = {
      forFlow: (/** @type {any} */ x) => k.chains.forFlow({ ...x, approver: personChain(x.approver.id) }),
      forModule: (/** @type {any} */ x) => k.chains.forModule({ ...x, approver: personChain(x.approver.id) }),
      // The Flows service as the doer of a task it puts in front of a person to check (a Kit's install card, an assistant's proposal, a held act): the approver, narrowed to service:flows.
      forDoer: (/** @type {any} */ x) => k.chains.forModule({ module: "flows", approver: personChain(x.approver.id) }),
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
      // A Code step runs in the module sandbox's own OS confinement, one process per call (kernel/flows/code-sandbox.js); one sandbox (and one self-test) for the whole host.
      sandbox,
      roles: async (/** @type {string} */ _space, /** @type {string} */ role) => roleHolders(role),
      // A pool is the team members (people and assistants) whose `role` is the pool's name, on any project: the same records the team screen shows. A member's skills are the words in its
      // `skills` field (comma separated) and its role.
      pool: async (/** @type {string} */ _space, /** @type {string} */ name) => {
        try {
          const rows = (await gw.records.query(owner(), "team-member", { filter: { field: "role", op: "eq", value: name }, page: { limit: 200 } })).rows;
          const seen = new Set(), out = [];
          for (const r of rows) {
            const a = r.data && r.data.actor && r.data.actor.actor;
            if (!a || seen.has(a.id)) continue; seen.add(a.id);
            out.push({ actor: a, name: r.data.name || a.id, skills: [String(r.data.role || ""), ...String(r.data.skills || "").split(",")].map(x => x.trim()).filter(Boolean) });
          }
          return out;
        } catch { return []; }
      },
      // What the choice leans on: how many tasks each actor has had on this record, and how many open tasks each has now.
      signals: async (/** @type {string} */ _space, /** @type {string | undefined} */ record) => {
        const involvement = /** @type {Record<string, number>} */ ({}), load = /** @type {Record<string, number>} */ ({});
        for (const t of await gw.ask.list(owner(), { state: ["waiting", "ready", "working", "needs_check", "stuck"] })) load[t.doer.id] = (load[t.doer.id] || 0) + 1;
        if (record) for (const t of await gw.ask.list(owner(), { record })) involvement[t.doer.id] = (involvement[t.doer.id] || 0) + 1;
        return { involvement, load };
      },
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
      // The record types a Kit's non-type parts are stored in (templates, role and view definitions) are defined here by the owner with the Flow types, so installing a Kit later never needs a
      // definition change of its own for them: only the Kit's own types are defined at install, under the approved-Kit waiver.
      const { CORE_TYPES } = await import("../../records/core-types.js");
      const defType = (/** @type {string} */ name, /** @type {string} */ label) => ({ name, label, fields: [{ name: "name", kind: "text", label: "Name" }, { name: "body", kind: "text", label: "Definition" }, { name: "kit", kind: "text", label: "From Kit" }] });
      // Every Space has the core types (contact, organization, communication, event ...): the objects layer the calendar sync and "Log communications" write to. `template` is also the Kit's storage.
      const kitStorage = [...CORE_TYPES, defType("def-role", "Role definition"), defType("def-view", "View definition")].filter(Boolean);
      const missing = [...FLOW_TYPES, ...KIT_TYPES, ...kitStorage].filter(t => !have.has(t.name));
      if (missing.length) await gw.records.define(owner(), { add_types: [...missing] }).catch((/** @type {any} */ e) => { log(`flows: could not define the Flow record types for ${space}: ${e && e.message}`); });
      // A Space made before the Communication kept who was on it as text and as its own `contacts` link has the old Communication type: add the fields (the definition is the core one, additive), then
      // move its participant records onto them once (records/comms/migrate.js). Both are best effort and say so in the log.
      try {
        const comm = (await k.store.types()).find((/** @type {any} */ t) => t.name === "communication"), want = CORE_TYPES.find((/** @type {any} */ t) => t.name === "communication");
        if (comm && want && want.fields.some((/** @type {any} */ f) => !comm.fields.some((/** @type {any} */ x) => x.name === f.name))) await gw.records.define(owner(), { change_types: [want] });
        const { migrateParticipants } = await import("../../records/comms/migrate.js");
        await migrateParticipants({ records: gw.records }, owner(), log);
      } catch (e) { log(`flows: communications for ${space} were not brought up to date: ${e && /** @type {Error} */ (e).message}`); }
    }

    const emit = (/** @type {string} */ type, /** @type {any} */ data) => { if (/error|failed/.test(type)) log(`flows ${space}: ${type} ${JSON.stringify(data).slice(0, 200)}`); };
    // An assistant's proposals (the Engineer's) become tasks for an owner or an admin; the change is applied only after the kernel has the approver's yes, as the approver (kernel/flows/proposals.js).
    const proposals = {
      chain: flowsChain,
      isAdmin: async (/** @type {any} */ who) => (await roleHolders("owner")).concat(await roleHolders("admin")).some((/** @type {any} */ a) => a.id === who.id),
      applyTypes: async (/** @type {any} */ approver, /** @type {any} */ diff) => gw.records.define(personChain(approver.id), diff),
    };
    // Installed Kits and the proposals waiting for a yes are records (they survive a restart, with history and the log), written and removed by the Flows service's own chain: the kernel keeps those rows
    // (kit-proposal, kit-install) to whoever made them or an owner or admin.
    const kitStore = new RecordsKitStore({ kernel, chain: flowsChain() });
    const flows = createFlows({ kernel, chains, catalog, store, kitStore, clock, emit, ports, proposals });
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

    const host = Object.freeze({ space, flows, stages, get owner() { return ownerOf(); },
      /** The chain of a session token this Space's door minted (an assistant's session, a person's), or null. */
      chainForToken: async (/** @type {string} */ token) => { try { return await k.surfaces.chainFor(token); } catch { return null; } },
      /** The Space owner's own chain for a call the module has itself checked came from the person's own surface (no presence session: approving still asks for the person's proof). */
      personChain: () => personChain(ownerOf()),
      /** This Space's calendar sync (core/daemon/calendar-sync.js), or null. */
      get calendar() { return o.calendarSync ? o.calendarSync.get(space) : null; },
      stop: () => { stopped = true; if (timer) clearTimeout(timer); } });
    spaces.set(space, host);
    // The Space's calendar is kept in step with an outside calendar by default (core/daemon/calendar-sync.js): it looks at the vault for a calendar connector every few minutes.
    if (o.calendarSync) { try { o.calendarSync.attach({ space, gw, chains, ownerChain: owner, personChain, ownerId: ownerOf, subscribe: (/** @type {(e: any) => any} */ cb) => k.log.subscribe("calendar-sync", {}, cb), ...(o.google ? { google: o.google } : {}) }); } catch (err) { log(`flows ${space}: calendar sync did not start (${/** @type {Error} */ (err).message})`); } }
    return host;
  }

  return Object.freeze({
    attach,
    get: (/** @type {string} */ space) => spaces.get(space) || null,
    spaces: () => [...spaces.keys()],
    stop: () => { for (const h of spaces.values()) h.stop(); spaces.clear(); if (o.calendarSync) o.calendarSync.stop(); },
  });
}
