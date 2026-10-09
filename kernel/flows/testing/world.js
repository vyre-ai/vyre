// A runner wired to the fake kernel, with a clock the test moves and the events the runner emits captured.
import { CORE_TYPES } from "../../../records/core-types.js";
import { RealKernel } from "./real-kernel.js";
import { FlowRunner } from "../runner.js";
import { MemoryFlowStore, RecordsFlowStore } from "../store.js";
import { catalog, SPACE } from "./fixtures.js";
import { createStages } from "../stages.js";

export const ALEX = { kind: "person", id: "per_alex", space: SPACE };
export const BOB = { kind: "person", id: "per_bob", space: SPACE };

/** @param {{ store?: 'memory'|'records', ports?: any, limits?: any, policy?: any, settings?: any, cat?: any }} [o] */
export async function world(o = {}) {
  const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0) };
  const which = "real"; // the one kernel there is: the real gateway, tasks and chains (the Fake is gone)
  const kernel = new RealKernel({ now: () => clock.t, actions: { "email.send": { risk: "outward.send" }, "email.draft": { risk: "write" } } });
  if (which === "real") { kernel.setRole("attorney", [ALEX, BOB]); kernel.setRole("manager", [BOB]); kernel.addActor({ kind: "agent", id: "research" }); kernel.addActor({ kind: "agent", id: "intake" }); kernel.addActor({ kind: "service", id: "flows" }); }
  const emitted = [];
  const chains = { forFlow: x => kernel.chainFor(x), forModule: x => kernel.moduleChain(x), forDoer: x => kernel.moduleChain({ module: "flows", approver: x.approver }) };
  const sysChain = kernel.chainFor({ flow: "system", approver: { kind: "service", id: "flows", space: SPACE }, tainted: false, space: SPACE });
  const store = o.store === "records" ? new RecordsFlowStore({ kernel, chain: sysChain, space: SPACE }) : new MemoryFlowStore();
  if (o.store === "records") await store.define();
  const cat = o.cat || catalog();
  // a type defined through the kernel joins the catalog, as the live definitions would
  const define = kernel.records.define;
  kernel.records.define = async (c, diff) => { const r = await define(c, diff); for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) cat.types[t.name] = t; for (const n of diff.remove_types || []) delete cat.types[n]; return r; };
  // the real store knows only the types it was told about; the Fake makes tables as it goes
  if (which === "real") await kernel.records.define(kernel.sysChain(), { add_types: [...Object.values(cat.types), ...CORE_TYPES.filter(t => !cat.types[t.name])] });
  const runner = new FlowRunner({
    kernel, store, catalog: () => cat, chains, clock: () => clock.t,
    emit: (type, data, x) => { emitted.push({ type, data, corr: x.corr }); },
    ports: { roles: (space, role) => (role === "attorney" ? [ALEX, BOB] : role === "manager" ? [BOB] : []), ...(o.ports || {}) },
    limits: o.limits, policy: o.policy, settings: o.settings,
  });
  // stages made of tasks: a module over the same events, working under [ALEX, service:stages]
  const stageEvents = [];
  const stages = createStages({ kernel, catalog: () => cat, chain: () => kernel.moduleChain({ module: "stages", approver: ALEX }), clock: () => clock.t, hook: which === "real", emit: (type, data) => stageEvents.push({ type, data }), gates: runner.gatePort(), isAdmin: who => who.id === ALEX.id,
    ports: { roles: (space, role) => (role === "attorney" ? [ALEX, BOB] : role === "manager" ? [BOB] : []) } });
  /** @type {Array<() => void>} */ const offs = [];
  offs.push(kernel.onEvent(e => stages.onEvent(e), "stages"));
  if (which === "real") kernel.hooks = { onStageEnter: e => stages.onStageEnter(e), stageTasks: (u, s) => stages.stageTasks(u, s) };
  // the kernel's own event stream feeds the runner, as the real gateway's does
  offs.push(kernel.onEvent(e => runner.onEvent(e), "flows"));
  return { which, offs, stopListening: () => { for (const o of offs.splice(0)) { try { if (typeof o === "function") o(); } catch { /* already off */ } } }, stages, stageEvents, clock, kernel, store, runner, emitted, cat, advance: ms => { clock.t += ms; } };
}

/** Define and approve a Flow in one go; returns its id. */
export async function install(w, flow, approver = ALEX) {
  const d = await w.runner.define(null, flow, approver);
  if (!d.ok) throw new Error("did not compile: " + JSON.stringify(d.errors));
  await w.runner.approve(d.id, d.version, approver, d.hash);
  return d;
}

/** Let the event-driven runs settle. */
export async function settle(w) {
  const idle = async () => { await w.kernel.pump(); if (w.kernel.idle) await w.kernel.idle(); };
  await idle(); await new Promise(r => setImmediate(r)); await w.runner.drain(); await new Promise(r => setImmediate(r)); await w.runner.drain(); await idle(); await w.stages.idle(); await idle();
}
