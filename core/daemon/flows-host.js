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
import { createFlows, RecordsFlowStore, RecordsKitStore, KIT_TYPES, assistantOf } from "../../kernel/flows/index.js";
import { boundsOf } from "../../kernel/flows/standing.js";
import { createStages, taskIdOf } from "../../kernel/flows/stages.js";
import { createCodeSandbox } from "../../kernel/flows/code-sandbox.js";
import { ROLE_IDS } from "../../kernel/contracts/index.js";


/** Is the Space's own record store still starting (a deferred store that has not attached)? A store with no deferral is never away. @param {any} store */
export function storeIsAway(store) {
  return Boolean(store && typeof store.attached === "function" && !store.attached());
}

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
    const sh = k.kernelFor({ name: "flows", needs: { kernel: { actions: ["records.read", "records.create", "records.update", "records.remove", "tasks.request", "tasks.read", "tasks.work"], prefixes: ["*"], mints: [{ prefix: "flow-act", actions: ["flows.act-standing"] }] } } });
    const flowsChain = () => k.chains.appendService(owner(), "flows", true);
    // The module's service grant is written asynchronously; any call through the handle's records waits for it, so wait here before anything runs under the service chain.
    await sh.records.query(sh.serviceChain(), "def_flow", { page: { limit: 1 } }).catch(() => {});

    const kernel = {
      records: gw.records, ask: gw.ask, ...(gw.kits ? { kits: gw.kits } : {}), authorize: (/** @type {any} */ i) => (i && i.peek === true ? gw.authorizePeek(i) : gw.authorize(i)), grants: gw.grants,
      events: { read: (/** @type {any} */ c, /** @type {any} */ f) => gw.events.read(c, f), subscribe: (/** @type {any} */ c, /** @type {string} */ n, /** @type {any} */ f, /** @type {any} */ cb) => gw.events.subscribe(c, n, f, cb), latestSeq: async () => k.log.latestSeq() },
      // The model door is the kernel's own (gateway.model, present when the home was booted with the inference door): every classify step goes through its scan, so a sealed field reaches the
      // model only as a placeholder, and the step passes no tools. Without a door the step fails plainly and the owner is told.
      model: gw.model || { call: async () => { throw Object.assign(new Error("this home has no model door, so a classify step cannot run: ask the owner to turn on model access for this home"), { code: "unavailable" }); } },
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
      for (const t of o.flowTools ? o.flowTools() : []) actions[t.name] = { risk: t.risk === "outward" ? "outward.send" : "read", label: t.summary || t.name, tool: true, inputs: t.inputs, outputs: t.outputs, ...(t.covers && t.covers.length ? { covers: t.covers } : {}), ...(t.recipients && t.recipients.length ? { recipients: t.recipients } : {}) };
      const tz = (o.tzFor && o.tzFor(space)) || "UTC";
      // The triggers modules offer by name (flow.triggers): the Flow stores the `trigger` of one, an event or watcher trigger that already exists.
      const triggers = o.flowTriggers ? o.flowTriggers() : [];
      // The light of each Connection (green, amber, red), by the name a Flow's service step uses (`conn-<id>`): a Flow that uses a red one says so in its health line.
      const lights = o.lights ? await o.lights().catch(() => ({})) : {};
      return { space, types, actions, tz, roles: [...ROLE_IDS], teammates: ["assistant"], templates: [], connectors: o.connectors ? await o.connectors().catch(() => ({})) : {}, triggers, lights };
    };
    const roleHolders = async (/** @type {string} */ role) => {
      try { return (await gw.grants.members.list(owner())).filter((/** @type {any} */ m) => m.role === role).map((/** @type {any} */ m) => actor(m.person)); } catch { return []; }
    };
    /** Receipts the standing approval gave this host for sends about to run (spent once at the call). */
    const standingReceipts = new Set();
    const ports = {
      // "Call a tool": a registered tool its module offered as a Flow step. A read tool runs as the Flow's person at once; an outward one runs only with the approval the person gave for exactly this
      // act, spent here (once, for the task's doer, bound to this input), and then it is the person's own act: no second hold. Anything else is refused.
      // One entry point for a Flow's call step: a module step (flow.steps) runs as below, and nothing else is a step.
      call: async (/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource, /** @type {any} */ input, /** @type {{ idem?: string, approval?: string, bind?: string, ride?: { run: string, step: string, with: string } }} */ opts = {}) => {
        const tool = o.flowTools ? (o.flowTools() || []).find((/** @type {any} */ t) => t.name === action) : null;
        if (!tool) throw Object.assign(new Error(`${action} is not a step a Flow can run (flows.cheatsheet lists the steps)`), { code: "denied" });
        if (!o.callFlow) throw Object.assign(new Error("this home has no way to run a module's tool from a Flow"), { code: "unavailable" });
        const person = chain.hops.find((/** @type {any} */ h) => h.actor.kind === "person");
        if (!person) throw Object.assign(new Error("a Flow step runs as a person"), { code: "denied" });
        if (tool.risk === "outward") {
          // A step that rides an earlier step's yes (`with`) is covered when the person's approved question for that earlier step, in this run, listed it (action and resource) among the steps it asks for
          // (kernel/flows/rides.js): the question was frozen with the task and read in full by the person. The yes is not spent here again; each rider has a receipt of its own below.
          // (read from the task itself, which a restart keeps: the person's yes was proven when they answered it, and the rider may come days later)
          const ride = opts.ride, row = ride ? await gw.ask.get(flowsChain(), String(opts.approval)).catch(() => null) : null, form = row && row.state === "done" && row.outcome === "approved" ? row.form : null;
          const rides = ride && form && form.kind === "held_act" && form.run === ride.run && form.step === ride.with && Array.isArray(form.rides) && form.rides.some((/** @type {any} */ r) => r.step === ride.step && r.action === action && r.resource === resource);
          if (standingReceipts.has(String(opts.approval))) { standingReceipts.delete(String(opts.approval)); } else if (ride ? !rides : (!opts.approval || !opts.bind || !k.tasks || typeof k.tasks.useApproval !== "function" || !k.tasks.useApproval({ id: opts.approval, chain, action, resource, bind: opts.bind, outward: true }))) {
            throw Object.assign(new Error(`${action} acts outside, and needs the person's approval for exactly this call`), { code: "denied" });
          }
        }
        const session = await k.surfaces.open(personChain(person.actor.id), { ttl_ms: 60_000 });
        const r = await o.callFlow(action, input, { token: session.token, ...(tool.risk === "outward" && opts.approval ? { task: opts.ride ? `${opts.approval}-r-${opts.ride.step}` : opts.approval } : {}) });
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
        if (!gw.leases) throw Object.assign(new Error("this home has no vault forward, so a Flow cannot call a service: ask the owner to set up the vault on this home"), { code: "unavailable" });
        const r = q.request || {};
        return gw.leases.forward(q.chain, { connector: q.connector, method: r.method || "GET", path: r.path || "/", ...(r.query ? { query: r.query } : {}), ...(r.headers ? { headers: r.headers } : {}), ...(r.body !== undefined ? { body: r.body } : {}), ...(r.upload ? { upload: r.upload } : {}), ...(r.saveTo ? { saveTo: r.saveTo } : {}), ...(q.idem ? { idem: q.idem } : {}), ...(q.approval ? { approval: q.approval } : {}), ...(q.bind ? { bind: q.bind } : {}) });
      },
    };

    const store = new RecordsFlowStore({ kernel, chain: flowsChain(), space });
    // Define the Flow record types the Space lacks (a new Space has none; an existing home gains `flow_schedule` here), by the owner: an admin act on the Space's own types.
    const setupTypes = async () => {
      const { FLOW_TYPES } = await import("../../kernel/flows/store.js");
      const haveTypes = await k.store.types();
      const have = new Set(haveTypes.map((/** @type {any} */ t) => t.name));
      // The record types a Kit's non-type parts are stored in (templates, role and view definitions) are defined here by the owner with the Flow types, so installing a Kit later never needs a
      // definition change of its own for them: only the Kit's own types are defined at install, under the approved-Kit waiver.
      const { CORE_TYPES } = await import("../../records/core-types.js");
      const defType = (/** @type {string} */ name, /** @type {string} */ label) => ({ name, label, fields: [{ name: "name", kind: "text", label: "Name" }, { name: "body", kind: "text", label: "Definition" }, { name: "kit", kind: "text", label: "From Kit" }] });
      // Every Space has the core types (contact, organization, communication, event ...): the objects layer the calendar sync and "Log communications" write to. `template` is also the Kit's storage.
      const kitStorage = [...CORE_TYPES, defType("def-role", "Role definition"), defType("def-view", "View definition")].filter(Boolean);
      const missing = [...FLOW_TYPES, ...KIT_TYPES, ...kitStorage].filter(t => !have.has(t.name));
      if (missing.length) await gw.records.define(owner(), { add_types: [...missing] }).catch((/** @type {any} */ e) => { log(`flows: could not define the Flow record types for ${space}: ${e && e.message}`); });
      // A Flow type that gained a field since this Space made it (flow-run.record, the run's link to its record) gets the field: the definition is additive.
      const grown = FLOW_TYPES.filter(want => { const had = haveTypes.find((/** @type {any} */ t) => t.name === want.name); return had && want.fields.some(f => !had.fields.some((/** @type {any} */ x) => x.name === f.name)); });
      if (grown.length) await gw.records.define(owner(), { change_types: grown.map(t => ({ ...t })) }).catch((/** @type {any} */ e) => { log(`flows: could not add the new fields to the Flow record types for ${space}: ${e && e.message}`); });
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

    // A run that stops, is stuck, is over or is answered tells the rest of the house (the approvals queue redraws its card), with ids and a state only: never a message or a step value.
    const emit = (/** @type {string} */ type, /** @type {any} */ data) => {
      if (/error|failed/.test(type)) log(`flows ${space}: ${type} ${JSON.stringify(data).slice(0, 200)}`);
      if (o.publish && /^(flow\.(finished|stuck|stale|paused|cancelled|retried|started)|stage\.gate-(opened|closed))$/.test(type)) { try { o.publish(type, { run: data && data.run, flow: data && data.flow, ...(data && data.state ? { state: data.state } : {}) }); } catch { /* a notice, never a stop */ } }
    };
    // An assistant's proposals (the Engineer's) become tasks for an owner or an admin; the change is applied only after the kernel has the approver's yes, as the approver (kernel/flows/proposals.js).
    const isAdminOf = async (/** @type {any} */ who) => (await roleHolders("owner")).concat(await roleHolders("admin")).some((/** @type {any} */ a) => a.id === who.id);
    const callModule = o.callModule || (async () => { throw Object.assign(new Error("this host cannot reach the modules: ask the owner to restart Vyre"), { code: "unavailable" }); });
    /** An agent's change to itself, by conversation (R031-09): the agents module keeps the draft and writes the version; the card goes to the agent's owner, else an owner or admin. */
    const agentKind = {
      draft: async (/** @type {any} */ chain, /** @type {any} */ spec, /** @type {any} */ proposer) => {
        const by = assistantOf(chain);
        const r = await callModule("agents.change.draft", { agent: String(spec.agent || ""), patch: spec.patch, proposer: proposer.id, ...(by ? { by } : {}) });
        if (proposer.id !== r.owner && by !== r.agent && !(await isAdminOf(proposer))) throw Object.assign(new Error(`only ${r.agent}'s owner, an admin, or ${r.agent} itself proposes a change to it`), { code: "not_found" });
        const brief = (/** @type {any} */ x) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "string" && v.length > 600 ? `${v.slice(0, 600)}...` : v)));
        return { form: { agent: r.agent, draft: r.id, hash: r.hash, owner: r.owner || null, before: brief(r.before), after: brief(r.after) }, title: r.title, idem: r.hash, checker: { kind: "person", id: r.owner || ownerOf(), space } };
      },
      title: async (/** @type {any} */ f) => callModule("agents.change.title", { id: String(f.draft), hash: String(f.hash) }),
      mayCheck: async (/** @type {any} */ checker, /** @type {any} */ f) => checker.id === f.owner || isAdminOf(checker),
      apply: async (/** @type {any} */ checker, /** @type {any} */ f) => callModule("agents.change.apply", { id: String(f.draft), hash: String(f.hash), approver: checker.id }),
    };
    /** A template version put live, on its owner's yes (R031-11): the same card, with the work module keeping the versions. */
    const templateKind = {
      draft: async (/** @type {any} */ _chain, /** @type {any} */ spec, /** @type {any} */ proposer) => {
        const r = await callModule("work.template.change.draft", { template: String(spec.template || ""), version: Number(spec.version), proposer: proposer.id });
        if (proposer.id !== r.owner && !(await isAdminOf(proposer))) throw Object.assign(new Error(`only ${r.template}'s owner or an admin proposes a version of it`), { code: "not_found" });
        return { form: { template: r.template, version: r.version, draft: r.id, hash: r.hash, owner: r.owner || null }, title: r.title, idem: r.hash, checker: { kind: "person", id: r.owner || ownerOf(), space } };
      },
      title: async (/** @type {any} */ f) => callModule("work.template.change.title", { id: String(f.draft), hash: String(f.hash) }),
      mayCheck: async (/** @type {any} */ checker, /** @type {any} */ f) => checker.id === f.owner || isAdminOf(checker),
      apply: async (/** @type {any} */ checker, /** @type {any} */ f) => callModule("work.template.change.apply", { id: String(f.draft), hash: String(f.hash), approver: checker.id }),
    };
    /** A skill or plugin draft approved (R031-20): the same card; the level's owner (a plugin with code is approved with the acknowledgement of exactly what it declares). */
    const skillKind = {
      draft: async (/** @type {any} */ _chain, /** @type {any} */ spec, /** @type {any} */ proposer) => {
        const r = await callModule("skills.change.draft", { name: String(spec.name || ""), level: String(spec.level || ""), scope: String(spec.scope ?? ""), version: Number(spec.version), proposer: proposer.id });
        return { form: { draft: r.id, hash: r.hash, owner: r.owner || null, ...(r.ack ? { ack: r.ack, declares: r.declares } : {}) }, title: r.title, idem: r.hash, checker: { kind: "person", id: r.owner || ownerOf(), space } };
      },
      title: async (/** @type {any} */ f) => callModule("skills.change.title", { id: String(f.draft), hash: String(f.hash) }),
      mayCheck: async (/** @type {any} */ checker, /** @type {any} */ f) => (f.owner ? checker.id === f.owner || isAdminOf(checker) : isAdminOf(checker)),
      apply: async (/** @type {any} */ checker, /** @type {any} */ f) => callModule("skills.change.apply", { id: String(f.draft), hash: String(f.hash), approver: checker.id, ...(f.ack ? { ack: f.ack } : {}) }),
    };
    const proposals = {
      chain: flowsChain,
      isAdmin: isAdminOf,
      applyTypes: async (/** @type {any} */ approver, /** @type {any} */ diff) => gw.records.define(personChain(approver.id), diff),
      // the agents are this home's own: only the home's Space takes a change to one
      kinds: { template: templateKind, skill: skillKind, ...(o.agentsSpace && o.agentsSpace() === space ? { agent: agentKind } : {}) },
    };
    // Installed Kits and the proposals waiting for a yes are records (they survive a restart, with history and the log), written and removed by the Flows service's own chain: the kernel keeps those rows
    // (kit-proposal, kit-install) to whoever made them or an owner or admin.
    const kitStore = new RecordsKitStore({ kernel, chain: flowsChain() });
    // The tasks that are stuck, for the one "Needs you" list: read as the Flows service for the Space's owner (names, the reason and when; the kernel's own task read decides what it may see).
    const stuckTasks = async () => {
      const rows = await gw.ask.list(flowsChain(), { state: ["stuck"] }).catch(() => []);
      return (Array.isArray(rows) ? rows : []).slice(0, 50).map((/** @type {any} */ t) => ({ task: t.id, label: String(t.title || "").slice(0, 120), reason: String((t.stuck && t.stuck.reason) || "").slice(0, 200), since: (t.stuck && t.stuck.since) || t.updated_at || 0, ...(t.record ? { record: t.record } : {}) }));
    };
    const flows = createFlows({ kernel, chains, catalog, store, kitStore, clock, emit, ports, proposals, settings: o.settings, stuckTasks });
    // The standing approval (kernel/flows/standing.js): the person's yes at turn-on is a kernel grant for exactly that approved version, made through the module's mint handle and ended when the
    // version stops being the one that runs. A send is covered only when the kernel, asked with the run's own chain, allows it: the budget and rate on the grant are the kernel's to count.
    const standingUrn = (/** @type {string} */ flow, /** @type {string} */ hash) => `vyre://${space}/flow-act/${flow}@${hash}`;
    const reconcileStanding = async (/** @type {string} */ flow) => {
      if (!sh.mint) return null;
      const live = await store.active(flow).catch(() => null), want = live && live.approver ? standingUrn(flow, live.hash) : null;
      const have = (await sh.mint.list({ source: `flows:standing:${flow}@` })) || [];
      for (const g of have) if (g.resource.prefix !== want) await sh.mint.end({ id: g.id, reason: "the approved version changed, paused or ended" });
      if (!want || have.some((/** @type {any} */ g) => g.resource.prefix === want)) return want;
      const b = boundsOf(live.flow, await catalog().catch(() => null));
      await sh.mint.make({ subject: { kind: "actor", actor: { kind: "person", id: live.approver.id, space } }, actions: ["flows.act-standing"], resource: { prefix: want }, source: `flows:standing:${flow}@${live.hash}`,
        conditions: { budget: { meter: `flow-act:${flow}@${live.hash}`, limit: b.max }, rate: { n: b.per_minute, per_seconds: 60 } }, reason: "the person turned this Flow on" });
      return want;
    };
    for (const name of ["flows.approve", "flows.pause", "flows.resume", "flows.disable", "flows.rollback", "flows.remove", "flows.delete"]) {
      const orig = flows.tools[name];
      if (typeof orig === "function") flows.tools[name] = async (/** @type {any} */ c, /** @type {any} */ i) => { const r = await orig(c, i); if (i && i.id) await reconcileStanding(String(i.id)).catch((/** @type {any} */ e) => log(`flows ${space}: standing grant ${e && e.message}`)); return r; };
    }
    ports.standing = async (/** @type {any} */ x) => {
      const want = await reconcileStanding(x.flow);
      const live = await store.active(x.flow).catch(() => null);
      if (!want || !live || live.version !== x.version) return null;
      /** @type {any} */ let d = null;
      try {
        d = await gw.authorize({ chain: x.chain, action: "flows.act-standing", resource: `${want}/${x.step}` });
        // the grant's budget and rate are counted here, as the gate counts any allowed act: a send past the bound throws before anything goes out
        if (d && d.effect === "allow" && gw.limits) gw.limits.enforce(x.chain, d);
      } catch (e) {
        const code = /** @type {any} */ (e) && /** @type {any} */ (e).code;
        if (code === "budget_exhausted" || code === "rate_limited") throw Object.assign(new Error(code === "rate_limited" ? "this Flow sent as many as its limit allows for a minute, so it stopped" : "this Flow sent as many as the person allowed when they turned it on, so it stopped"), { code: "bound" });
        return null;
      }
      if (!d || d.effect !== "allow") { log(`flows ${space}: standing not allowed ${JSON.stringify(d).slice(0, 300)}`); return null; }
      const receipt = `standing:${x.run}-${x.step}`;
      standingReceipts.add(receipt);
      emit("flow.standing", { run: x.run, flow: x.flow, step: x.step, action: x.action, recipients: x.recipients });
      return { receipt };
    };
    // A template project's `role:x` doer is the agent or person its team gave that role (team-member rows), before the Space's own roles are asked.
    const projectRoleDoer = async (/** @type {string} */ role, /** @type {any} */ c) => {
      if (!c || c.type !== "project" || typeof c.record !== "string") return null;
      try {
        const rows = (await gw.records.query(owner(), "team-member", { filter: { field: "project", op: "eq", value: { urn: c.record } }, page: { limit: 100 } })).rows;
        const hit = rows.find((/** @type {any} */ r) => r.data && r.data.role === role && r.data.actor && r.data.actor.actor);
        return hit ? hit.data.actor.actor : null;
      } catch { return null; }
    };
    const stages = createStages({ kernel: { ask: gw.ask, records: gw.records }, catalog, hook: true, ports: { roles: ports.roles, doer: projectRoleDoer }, clock, emit, gates: flows.runner.gatePort(), isAdmin: proposals && proposals.isAdmin,
      chain: () => k.chains.appendService(owner(), "flows", true) });

    flows.attachStages(stages);
    // A Mac coming back online wakes the runs that wait for a Chrome (kernel/flows/runner.js #awaitDevice): the module event becomes a kernel-shaped event for the runner.
    const offDevice = o.onDevice ? o.onDevice(() => { void flows.onEvent({ id: `device:${clock()}`, type: "link.mac-online", data: {} }).catch((/** @type {any} */ err) => log(`flows ${space}: device wake failed (${err && err.message})`)); }) : null;
    // The timer sleeps until the next wake and is woken by events (core/daemon/wake-timer.js): an idle box makes no records query between them.
    const wake = createWakeTimer({ nextWake: () => flows.nextWake(), tick: () => flows.tick(), now: clock, log: m => log(`flows ${space}: ${m}`) });
    // One subscription feeds triggers, waits, Kit approvals and stages.
    // (while the Space's own record store is still starting there is nothing to match an event against, and each one would fail and log the same line: they are skipped, and the store's join starts the Flows)
    const storeAway = () => storeIsAway(k.store);
    k.log.subscribe("flows", {}, async (/** @type {any} */ e) => { if (storeAway()) return; try { await flows.onEvent(e); void wake.poke(); // An event this very publish put in the log (subject .../event/<module>) is not a task change: publishing it again never stops.
      if (o.publish && !/\/event\/[^/]+$/.test(String(e.subject)) && /^task\.(stuck|unblocked|readied|skipped|completed|approved|voided)$/.test(String(e.type))) o.publish(String(e.type), { task: taskIdOf(e) }); } catch (err) { if (/** @type {any} */ (err) && /** @type {any} */ (err).code === "unavailable") return; log(`flows ${space}: ${/** @type {Error} */ (err).message}`); } await stages.onEvent(e); });

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
      stop: () => { wake.stop(); if (typeof offDevice === "function") offDevice(); } });
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
