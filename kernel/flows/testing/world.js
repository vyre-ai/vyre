// A runner wired to the fake kernel, with a clock the test moves and the events the runner emits captured.
import { FakeKernel } from "./fake-kernel.js";
import { FlowRunner } from "../runner.js";
import { MemoryFlowStore, RecordsFlowStore } from "../store.js";
import { catalog, SPACE } from "./fixtures.js";

export const ALEX = { kind: "person", id: "per_alex", space: SPACE };
export const BOB = { kind: "person", id: "per_bob", space: SPACE };

/** @param {{ store?: 'memory'|'records', ports?: any, limits?: any, cat?: any }} [o] */
export async function world(o = {}) {
  const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0) };
  const kernel = new FakeKernel({ now: () => clock.t });
  const emitted = [];
  const chains = { forFlow: x => kernel.chainFor(x) };
  const sysChain = kernel.chainFor({ flow: "system", approver: { kind: "service", id: "flows", space: SPACE }, tainted: false, space: SPACE });
  const store = o.store === "records" ? new RecordsFlowStore({ kernel, chain: sysChain, space: SPACE }) : new MemoryFlowStore();
  if (o.store === "records") await store.define();
  const cat = o.cat || catalog();
  // a type defined through the kernel joins the catalog, as the live definitions would
  const define = kernel.records.define;
  kernel.records.define = async (c, diff) => { const r = await define(c, diff); for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) cat.types[t.name] = t; for (const n of diff.remove_types || []) delete cat.types[n]; return r; };
  const runner = new FlowRunner({
    kernel, store, catalog: () => cat, chains, clock: () => clock.t,
    emit: (type, data, x) => { emitted.push({ type, data, corr: x.corr }); },
    ports: { roles: (space, role) => (role === "attorney" ? [ALEX, BOB] : role === "manager" ? [BOB] : []), ...(o.ports || {}) },
    limits: o.limits,
  });
  // the kernel's own event stream feeds the runner, as the real gateway's does
  kernel.subs.add(e => { void runner.onEvent(e); });
  return { clock, kernel, store, runner, emitted, cat, advance: ms => { clock.t += ms; } };
}

/** Define and approve a Flow in one go; returns its id. */
export async function install(w, flow, approver = ALEX) {
  const d = await w.runner.define(null, flow, approver);
  if (!d.ok) throw new Error("did not compile: " + JSON.stringify(d.errors));
  await w.runner.approve(d.id, d.version, approver, d.hash);
  return d;
}

/** Let the event-driven runs settle. */
export async function settle(w) { await new Promise(r => setImmediate(r)); await w.runner.drain(); await new Promise(r => setImmediate(r)); await w.runner.drain(); }
