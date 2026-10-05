// @ts-check
// The Flows part of the kernel, assembled: the runner, Kits, the canvas data and the tools that expose them. Built on kernel/contracts;
// the host gives it a kernel (authorize, records, ask, events, model), a chain builder and a catalog of the Space's types and actions.
//
//   const flows = createFlows({ kernel, chains, catalog, store, kitStore, emit, ports });
//   flows.tools["flows.define"](chain, { text })       every tool takes the caller's chain first, then its input
//   kernel events -> flows.onEvent(event)              one subscription feeds triggers, waits and Kit approvals
//   one timer     -> flows.tick(), at flows.nextWake()  time triggers and waits (nothing polls faster than a minute)
//   a watcher     -> flows.watcherItem({ watcher, item }) a watcher's new item (bridgeWatchers adapts the watchers module's events)

import { FlowRunner } from "./runner.js";
import { KitManager, MemoryKitStore, RecordsKitStore, KIT_TYPES, installCard, diffKits } from "./kits.js";
import { MemoryFlowStore } from "./store.js";
import { createStages, taskIdOf } from "./stages.js";
import { Proposals, proposerOf } from "./proposals.js";
import { graph, paintRun, seeAsCode, fromCode, flowChanges } from "./canvas.js";
import { compileFlow } from "./compile.js";
import { printFlow, parseFlowTextBounded } from "./text.js";

export { createStages, taskIdOf };
export { FlowRunner, KitManager, MemoryKitStore, MemoryFlowStore, installCard, diffKits };
export * as language from "./schema.js";
export { compileFlow, nextCron, parseCron, deriveCaps } from "./compile.js";
export { TRIGGER_REGISTRY, TRIGGER_ONS, kindOf, whyRan } from "./triggers.js";
export { bridgeWatchers } from "./watcher-bridge.js";
export { printFlow, parseFlowText, parseFlowTextBounded, normalizeFlow, sameFlow } from "./text.js";
export { defineFlow, step, expr } from "./sdk.js";
export { RecordsFlowStore, FLOW_TYPES } from "./store.js";
export { Proposals, proposerOf, assistantOf } from "./proposals.js";
export { RecordsKitStore, KIT_TYPES } from "./kits.js";
export { graph, paintRun, seeAsCode, fromCode, flowChanges, describeStep, describeTrigger, ops } from "./canvas.js";

/**
 * The one accountable person in a chain: a chain that is exactly [person]. Approving a Flow or a Kit is a human-only act (contract 9.2, R6-1);
 * the kernel has already verified presence before the call reaches here, and this refuses any chain with an agent, service or automation hop.
 * @param {any} chain @returns {{ kind: string, id: string, space: string }}
 */
function personOf(chain) {
  const hops = chain && chain.hops;
  if (!Array.isArray(hops) || hops.length !== 1 || hops[0].actor.kind !== "person") throw Object.assign(new Error("only a person can do that, in their own name"), { code: "chain_not_person" });
  const a = hops[0].actor;
  return { kind: "person", id: a.id, space: a.space };
}

/**
 * @param {{
 *   kernel: any, chains: { forFlow: (o: any) => any },
 *   catalog: () => Promise<import('./compile.js').Catalog> | import('./compile.js').Catalog,
 *   store?: any, kitStore?: any, clock?: () => number,
 *   emit?: (type: string, data: any, o: any) => void,
 *   ports?: any, installerRole?: (a: any) => Promise<string> | string, limits?: any,
 *   proposals?: { chain: () => any, applyTypes?: (approver: any, diff: any) => Promise<any>, isAdmin?: (who: any) => Promise<boolean> | boolean },  an assistant's proposals become tasks (proposals.js)
 *   stages?: { approver: any },  stages made of tasks run when this is given: the person whose chain the module works under
 * }} o
 */
export function createFlows(o) {
  const store = o.store || new MemoryFlowStore();
  const runner = new FlowRunner({ kernel: o.kernel, store, catalog: o.catalog, chains: o.chains, clock: o.clock, emit: o.emit, ports: o.ports, limits: o.limits });
  const kits = new KitManager({ kernel: o.kernel, runner, store: o.kitStore || new MemoryKitStore(), catalog: o.catalog, chains: o.chains, clock: o.clock, installerRole: o.installerRole, ports: o.ports });
  const stages = o.stages && o.chains.forModule ? createStages({ kernel: o.kernel, catalog: o.catalog, chain: () => o.chains.forModule({ module: "stages", approver: o.stages.approver }), ports: o.ports, clock: o.clock, emit: o.emit }) : null;
  const proposals = o.proposals ? new Proposals({ kernel: o.kernel, runner, store, chain: o.proposals.chain, chains: o.chains, catalog: o.catalog, applyTypes: o.proposals.applyTypes, isAdmin: o.proposals.isAdmin, clock: o.clock, log: m => (o.emit ? o.emit("proposal.log", { m }) : undefined) }) : null;
  const cat = async () => o.catalog();
  const view = async (/** @type {string} */ id, /** @type {number} */ [version] = [/** @type {any} */ (undefined)]) => {
    const v = version !== undefined ? await store.getVersion(id, version) : (await store.active(id)) || (await latest(id));
    if (!v) throw Object.assign(new Error("no such Flow"), { code: "not_found" });
    return v;
  };
  const latest = async (/** @type {string} */ id) => { const r = await store.flowRow?.(id); const last = r && r.versions[r.versions.length - 1]; return last ? store.getVersion(id, last.version) : null; };

  /** @type {Record<string, (chain: any, input: any) => Promise<any>>} */
  const tools = {
    /** Compile and store a new version, from the stored form or from text. Nothing runs until `flows.approve`. */
    "flows.define": async (chain, i) => {
      const c = await cat();
      let flow = i.flow;
      if (i.text !== undefined) {
        const r = fromCode(i.text, null, c);
        const parsed = await parseFlowTextBounded(i.text).catch(() => null);
        if (!r.ok || !parsed) return { ok: false, errors: r.errors.length ? r.errors : [{ path: "", message: "that text could not be read" }] };
        flow = r.flow;
      }
      const by = chain.hops[chain.hops.length - 1].actor;
      const d = await runner.define(i.id || null, flow, by);
      if (d.ok) return { ...d, changes: i.id ? flowChanges((await view(i.id)).flow, flow, c) : [] };
      return d;
    },
    /** The approver sees the card built from the stored form and approves its hash. A person, in their own name. */
    "flows.approve": async (chain, i) => {
      const v = await store.getVersion(i.id, i.version);
      if (!v) throw Object.assign(new Error("no such Flow version"), { code: "not_found" });
      return runner.approve(i.id, i.version, personOf(chain), i.hash);
    },
    "flows.card": async (chain, i) => {
      const v = await view(i.id, [i.version]);
      const c = await cat();
      const compiled = compileFlow(v.flow, c);
      const prev = i.version && i.version > 1 ? await store.getVersion(i.id, i.version - 1) : null;
      return { id: v.id, version: v.version, hash: v.hash, authorship: v.flow.authorship, effects: compiled.effects, caps: compiled.caps, warnings: compiled.warnings, changes: prev ? flowChanges(prev.flow, v.flow, c) : [], text: seeAsCode(v.flow).text };
    },
    "flows.get": async (chain, i) => { const v = await view(i.id, [i.version]); return { id: v.id, version: v.version, hash: v.hash, status: v.status, approver: v.approver, flow: v.flow }; },
    "flows.list": async () => store.list(),
    "flows.code": async (chain, i) => seeAsCode((await view(i.id, [i.version])).flow),
    "flows.compile-text": async (chain, i) => fromCode(i.text, i.id ? (await view(i.id)).flow : null, await cat()),
    "flows.graph": async (chain, i) => graph((await view(i.id, [i.version])).flow, await cat()),
    "flows.simulate": async (chain, i) => {
      const c = await cat();
      const flow = i.flow || (await view(i.id, [i.version])).flow;
      const approver = personOf({ hops: [chain.hops[0]] });
      return runner.simulate(flow, { approver, since: i.since, until: i.until, samples: i.samples, limit: i.limit });
    },
    "flows.start": async (chain, i) => runner.start(i.id, i.input, chain, i.key),
    "flows.pause": async (chain, i) => { personOf(chain); await runner.pauseFlow(i.id, i.reason || "paused by a person"); return { ok: true }; },
    "flows.resume": async (chain, i) => { personOf(chain); await runner.resumeFlow(i.id); return { ok: true }; },
    "flows.runs": async (chain, i) => (await runner.listRuns({ flow: i.id, state: i.state, limit: i.limit })).map(r => ({ id: r.id, flow: r.flow, version: r.version, state: r.state, started_at: r.started_at, finished_at: r.finished_at, tainted: r.tainted, error: r.error && r.error.code && r.error.code !== "note" ? r.error : null })),
    "flows.run": async (chain, i) => { const r = await runner.getRun(i.run); if (!r) throw Object.assign(new Error("no such run"), { code: "not_found" }); const v = await store.getVersion(r.flow, r.version); return { run: r, painted: v ? paintRun(v.flow, r, await cat()) : null }; },
    // The Space's daily AI allowance for Flow steps: anyone in the Space may read it; an owner or an admin sets it.
    "flows.budget": async (chain, i) => {
      if (i && (i.tokens_per_day !== undefined || i.context_tokens !== undefined)) {
        const who = personOf(chain);
        const holders = [...(o.ports && o.ports.roles ? await o.ports.roles(who.space, "owner") : []), ...(o.ports && o.ports.roles ? await o.ports.roles(who.space, "admin") : [])];
        if (!holders.some((/** @type {any} */ h) => h.id === who.id)) throw Object.assign(new Error("only an owner or an admin sets the AI budget"), { code: "not_allowed" });
        if (i.context_tokens !== undefined) await runner.setContextTokens(Number(i.context_tokens));
        if (i.tokens_per_day !== undefined) await runner.setAiBudget(Number(i.tokens_per_day));
        return runner.aiBudget();
      }
      return runner.aiBudget();
    },
    "flows.retry": async (chain, i) => { personOf(chain); await runner.retry(i.run); return { ok: true }; },
    "kits.card": async (chain, i) => installCard(i.kit, await cat()),
    "kits.diff": async (chain, i) => kits.diff(i.kit),
    // A person, or an assistant acting for them: the person is the approver and the task asks them. An assistant never installs: the install runs only after the approver says yes.
    "kits.propose": async (chain, i) => { const who = proposerOf(chain); if (!who) throw Object.assign(new Error("only a person can do that, in their own name"), { code: "chain_not_person" }); return kits.propose(i.kit, who, chain); },
    "flows.propose": async (chain, i) => { if (!proposals) throw Object.assign(new Error("proposals are not wired here"), { code: "unavailable" }); return proposals.propose(chain, i); },
    "kits.remove": async (chain, i) => kits.remove(i.id, personOf(chain), chain),
    "kits.list": async () => kits.list(),
  };

  return {
    runner, kits, stages, store, tools,
    /** One subscription feeds triggers, waits and Kit approvals. @param {any} env */
    onEvent: async env => { await runner.onEvent(env); await kits.onEvent(env); if (proposals) await proposals.onEvent(env); if (stages) await stages.onEvent(env); },
    tick: () => runner.tick(),
    /** A watcher found something new (see watcher-bridge.js): starts the Flows armed on it, once per item. */
    watcherItem: w => runner.watcherItem(w),
    nextWake: () => runner.nextWake(),
    recover: () => runner.recover(),
    text: printFlow,
  };
}
