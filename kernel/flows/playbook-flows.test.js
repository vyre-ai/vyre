// @ts-check
// Playbooks are Flows (team/0.6/DESIGN-tasks-v2.md, "the stage runs as a Flow"): a record entering a stage starts that stage's stored Flow once; its tasks are the Flow's tasks with their three slots;
// the last step moves the record on; a stage run from before the change is taken over by its Flow with its open tasks kept; an agent's task is the mover's, and a write with no person starts no agent.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { catalog } from "./testing/fixtures.js";
import { stageKey } from "./stage-flow.js";
import { kitFromLibrary } from "../../records/kits/library.js";

/** A neutral type with stages made of to-dos. */
const ticketCatalog = () => {
  const c = catalog();
  /** @type {any} */ (c.types).ticket = {
    name: "ticket", label: "Ticket",
    fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["Open", "Review", "Closed"] }],
    stages: [
      { name: "Open", tasks: [
        { title: "Draft the reply", doer: "teammate:research", output: { kind: "note" }, reviewer: { who: "person:per_bob" } },
        { title: "Check the details", doer: "person:per_bob", output: { kind: "note" }, approver: { who: "person:per_alex" } },
      ] },
      { name: "Review", tasks: [{ title: "Read it over", doer: "person:per_bob", output: { kind: "note" } }] },
      { name: "Closed" },
    ],
  };
  return c;
};
const sys = (/** @type {any} */ w) => w.kernel.sysChain();
const tasksOf = async (/** @type {any} */ w, /** @type {string} */ urn) => (await w.kernel.allTasks()).filter((/** @type {any} */ t) => t.record === urn);
/** The stored Flow that holds a stage. @param {any} w @param {string} key */
const flowFor = async (w, key) => (await w.store.activeFlows()).find((/** @type {any} */ v) => v.flow.playbook && v.flow.playbook.key === key);
const runsOf = async (/** @type {any} */ w, /** @type {string} */ flow) => (await w.runner.listRuns({})).filter((/** @type {any} */ r) => r.flow === flow);

test("a record entering a stage starts the stage's Flow once, and a re-save starts nothing more", async () => {
  const w = await world({ cat: ticketCatalog(), movers: true, stageFlows: true });
  const r = await w.kernel.records.create(w.kernel.as(BOB), "ticket", { title: "Leaking tap", stage: "Open" }); await settle(w);
  const sf = await flowFor(w, stageKey({ type: "ticket", stage: "Open" }));
  assert.ok(sf, "the stage is a stored Flow, turned on");
  assert.deepEqual(sf.flow.trigger, { on: "stage", type: "ticket", stage: "Open" });
  assert.equal(sf.approver.id, ALEX.id, "made and turned on as the Kit's installer");
  const runs = await runsOf(w, sf.id);
  assert.equal(runs.length, 1, "one run of the stage's Flow");
  assert.equal(runs[0].trigger.kind, "stage");
  assert.equal((await tasksOf(w, r.urn)).length, 2);
  // a re-save of the record in the same stage: no new run, no new task (and the runner never started the stage Flow from its own trigger matching)
  const cur = await w.kernel.records.get(sys(w), "ticket", r.id);
  await w.kernel.records.update(sys(w), "ticket", r.id, { title: "Leaking tap, kitchen" }, cur.version); await settle(w);
  assert.equal((await runsOf(w, sf.id)).length, 1, "NEGATIVE: not twice");
  assert.equal((await tasksOf(w, r.urn)).length, 2, "NEGATIVE: no task made twice");
});

test("the stage's tasks are the Flow's tasks, with Assigned, Reviewer and Approver as the stage gave them", async () => {
  const w = await world({ cat: ticketCatalog(), movers: true, stageFlows: true });
  const r = await w.kernel.records.create(w.kernel.as(BOB), "ticket", { title: "New sign", stage: "Open" }); await settle(w);
  const sf = await flowFor(w, stageKey({ type: "ticket", stage: "Open" }));
  const ts = await tasksOf(w, r.urn);
  const draft = ts.find((/** @type {any} */ t) => t.title === "Draft the reply"), check = ts.find((/** @type {any} */ t) => t.title === "Check the details");
  assert.equal(draft.doer.id, "research");
  assert.equal(draft.reviewer && draft.reviewer.id, BOB.id, "Reviewer");
  assert.equal(check.doer.id, BOB.id);
  assert.equal(check.checker && check.checker.id, ALEX.id, "Approver");
  for (const t of ts) { assert.equal(t.source, "flow_step", `${t.title}: a Flow task`); assert.equal(t.flow, sf.id, `${t.title}: from the stage's Flow`); }
});

test("finishing the stage's tasks runs its last step: the record moves to the next stage and the run is done", async () => {
  const w = await world({ cat: ticketCatalog(), movers: true, stageFlows: true });
  const r = await w.kernel.records.create(w.kernel.as(BOB), "ticket", { title: "Fence", stage: "Review" }); await settle(w);
  const sf = await flowFor(w, stageKey({ type: "ticket", stage: "Review" }));
  const [t] = await tasksOf(w, r.urn);
  await w.kernel.completeTask(t.id); await settle(w);
  assert.equal((await w.kernel.records.get(sys(w), "ticket", r.id)).data.stage, "Closed");
  const [run] = await runsOf(w, sf.id);
  assert.equal(run.state, "done");
  assert.equal(run.steps.move.status, "done");
  assert.deepEqual(run.steps.move.output, { to: "Closed" });
});

test("an agent's task in a stage is the mover's, so it runs on their own account; a write with no person starts no agent and says why", async () => {
  const w = await world({ cat: ticketCatalog(), movers: true, stageFlows: true });
  const r = await w.kernel.records.create(w.kernel.as(BOB), "ticket", { title: "Gate", stage: "Open" }); await settle(w);
  const draft = (await tasksOf(w, r.urn)).find((/** @type {any} */ t) => t.title === "Draft the reply");
  assert.equal(draft.assigned_by.id, BOB.id, "the mover assigns the agent's task: the agent works as them, on their AI account");
  assert.notEqual(draft.assigned_by.id, ALEX.id, "NEGATIVE: never the Flow's maker");
  const svc = w.kernel.as({ kind: "service", id: "ingress" });
  const r2 = await w.kernel.records.create(svc, "ticket", { title: "Hedge", stage: "Open" }); await settle(w);
  const made = await tasksOf(w, r2.urn);
  assert.equal(made.find((/** @type {any} */ t) => t.title === "Draft the reply"), undefined, "NEGATIVE: no agent task");
  assert.ok(made.find((/** @type {any} */ t) => t.title === "Check the details"), "the person's task is still made");
  assert.ok(w.stageEvents.some((/** @type {any} */ e) => e.type === "stage.error" && e.data.record === r2.urn && e.data.why === "no person moved this record, so no agent was started"));
});

test("upgrade: the base Kit's stages become Flows; a stage run from before is taken over with its open task kept, not made twice, and still moves the record on", async () => {
  // the base Kit's project type, with a to-do in two of its stages (the Kit ships them empty)
  const base = kitFromLibrary("base").includes.types.find((/** @type {any} */ t) => t.name === "project");
  const c = catalog();
  /** @type {any} */ (c.types).project = { ...base, stages: base.stages.map((/** @type {any} */ s) => s.name === "New" ? { ...s, tasks: [{ title: "Write the brief", doer: "person:per_bob", output: { kind: "note" } }] } : s.name === "Review" ? { ...s, tasks: [{ title: "Read it over", doer: "person:per_bob", output: { kind: "note" } }] } : s) };
  // before: the old stage engine, no stage Flows
  const w = await world({ cat: c });
  const r = await w.kernel.records.create(sys(w), "project", { name: "Garden shed", stage: "New" }); await settle(w);
  const [before] = (await w.runner.listRuns({})).filter((/** @type {any} */ x) => x.gate && x.gate.urn === r.urn);
  assert.equal(before.flow, "gate:project:New", "the old synthesized gate");
  const [open] = await tasksOf(w, r.urn);
  assert.equal(open.state, "ready");
  // the upgrade: every stage with to-dos gets its Flow, and the open run is taken over
  const q = (/** @type {any} */ x) => ({ ...x, approver: ALEX });
  for (const x of await w.stages.catalogQueries()) await w.runner.stageFlow(q(x));
  const adopt = () => w.runner.adoptGates(async (/** @type {any} */ g) => { const x = await w.stages.queryForGate(g); return x ? q(x) : null; });
  assert.deepEqual(await adopt(), { adopted: 1, left: 0 });
  const sfNew = await flowFor(w, stageKey({ type: "project", stage: "New" }));
  assert.ok(sfNew && await flowFor(w, stageKey({ type: "project", stage: "Review" })), "each base stage with to-dos is a Flow");
  const after = await w.runner.getRun(before.id);
  assert.equal(after.flow, sfNew.id, "the same run now belongs to the stage's Flow");
  assert.equal(after.steps["task:Write the brief"].task, open.id, "its open task is the same task");
  assert.deepEqual(await adopt(), { adopted: 0, left: 0 }, "again: nothing to do");
  assert.equal((await tasksOf(w, r.urn)).length, 1, "NEGATIVE: not duplicated");
  // the open task still moves the record on, through the Flow's run
  await w.kernel.completeTask(open.id); await settle(w);
  assert.equal((await w.kernel.records.get(sys(w), "project", r.id)).data.stage, "Active");
  assert.equal((await w.runner.getRun(before.id)).state, "done");
});
