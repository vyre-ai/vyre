// @ts-check
// The simulation step (contract 9.2): a change runs against scenarios before anyone is asked to approve it. The simulator is sessions' (the Flow
// runner); this wraps its port so a missing or failing simulator reads as "not simulated", never as a pass.

/**
 * @typedef {{ ok: boolean, steps: number, failures: { scenario?: string, msg: string }[] }} SimResult
 * @typedef {(diff: any, scenarios: any[]) => Promise<SimResult>|SimResult} SimulatePort
 * @typedef {{ ok: boolean, available: boolean, ran: number, steps: number, failures: { scenario?: string, msg: string }[] }} Simulation
 */

/** One scenario for every stage of every type the change adds or changes, so each stage's task list is entered once. @param {any} diff @returns {any[]} */
export function defaultScenarios(diff) {
  const out = [];
  for (const t of [...(diff?.add_types || []), ...(diff?.change_types || [])]) for (const s of t.stages || []) out.push({ name: `${t.name}: enter ${s.name}`, type: t.name, stage: s.name });
  return out;
}

/** @param {{ simulate?: SimulatePort|null, diff: any, scenarios?: any[] }} o @returns {Promise<Simulation>} */
export async function runSimulation({ simulate, diff, scenarios }) {
  const list = scenarios || defaultScenarios(diff);
  if (typeof simulate !== "function") return { ok: false, available: false, ran: 0, steps: 0, failures: [{ msg: "no simulator is available, so this change was not simulated" }] };
  try {
    const r = await simulate(diff, list);
    const failures = Array.isArray(r?.failures) ? r.failures.map(f => ({ ...(f.scenario ? { scenario: String(f.scenario) } : {}), msg: String(f.msg).slice(0, 300) })) : [];
    return { ok: Boolean(r && r.ok) && failures.length === 0, available: true, ran: list.length, steps: Number(r?.steps) || 0, failures };
  } catch (e) {
    return { ok: false, available: true, ran: 0, steps: 0, failures: [{ msg: `the simulation stopped: ${String(/** @type {Error} */ (e).message).slice(0, 200)}` }] };
  }
}
