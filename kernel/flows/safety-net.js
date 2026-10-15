// @ts-check
// The Flows safety net (roadmap 0.6 item 5): one scenario for every step kind and for the compound shapes, run three ways by three test files.
//   crash-sweep.test.js   the run is killed at every write point (each time the runner writes its ledger) and a new runner recovers it: the same records and tasks as a run that was never killed, one effect per step
//   golden-replay.test.js each scenario's finished run, scrubbed of ids, is the same twice and the same as the file in golden/replay.json (node kernel/flows/golden/write.mjs writes it; golden-refresh does it in CI)
//   roundtrip.test.js     generated Flows and expressions go through the text and lines forms and back unchanged
// The point of it: the runner and the editor logic can be split into small modules (0.7) with replay output that is byte-identical before and after each move, and a step kind added later fails the build until
// it has an entry here. A kind with no entry is `STEP_KINDS` minus `SCENARIOS` minus `COVERED_BY` (see crash-sweep.test.js).
import { world, install, settle, ALEX } from "./testing/world.js";
import { SPACE } from "./testing/fixtures.js";
import { FlowRunner } from "./runner.js";
import { sourceHash } from "./schema.js";

const src = "return { n: 1 };";
const flow = (/** @type {any[]} */ steps, extra = {}) => ({ format: 1, name: "t", label: "T", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });
const lane = (/** @type {string} */ id, /** @type {any[]} */ steps) => ({ id, kind: "branch", steps });
const chain = (/** @type {any} */ w) => w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE });
const seed = (/** @type {any} */ w, /** @type {string} */ type, /** @type {any} */ data) => w.kernel.records.create(chain(w), type, data);
const create = (/** @type {string} */ id, /** @type {any} */ set, type = "payment") => ({ id, kind: "create", type, set });
const svcPort = async () => ({ status: 200, ok: true, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ id: "m-1", name: "Rivera" })) });

/**
 * @typedef {{
 *   ports?: Record<string, any>, world?: any,
 *   build: (w: any) => Promise<{ steps: any[], input?: any, extra?: any }>,
 *   ends?: "done" | "waiting",
 *   finish?: (w: any, runner: any) => Promise<void>,
 * }} Scenario
 */

/** One scenario for each step kind (the keys are STEP_KINDS names), then the compound shapes. @type {Record<string, Scenario>} */
export const SCENARIOS = {
  create: { build: async () => ({ steps: [create("m", { client: "A", amount: 1 })] }) },
  update: { build: async w => { const m = await seed(w, "matter", { client: "Old", stage: "Intake" }); return { steps: [{ id: "u", kind: "update", type: "matter", record: { expr: "trigger.id" }, set: { client: "New" } }], input: { id: m.id } }; } },
  upsert: { build: async () => ({ steps: [{ id: "up1", kind: "upsert", type: "payment", match: { client: "Z" }, set: { amount: 1 } }, { id: "up2", kind: "upsert", type: "payment", match: { client: "Z" }, set: { amount: 2 } }] }) },
  remove: { build: async w => { const m = await seed(w, "matter", { client: "Gone" }); return { steps: [{ id: "r", kind: "remove", type: "matter", record: { expr: "trigger.id" } }], input: { id: m.id } }; } },
  stage: { build: async w => { const m = await seed(w, "matter", { client: "Moved", stage: "Intake" }); return { steps: [{ id: "s", kind: "stage", type: "matter", record: { expr: "trigger.id" }, to: "Engagement" }], input: { id: m.id } }; } },
  find: { build: async w => { await seed(w, "matter", { client: "A", fee: { amount: 10, currency: "USD" } }); await seed(w, "matter", { client: "B", fee: { amount: 200, currency: "USD" } }); return { steps: [{ id: "f", kind: "find", type: "matter", limit: 10 }, create("m", { client: "Found", amount: { expr: "len(steps.f.rows)" } })] }; } },
  pick: { build: async w => { await seed(w, "matter", { client: "C" }); return { steps: [{ id: "p", kind: "pick", type: "matter", where: "record.client == \"C\"" }, create("m", { client: { expr: "steps.p.record.data.client" } })] }; } },
  filter: { build: async w => { await seed(w, "matter", { client: "A", fee: { amount: 10, currency: "USD" } }); await seed(w, "matter", { client: "B", fee: { amount: 300, currency: "USD" } }); return { steps: [{ id: "f", kind: "find", type: "matter", limit: 10 }, { id: "g", kind: "filter", from: "steps.f.rows", where: "record.fee.amount > 250" }, create("m", { client: "Kept", amount: { expr: "len(steps.g.rows)" } })] }; } },
  decide: { build: async () => ({ steps: [{ id: "d", kind: "decide", if: "trigger.n > 1", then: [create("big", { client: "Big" })], else: [create("small", { client: "Small" })] }, create("after", { client: "After" })], input: { n: 2 } }) },
  repeat: { build: async () => ({ steps: [{ id: "each", kind: "repeat", over: "trigger.names", as: "n", steps: [{ id: "mk", kind: "create", type: "matter", set: { client: { expr: "n" } } }] }], input: { names: ["a", "b", "c"] } }) },
  parallel: { build: async () => ({ steps: [{ id: "p", kind: "parallel", steps: [lane("left", [create("l1", { client: "Left" })]), lane("right", [create("r1", { client: "Right" })])] }, create("after", { client: "After" })] }) },
  subflow: { build: async w => { await install(w, { format: 1, name: "inner", label: "Inner", authorship: "human", trigger: { on: "manual" }, returns: { n: { expr: "steps.c.record.data.amount" } }, steps: [create("c", { client: "Inner", amount: 5 })] }); return { steps: [{ id: "s", kind: "subflow", flow: "inner" }, create("after", { client: "After", amount: { expr: "steps.s.result.n" } })] }; } },
  wait: { ends: "done", build: async () => ({ steps: [{ id: "w", kind: "wait", for_ms: 60_000 }, create("after", { client: "After" })] }), finish: async (w, runner) => { w.clock.t += 61_000; await runner.tick(); } },
  ask: { ends: "waiting", build: async () => ({ steps: [{ id: "a", kind: "ask", to: "role:manager", title: "Approve the refund?" }, create("after", { client: "After" })] }) },
  assign: { build: async () => ({ steps: [{ id: "a1", kind: "assign", to: "role:manager", title: "Review the file", output: { kind: "note" }, how: "person" }, create("after", { client: "After" })] }) },
  agent: { ends: "waiting", build: async () => ({ steps: [{ id: "r", kind: "agent", assistant: "teammate:research", title: "Research the client", instructions: "Look them up", output: { kind: "note" } }] }) },
  call: { ends: "waiting", build: async () => ({ steps: [{ id: "c", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com", subject: "Hello", body: "Hi" } }] }) },
  service: { ports: { service: svcPort }, build: async () => ({ steps: [{ id: "g", kind: "service", connector: "practice", method: "GET", path: "/matters/42" }, create("m", { client: { expr: "steps.g.response.json.name" } })] }) },
  classify: { world: { modelLabel: "urgent" }, build: async () => ({ steps: [{ id: "c", kind: "classify", input: { expr: "trigger.text" }, labels: ["urgent", "normal"] }, create("m", { client: { expr: "steps.c.label" } })], input: { text: "help!" } }) },
  extract: { world: { modelLabel: "{\"client\":\"Rivera\",\"amount\":\"$1,250.50\"}" }, build: async () => ({ steps: [{ id: "e", kind: "extract", input: { expr: "trigger.text" }, fields: [{ name: "client", kind: "text" }, { name: "amount", kind: "number" }] }, create("m", { client: { expr: "steps.e.fields.client" }, amount: { expr: "steps.e.fields.amount" } })], input: { text: "Rivera owes 1,250.50" } }) },
  fn: { ports: { sandbox: async () => ({ outputs: { n: 1 } }) }, build: async () => ({ steps: [{ id: "f", kind: "fn", language: "js", source: src, hash: sourceHash(src), inputs: {}, outputs: ["n"] }, create("m", { client: "Ran", amount: { expr: "steps.f.n" } })] }) },
  // compound shapes: kinds inside kinds
  "compound: a decision inside a loop, then a task": { build: async () => ({ steps: [{ id: "each", kind: "repeat", over: "trigger.names", as: "n", steps: [{ id: "d", kind: "decide", if: "n == \"b\"", then: [{ id: "mb", kind: "create", type: "matter", set: { client: "B!" } }], else: [{ id: "mo", kind: "create", type: "matter", set: { client: { expr: "n" } } }] }] }, { id: "a1", kind: "assign", to: "role:manager", title: "Look it over", output: { kind: "note" }, how: "person" }], input: { names: ["a", "b"] } }) },
  "compound: lanes that wait and a step after the join": { ends: "waiting", build: async () => ({ steps: [{ id: "p", kind: "parallel", steps: [lane("left", [{ id: "a1", kind: "assign", to: "role:manager", title: "Left lane work", output: { kind: "note" }, how: "person", await: true }]), lane("right", [create("r1", { client: "Right" })])] }, create("after", { client: "After" })] }) },
};

/** Kinds that have no scenario of their own because another kind's scenario runs them. */
export const COVERED_BY = Object.freeze({ branch: "parallel" });

/** @param {any} v @returns {any} the value with ids and times of this run taken out, so two runs of the same scenario compare */
export function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    /** @type {Record<string, any>} */ const out = {};
    for (const k of Object.keys(v).sort()) { if (["tries", "attempts_log"].includes(k) && !v[k]) continue; out[k] = scrub(v[k]); }
    return out;
  }
  if (typeof v === "string") return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\b(run|man|tsk|per|rec|fl|ev|evt|ap|dec|job|mnt|grt|gr)_[A-Za-z0-9]{6,}\b/g, "<id>");
  return v;
}

/** What the world holds after a run: every record's data, and the tasks by title and state. Ids are not in it. @param {any} w */
export function fingerprint(w) {
  const rows = [...w.kernel.tables.entries()].map(([type, m]) => [type, [...m.values()].map((/** @type {any} */ r) => JSON.stringify(scrub(r.data))).sort()]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const tasks = w.kernel.tasks.map((/** @type {any} */ t) => `${t.title}|${t.state}`).sort();
  return JSON.stringify({ rows, tasks });
}

/** The ledger of a finished run, without ids or the timing that differs from one run to the next. @param {any} run */
export function ledger(run) {
  const { id: _id, steps, state, error, trigger, tainted, depth, version, label } = run;
  const keep = Object.fromEntries(Object.entries(steps || {}).map(([k, e]) => { const { at: _a, started_at: _s, finished_at: _f, wait, task: _t, children: _c, ...rest } = /** @type {any} */ (e); return [k, { ...rest, ...(wait ? { wait: { kind: wait.kind } } : {}) }]; }));
  return scrub({ state, error: error ? { code: error.code, step: error.step } : null, trigger: trigger ? { kind: trigger.kind } : null, tainted, depth, version, label, steps: keep });
}

/**
 * Run one scenario to its end: on a fresh world, with the runner killed at the `crashAt`th write of a run (none for the plain run), then a new runner recovering it.
 * `writes` is how many times the runner wrote a run; the plain run counts them. @param {string} name @param {{ crashAt?: number }} [o]
 */
export async function runScenario(name, o = {}) {
  const sc = SCENARIOS[name];
  const w = await world(sc.ports ? { ports: sc.ports } : {});
  if (sc.world && sc.world.modelLabel) w.kernel.modelLabel = sc.world.modelLabel;
  const built = await sc.build(w);
  const { id } = await install(w, flow(built.steps));
  let writes = 0, dead = false;
  const real = w.store.putRun.bind(w.store);
  if (o.crashAt !== undefined) w.store.putRun = async (/** @type {any} */ r) => { if (dead) throw new Error("the process died"); writes++; if (writes === o.crashAt) { dead = true; throw new Error("the process died"); } return real(r); };
  else w.store.putRun = async (/** @type {any} */ r) => { writes++; return real(r); };
  w.kernel.inbound("payment.received", built.input ?? {});
  await settle(w);
  /** @type {any} */ let runner = w.runner;
  if (o.crashAt !== undefined) {
    w.store.putRun = real;
    const chains = { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.moduleChain({ module: "flows", approver: x.approver }) };
    runner = new FlowRunner({ kernel: w.kernel, store: w.store, catalog: () => w.cat, chains, clock: () => w.clock.t, emit: () => {}, ports: w.runner.ports });
    await runner.recover(); await runner.drain(); await settle(w); await runner.drain();
  }
  if (sc.finish) { await sc.finish(w, runner); await runner.drain(); await settle(w); }
  const runs = await w.store.listRuns({ flow: id, limit: 50 });
  const root = runs.find((/** @type {any} */ r) => !r.parent) || null;
  return { w, id, writes, root, runs, fingerprint: fingerprint(w) };
}
