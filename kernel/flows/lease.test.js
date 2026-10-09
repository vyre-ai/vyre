// @ts-check
// The Connection lease a stage lends to a task's doer: asked of the vault by port, for the task's life, never made by a stage itself.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX } from "./testing/world.js";
import { stagedCatalog } from "./testing/fixtures.js";
import { createStages } from "./stages.js";

const sys = (/** @type {any} */ w) => w.kernel.sysChain();

/** A catalog whose Intake task names a Connection; the doer is a teammate (an agent) or a role (a person). */
function withCredentials(doer = "teammate:research", credentials = ["orbit-crm"]) {
  const c = stagedCatalog();
  c.types.matter = { ...c.types.matter, stages: c.types.matter.stages.map((/** @type {any} */ s) => s.name === "Intake" ? { ...s, tasks: [{ title: "Look the client up", doer, output: { kind: "note" }, credentials, due_offset_ms: 3_600_000 }] } : s) };
  return c;
}
function rig(/** @type {any} */ cat, /** @type {any} */ leases) {
  return world({ kernel: "real", cat }).then((/** @type {any} */ w) => {
    const log = /** @type {any[]} */ ([]);
    const stages = createStages({ kernel: w.kernel, catalog: () => w.cat, chain: () => w.kernel.moduleChain({ module: "stages", approver: ALEX }), gates: w.runner.gatePort(), hook: true, clock: () => w.clock.t, emit: (/** @type {string} */ type, /** @type {any} */ data) => log.push({ type, data }),
      ports: { roles: () => [ALEX] }, leases: leases ? { lend: async (/** @type {any} */ q) => { log.push({ type: "LEND", data: q }); if (leases.fail) throw new Error("the vault said no"); return {}; }, end: async (/** @type {string} */ task, /** @type {string} */ reason) => { log.push({ type: "END", data: { task, reason } }); } } : undefined });
    w.offs.splice(0).forEach((/** @type {any} */ o) => o());
    w.offs.push(w.kernel.onEvent((/** @type {any} */ e) => stages.onEvent(e), "stages"));
    w.kernel.hooks = { onStageEnter: (/** @type {any} */ e) => stages.onStageEnter(e), stageTasks: (/** @type {string} */ u, /** @type {string} */ s) => stages.stageTasks(u, s) };
    return { w, stages, log };
  });
}
const open = async (/** @type {any} */ w) => { const r = await w.kernel.records.create(sys(w), "matter", { client: "Jane", stage: "Intake" }); await settle(w); return r; };

test("lease: a task that names credentials, with an agent for its doer, lends them for the task's life: until its due time and a day", async () => {
  const { w, stages, log } = await rig(withCredentials(), {});
  const t0 = w.clock.t;
  await open(w); await stages.idle();
  const lend = log.find(e => e.type === "LEND");
  assert.ok(lend, JSON.stringify(log.map(e => e.type)));
  assert.deepEqual([lend.data.agent, lend.data.connections], ["research", ["orbit-crm"]]);
  const task = (await w.kernel.allTasks()).find((/** @type {any} */ t) => t.title === "Look the client up");
  assert.equal(lend.data.task, task.id);
  assert.equal(lend.data.until, task.due + 86_400_000);
  assert.ok(task.due >= t0 + 3_600_000 - 5000);
  assert.ok(log.some(e => e.type === "stage.lease-made"));
});

test("lease: a person for a doer gets no lease, and a task without credentials none", async () => {
  const a = await rig(withCredentials("role:attorney"), {});
  await open(a.w); await a.stages.idle();
  assert.equal(a.log.filter(e => e.type === "LEND").length, 0);
  const b = await rig(stagedCatalog(), {});
  await open(b.w); await b.stages.idle();
  assert.equal(b.log.filter(e => e.type === "LEND").length, 0);
});

test("lease: it ends when the task is done, and once", async () => {
  const { w, stages, log } = await rig(withCredentials(), {});
  await open(w); await stages.idle();
  const task = (await w.kernel.allTasks()).find((/** @type {any} */ t) => t.title === "Look the client up");
  await w.kernel.completeTask(task.id); await settle(w); await stages.idle();
  const ends = log.filter(e => e.type === "END");
  assert.deepEqual(ends.map(e => e.data.task), [task.id]);
  await stages.settle(stages.entries()[0].key); await stages.idle();
  assert.equal(log.filter(e => e.type === "END").length, 1, "not ended again");
});

test("lease: it ends when the record is moved on early, and when the stage is left by hand", async () => {
  const { w, stages, log } = await rig(withCredentials(), {});
  await open(w); await stages.idle();
  const [g] = (await w.runner.listRuns({})).filter((/** @type {any} */ r) => r.gate);
  await stages.advance(g.id, ALEX, "signed in person");
  assert.equal(log.filter(e => e.type === "END").length, 1);
});

test("lease: a lease that cannot be made never stops the stage, and says so; a Space with no way to lend says so too", async () => {
  const bad = await rig(withCredentials(), { fail: true });
  await open(bad.w); await bad.stages.idle();
  assert.ok((await bad.w.kernel.allTasks()).some((/** @type {any} */ t) => t.title === "Look the client up"), "the task was made");
  const ev = bad.log.find(e => e.type === "stage.lease-unavailable");
  assert.match(ev.data.why, /the vault said no/);
  assert.equal(bad.log.filter(e => e.type === "END").length, 0, "nothing to end");
  const none = await rig(withCredentials(), null);
  await open(none.w); await none.stages.idle();
  assert.ok(none.log.some(e => e.type === "stage.lease-unavailable" && /cannot lend/.test(e.data.why)));
});

test("lease: a restart knows which tasks hold a lease and ends them when the gate closes", async () => {
  const { w, stages } = await rig(withCredentials(), {});
  await open(w); await stages.idle();
  const ended = /** @type {string[]} */ ([]);
  const fresh = createStages({ kernel: w.kernel, catalog: () => w.cat, chain: () => w.kernel.moduleChain({ module: "stages", approver: ALEX }), gates: w.runner.gatePort(), hook: true, clock: () => w.clock.t, emit: () => {},
    ports: { roles: () => [ALEX] }, leases: { lend: async () => ({}), end: async (/** @type {string} */ task) => { ended.push(task); } } });
  assert.equal(await fresh.resume(), 1);
  const [g] = (await w.runner.listRuns({})).filter((/** @type {any} */ r) => r.gate);
  await fresh.advance(g.id, ALEX, "done by hand");
  const task = (await w.kernel.allTasks()).find((/** @type {any} */ t) => t.title === "Look the client up");
  assert.deepEqual(ended, [task.id]);
});
