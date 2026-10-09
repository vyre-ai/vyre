// @ts-check
// Saved test cases for a Flow (t2). A case is a trigger (an event, or an input for a Flow that is started by hand, a web call or a schedule) and what the Flow is expected to do with it:
// `state`, `writes`, `outward`, `asks`, `steps_ran`, `steps_not_run`, every key optional. A case runs through the runner's simulation, so every action is stubbed and nothing is stored, sent
// or emitted. Approving a Flow version runs its cases first and is refused while one fails.

export const CASE_LIMITS = Object.freeze({ cases: 20, name: 80, data: 16 * 1024 });
const EXPECT_KEYS = ["state", "writes", "outward", "asks", "steps_ran", "steps_not_run"];
const STATES = ["completed", "paused", "failed"];

/** @param {any} c @returns {{ path: string, message: string }[]} */
export function checkCase(c) {
  /** @type {{ path: string, message: string }[]} */ const out = [];
  const isObj = (/** @type {any} */ v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(c)) return [{ path: "", message: "a test case is { name, event | input, expect }" }];
  for (const k of Object.keys(c)) if (!["name", "event", "input", "expect"].includes(k)) out.push({ path: k, message: `${k} is not part of a test case` });
  if (typeof c.name !== "string" || !c.name.trim() || c.name.length > CASE_LIMITS.name) out.push({ path: "name", message: `name the case in at most ${CASE_LIMITS.name} characters` });
  if ((c.event === undefined) === (c.input === undefined)) out.push({ path: "event", message: "give the trigger as event ({ type, data, subject? }) for an event Flow, or input for a Flow started by hand, a web call or a schedule, not both" });
  if (c.event !== undefined && !(isObj(c.event) && typeof c.event.type === "string")) out.push({ path: "event", message: "an event is { type, data, subject? }" });
  if (JSON.stringify(c.event ?? c.input ?? null).length > CASE_LIMITS.data) out.push({ path: "event", message: "that trigger is too large for a test case" });
  const e = c.expect;
  if (e !== undefined) {
    if (!isObj(e)) out.push({ path: "expect", message: "expect is { state?, writes?, outward?, asks?, steps_ran?, steps_not_run? }" });
    else {
      for (const k of Object.keys(e)) if (!EXPECT_KEYS.includes(k)) out.push({ path: `expect.${k}`, message: `${k} is not something a case can expect (${EXPECT_KEYS.join(", ")})` });
      if (e.state !== undefined && !STATES.includes(e.state)) out.push({ path: "expect.state", message: `state is ${STATES.join(", ")}` });
      if (e.writes !== undefined && !(isObj(e.writes) && Object.values(e.writes).every(n => Number.isInteger(n) && n >= 0))) out.push({ path: "expect.writes", message: "writes is { <record type>: how many }" });
      for (const k of ["outward", "asks"]) if (e[k] !== undefined && !(Number.isInteger(e[k]) && e[k] >= 0)) out.push({ path: `expect.${k}`, message: `${k} is a count` });
      for (const k of ["steps_ran", "steps_not_run"]) if (e[k] !== undefined && !(Array.isArray(e[k]) && e[k].every((/** @type {any} */ x) => typeof x === "string"))) out.push({ path: `expect.${k}`, message: `${k} is a list of step ids` });
    }
  }
  return out;
}

/** What one simulated run did, as the expectation a case would hold. @param {any} sim the simulate answer for one trigger */
export function expectFrom(sim) {
  const run = sim.runs && sim.runs[0];
  const t = sim.totals || {};
  /** @type {Record<string, any>} */ const e = { state: run ? run.outcome : "failed" };
  if (t.writes && Object.keys(t.writes).length) e.writes = t.writes;
  e.outward = (t.outward || []).reduce((/** @type {number} */ n, /** @type {any} */ o) => n + o.count, 0);
  e.asks = t.asks || 0;
  if (run && run.ran) e.steps_ran = run.ran;
  return e;
}

/** Compare what a simulation did with what a case expects. Returns the words of the first difference, or null. @param {any} expect @param {any} sim */
export function differs(expect, sim) {
  const run = sim.runs && sim.runs[0];
  if (!run) return "the trigger did not start the Flow";
  const t = sim.totals || {};
  const want = expect || {};
  if (want.state !== undefined && run.outcome !== want.state) return `it ${run.outcome}${run.reason ? ` (${run.reason})` : ""}, expected it to be ${want.state}`;
  if (want.writes) for (const [type, n] of Object.entries(want.writes)) { const got = (t.writes || {})[type] || 0; if (got !== n) return `it wrote ${got} ${type}, expected ${n}`; }
  if (want.outward !== undefined) { const got = (t.outward || []).reduce((/** @type {number} */ k, /** @type {any} */ o) => k + o.count, 0); if (got !== want.outward) return `it did ${got} outward act${got === 1 ? "" : "s"}, expected ${want.outward}`; }
  if (want.asks !== undefined && (t.asks || 0) !== want.asks) return `it asked ${t.asks || 0} time${t.asks === 1 ? "" : "s"}, expected ${want.asks}`;
  const ran = new Set(run.ran || []);
  for (const id of want.steps_ran || []) if (!ran.has(id)) return `step ${id} did not run`;
  for (const id of want.steps_not_run || []) if (ran.has(id)) return `step ${id} ran, expected it not to`;
  return null;
}

/** The simulation of one case. @param {any} runner @param {any} flow @param {any} c @param {any} approver */
export async function simulateCase(runner, flow, c, approver) {
  const at = runner.now();
  if (c.event) {
    const env = { id: `case:${c.name}`, type: c.event.type, subject: c.event.subject, data: c.event.data ?? {}, trust: "internal", received_at: at, time: at };
    return runner.simulate(flow, { approver, events: [env], limit: 1 });
  }
  return runner.simulate(flow, { approver, samples: [c.input ?? {}], limit: 1 });
}

/**
 * Run cases against a Flow. One line a case.
 * @param {any} runner @param {any} flow @param {any[]} cases @param {any} approver
 * @returns {Promise<{ ok: boolean, passed: number, failed: number, results: { name: string, ok: boolean, line: string }[] }>}
 */
export async function runCases(runner, flow, cases, approver) {
  /** @type {{ name: string, ok: boolean, line: string }[]} */ const results = [];
  for (const c of cases) {
    let line;
    try {
      const sim = await simulateCase(runner, flow, c, approver);
      if (!sim.ok) line = `the Flow does not compile: ${sim.errors && sim.errors[0] ? sim.errors[0].message : "an error"}`;
      else line = differs(c.expect, sim);
    } catch (e) { line = `could not run: ${e instanceof Error ? e.message : String(e)}`; }
    results.push({ name: c.name, ok: !line, line: line ? `${c.name}: ${line}` : `${c.name}: ok` });
  }
  const failed = results.filter(r => !r.ok).length;
  return { ok: failed === 0, passed: results.length - failed, failed, results };
}
