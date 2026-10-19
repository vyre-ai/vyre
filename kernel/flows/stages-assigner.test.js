// @ts-check
// A Playbook (stage) task that puts an agent to work is assigned by the person whose write moved the record into the stage, so the agent's job runs as that person, on their own AI account
// (core/daemon/agent-wake.js wakes the agent as the task's assigned_by). The other tasks stay the module's, as before. With no mover the module assigns, as before.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { stagedCatalog } from "./testing/fixtures.js";
import { snapshotOf } from "../../lib/project-template.js";
import { createStages } from "./stages.js";

const tpl = () => ({
  name: "Matter", noun: { one: "Matter", many: "Matters" }, roles: [{ role: "attorney" }],
  stages: [
    { name: "Opening", tasks: [
      { title: "Agent task", doer: "teammate:research", output: { kind: "note" } },
      { title: "Person task", doer: "person:per_bob", output: { kind: "note" } },
      { title: "Reviewed by an agent", doer: "person:per_bob", output: { kind: "note" }, reviewer: { who: "teammate:research" } },
    ] },
    { name: "Done" },
  ],
});

/** The world, and a stages module of its own that knows how a person assigns (the daemon's chainFor: [person, service:flows]). */
async function setUp() {
  const w = await world({ cat: stagedCatalog() });
  const k = w.kernel;
  const stages = createStages({ kernel: k, catalog: () => w.cat, chain: () => k.moduleChain({ module: "stages", approver: ALEX }),
    chainFor: (/** @type {string} */ p) => k.moduleChain({ module: "flows", approver: { kind: "person", id: p, space: w.cat.space } }), clock: () => w.clock.t, emit: () => {},
    ports: { roles: (/** @type {string} */ _s, /** @type {string} */ role) => (role === "attorney" ? [ALEX, BOB] : []) } });
  const project = async () => k.records.create(k.sysChain(), "project", { name: "Rivera", slug: `r-${Math.random().toString(36).slice(2, 7)}`, status: "active", template: "tpl_matter", template_version: "1", template_stage: "Opening", template_snapshot: snapshotOf(tpl(), { id: "tpl_matter", version: 1 }) });
  const byTitle = async (/** @type {string} */ title, /** @type {string} */ urn) => (await k.allTasks()).find((/** @type {any} */ t) => t.title === title && t.record === urn);
  return { w, k, stages, project, byTitle };
}

test("a stage task given to an agent records the person who moved the record there as its assigner; a person's task stays the module's", async () => {
  const { w, stages, project, byTitle } = await setUp();
  const r = await project();
  await stages.enter({ urn: r.urn, type: "project", id: r.id, stage: "Opening", entry: "start", by: BOB.id });
  await settle(w); await stages.idle();
  const agent = await byTitle("Agent task", r.urn), person = await byTitle("Person task", r.urn), reviewed = await byTitle("Reviewed by an agent", r.urn);
  assert.ok(agent && person && reviewed, "the tasks were made");
  assert.equal(agent.assigned_by.id, BOB.id, "the agent's task is Bob's to have given");
  assert.equal(reviewed.assigned_by.id, BOB.id, "so is one an agent reviews");
  assert.equal(person.assigned_by.id, ALEX.id, "a person's task is the module's, as before");
});

test("the gateway's hook takes the mover from the writer's chain; with no mover the module assigns, as before", async () => {
  const { w, k, stages, project, byTitle } = await setUp();
  const r = await project();
  await stages.onStageEnter({ record: r.urn, stage: "Opening", templates: tpl().stages[0].tasks, chain: k.as(BOB) });
  await settle(w); await stages.idle(); await new Promise(res => setTimeout(res, 50)); await stages.idle();
  assert.equal((await byTitle("Agent task", r.urn)).assigned_by.id, BOB.id, "the person on the writer's chain");
  const r2 = await project();
  await stages.enter({ urn: r2.urn, type: "project", id: r2.id, stage: "Opening", entry: "start" });
  await settle(w); await stages.idle();
  assert.equal((await byTitle("Agent task", r2.urn)).assigned_by.id, ALEX.id, "no mover: the module's chain");
});
