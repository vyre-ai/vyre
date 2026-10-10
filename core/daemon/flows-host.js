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
import { createWakeTimer } from "./wake-timer.js";
import { createFlows, RecordsFlowStore, RecordsKitStore, KIT_TYPES } from "../../kernel/flows/index.js";
import { createStages } from "../../kernel/flows/stages.js";
import { createCodeSandbox } from "../../kernel/flows/code-sandbox.js";


/**
 * Run `f` now when the Space's store is attached, or when it joins. A Space on its own records store (Twenty) attaches a moment after the server is up (stores/twenty/deferred-store.js): whatever reads the Flow
 * record types has to wait for that, and for the types to be defined, or it reads "no type flow-state".
 * @param {any} store @param {() => any} f
 */
export function whenStoreReady(store, f) {
  if (store && typeof store.attached === "function" && !store.attached() && typeof store.whenReady === "function") { store.whenReady(f); return undefined; }
  return f();
}

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
      records: gw.records, ask: gw.ask, ...(gw.kits ? { kits: gw.kits } : {}), authorize: (/** @type {any} */ i) => (i && i.peek === true ? gw.authorizePeek(i) : gw.authorize(i)), grants: gw.grants,
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
      // A registered tool its module lists in flow.steps is an action a call step may name: read runs at once, outward is held for a yes first. `tool: true` says the runner
      // does not ask the kernel's action table about it: the person's approval is the yes, and the tool's own module gates the rest. Its typed fields ride along for the editor.
      for (const t of o.flowTools ? o.flowTools() : []) actions[t.name] = { risk: t.risk === "outward" ? "outward.send" : "read", label: t.summary || t.name, tool: true, inputs: t.inputs, outputs: t.outputs };
      const tz = (o.tzFor && o.tzFor(space)) || "UTC";
      // The triggers modules offer by name (flow.triggers): the Flow stores the `trigger` of one, an event or watcher trigger that already exists.
      const triggers = o.flowTriggers ? o.flowTriggers() : [];
      return { space, types, actions, tz, roles: ["owner", "admin", "manager", "member"], teammates: ["assistant"], templates: [], connectors: o.connectors ? await o.connectors().catch(() => ({})) : {}, triggers };
    };
    const roleHolders = async (/** @type {string} */ role) => {
      try { return (await gw.grants.members.list(owner())).filter((/** @type {any} */ m) => m.role === role).map((/** @type {any} */ m) => actor(m.person)); } catch { return []; }
    };
    const ports = {
      // "Call a tool": a registered tool its module offered as a Flow step. A read tool runs as the Flow's person at once; an outward one runs only with the approval the person gave for exactly this
      // act, spent here (once, for the task's doer, bound to this input), and then it is the person's own act: no second hold. Anything else is refused.
      // One entry point for a Flow's call step: a module step (flow.steps) runs as below, and nothing else is a step.
      call: async (/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource, /** @type {any} */ input, /** @type {{ idem?: string, approval?: string, bind?: string }} */ opts = {}) => {
        const tool = o.flowTools ? (o.flowTools() || []).find((/** @type {any} */ t) => t.name === action) : null;
        if (!tool) throw Object.assign(new Error(`${action} is not a step a Flow can run`), { code: "denied" });
        if (!o.callFlow) throw Object.assign(new Error("this home has no way to run a module's tool from a Flow"), { code: "unavailable" });
        const person = chain.hops.find((/** @type {any} */ h) => h.actor.kind === "person");
        if (!person) throw Object.assign(new Error("a Flow step runs as a person"), { code: "denied" });
        if (tool.risk === "outward") {
          if (!opts.approval || !opts.bind || !k.tasks || typeof k.tasks.useApproval !== "function" || !k.tasks.useApproval({ id: opts.approval, chain, action, resource, bind: opts.bind, outward: true })) {
            throw Object.assign(new Error(`${action} acts outside, and needs the person's approval for exactly this call`), { code: "denied" });
          }
        }
        const session = await k.surfaces.open(personChain(person.actor.id), { ttl_ms: 60_000 });
        const r = await o.callFlow(action, input, { token: session.token });
        if (r && r.error) throw Object.assign(new Error(String(r.error.message || r.error.code)), { code: r.error.code || "failed" });
        return r ? r.data : null;
      },
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
    const setupTypes = async () => {
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
      // A new Space (one with no contact type yet) also starts with the base Kit's types: the owner's setup act, no card, once. A Space on its own Records store has had them since its store was made.
      if (!have.has("contact")) {
        try {
          const { kitFromLibrary } = await import("../../records/kits/library.js");
          const now = new Set((await k.store.types()).map((/** @type {any} */ t) => t.name));
          const base = kitFromLibrary("base").includes.types;
          await gw.records.define(owner(), { add_types: base.filter((/** @type {any} */ t) => !now.has(t.name)), change_types: base.filter((/** @type {any} */ t) => now.has(t.name)) });
        } catch (/** @type {any} */ e) { log(`flows: could not define the base Kit's types for ${space}: ${e && e.message}`); }
      }
      // A Space made before the Communication kept who was on it as text and as its own `contacts` link has the old Communication type: add the fields (the definition is the core one, additive), then
      // move its participant records onto them once (records/comms/migrate.js). Both are best effort and say so in the log.
      try {
        const comm = (await k.store.types()).find((/** @type {any} */ t) => t.name === "communication"), want = CORE_TYPES.find((/** @type {any} */ t) => t.name === "communication");
        if (comm && want && want.fields.some((/** @type {any} */ f) => !comm.fields.some((/** @type {any} */ x) => x.name === f.name))) await gw.records.define(owner(), { change_types: [want] });
        const { migrateParticipants } = await import("../../records/comms/migrate.js");
        await migrateParticipants({ records: gw.records }, owner(), log);
      } catch (e) { log(`flows: communications for ${space} were not brought up to date: ${e && /** @type {Error} */ (e).message}`); }
    };
    // A store still starting (a first start makes the Space's database) gets the types when it joins, so the server is never held for it (stores/twenty/deferred-store.js whenReady).
    await whenStoreReady(k.store, setupTypes);

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

    // The timer sleeps until the next wake and is woken by events (core/daemon/wake-timer.js): an idle box makes no records query between them.
    const wake = createWakeTimer({ nextWake: () => flows.nextWake(), tick: () => flows.tick(), now: clock, log: (/** @type {string} */ msg) => log(`flows ${space}: ${msg}`) });
    // One subscription feeds triggers, waits, Kit approvals and stages.
    k.log.subscribe("flows", {}, async (/** @type {any} */ e) => { try { await flows.onEvent(e); void wake.poke(); } catch (err) { log(`flows ${space}: ${/** @type {Error} */ (err).message}`); } await stages.onEvent(e); });
    const recover = async () => { try { await flows.recover(); } catch (err) { log(`flows ${space}: recover failed (${/** @type {Error} */ (err).message})`); } };
    // The timer starts after the types are there and the runs are recovered: a tick on a store still starting found no flow-state, and recover no flow-run, every minute of the first quarter hour.
    await whenStoreReady(k.store, async () => { await recover(); void wake.arm(); });

    const host = Object.freeze({ space, flows, stages, get owner() { return ownerOf(); },
      /** The chain of a session token this Space's door minted (an assistant's session, a person's), or null. */
      chainForToken: async (/** @type {string} */ token) => { try { return await k.surfaces.chainFor(token); } catch { return null; } },
      /** The Space owner's own chain for a call the module has itself checked came from the person's own surface (no presence session: approving still asks for the person's proof). */
      personChain: () => personChain(ownerOf()),
      /** This Space's calendar sync (core/daemon/calendar-sync.js), or null. */
      get calendar() { return o.calendarSync ? o.calendarSync.get(space) : null; },
      stop: () => { wake.stop(); } });
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
