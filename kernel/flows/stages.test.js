// Stages made of tasks, on the real gateway and tasks.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX } from "./testing/world.js";
import { stagedCatalog } from "./testing/fixtures.js";
import { taskIdOf } from "./stages.js";

for (const which of ["real"]) {
  const mk = () => world({ kernel: which, cat: stagedCatalog() });
  const sys = w => w.kernel.sysChain ? w.kernel.sysChain() : w.kernel.chainFor({ flow: "t", approver: ALEX, tainted: false, space: w.cat.space });
  const open = async (w, stage = "Intake") => { const r = await w.kernel.records.create(sys(w), "matter", { client: "Jane", stage }); await settle(w); return r; };
  const tasksOf = async w => (await w.kernel.allTasks());
  const byTitle = async (w, t) => (await tasksOf(w)).find(x => x.title === t);
  const stageOf = async (w, r) => (await w.kernel.records.get(sys(w), "matter", r.id)).data.stage;
  const fill = async (w, r) => { const cur = await w.kernel.records.get(sys(w), "matter", r.id); await w.kernel.records.update(sys(w), "matter", r.id, { practice_area: "Estate" }, cur.version); };
  const finish = async (w, title) => { const t = await byTitle(w, title); await w.kernel.completeTask(t.id); await settle(w); };

  test(`stages (${which}): entering a stage makes its tasks, wired with depends_on, doers resolved, once per entry`, async () => {
    const w = await mk();
    const r = await open(w);
    const ts = await tasksOf(w);
    assert.deepEqual(ts.map(t => t.title), ["Research the client", "Welcome email"]);
    const [research, welcome] = ts;
    assert.deepEqual([research.doer.kind, research.doer.id, research.state], ["agent", "research", "ready"]);
    assert.equal(research.record, r.urn);
    assert.equal(research.stage, "Intake");
    assert.equal(research.required, undefined, "no checker, so the kernel is not asked to guard it (the module keeps its own required list)");
    assert.ok(research.due > 0);
    assert.equal(welcome.state, "waiting", "it waits for the research");
    assert.equal(welcome.required, true);
    assert.deepEqual(welcome.depends_on, [research.id]);
    assert.deepEqual(welcome.checker, { role: "attorney" });
    assert.equal(welcome.template, `vyre://${w.cat.space}/template/welcome`);
    // the same entry delivered again makes nothing new
    const entered = w.which === "real" ? w.kernel.rawLog.read({ type: "record.stage-entered" })[0] : w.kernel.log.find(e => e.type === "record.stage-entered");
    await w.stages.onEvent(entered); await settle(w);
    assert.equal((await tasksOf(w)).length, 2);
  });

  test(`stages (${which}): finishing the required tasks moves the record on by itself, once`, async () => {
    const w = await mk();
    const r = await open(w);
    await fill(w, r);
    await finish(w, "Research the client");
    assert.equal(await stageOf(w, r), "Intake", "one task left");
    await finish(w, "Welcome email");
    assert.equal(await stageOf(w, r), "Engagement");
    assert.ok(w.stageEvents.some(e => e.type === "stage.advanced" && e.data.from === "Intake" && e.data.to === "Engagement"));
    assert.equal((await tasksOf(w)).filter(t => t.stage === "Engagement").length, 1, "entering Engagement made its task");
    assert.equal((await byTitle(w, "Engagement letter signed")).doer.id, "per_alex", "a role resolves to the first person holding it");
    // a late repeat of a task event does not advance again
    const n = w.stageEvents.filter(e => e.type === "stage.advanced").length;
    await w.stages.settle(w.stages.entries()[0].key); await settle(w);
    assert.equal(w.stageEvents.filter(e => e.type === "stage.advanced").length, n);
  });

  test(`stages (${which}): a stuck task and a rejected one hold the stage; nothing is made twice`, async () => {
    const w = await mk();
    const r = await open(w);
    await fill(w, r);
    const research = await byTitle(w, "Research the client");
    if (which === "real") { const doer = w.kernel.as(research.doer); await w.kernel.tasksApi.start(doer, research.id); await w.kernel.tasksApi.stuck(doer, research.id, { reason: "the court portal password changed" }); }
    else w.kernel.completeTask(research.id, { state: "stuck", outcome: "cancelled" });
    await settle(w);
    assert.equal(await stageOf(w, r), "Intake");
    assert.ok(w.stageEvents.some(e => e.type === "stage.blocked"), "the module says the stage is blocked");
    assert.equal((await tasksOf(w)).length, 2);
  });

  test(`stages (${which}): a stage with no tasks never advances by itself, and a stage of only optional tasks advances when they are finished`, async () => {
    const w = await mk();
    const r = await open(w, "Drafting");
    assert.equal(await stageOf(w, r), "Drafting");
    assert.equal((await tasksOf(w)).length, 0);
    const r2 = await open(w, "Review");
    const polish = await byTitle(w, "Optional polish");
    assert.equal(polish.required, undefined, "an optional task is not required");
    await w.kernel.completeTask(polish.id); await settle(w);
    assert.equal(await stageOf(w, r2), "Closed");
    assert.equal((await tasksOf(w)).filter(t => t.record === r2.urn).length, 1);
  });

  test(`stages (${which}): a record moved by hand while its tasks were open is left where the person put it`, async () => {
    const w = await mk();
    const r = await open(w);
    await fill(w, r);
    const cur = await w.kernel.records.get(sys(w), "matter", r.id);
    await w.kernel.records.update(sys(w), "matter", r.id, { stage: "Drafting" }, cur.version);
    await settle(w);
    await finish(w, "Research the client");
    await finish(w, "Welcome email");
    assert.equal(await stageOf(w, r), "Drafting");
    assert.ok(w.stageEvents.some(e => e.type === "stage.left-alone"));
  });

  test(`stages (${which}): coming back into a stage is a new entry with new tasks`, async () => {
    const w = await mk();
    const r = await open(w, "Engagement");
    assert.equal((await tasksOf(w)).length, 1);
    let cur = await w.kernel.records.get(sys(w), "matter", r.id);
    await w.kernel.records.update(sys(w), "matter", r.id, { stage: "Drafting" }, cur.version); await settle(w);
    cur = await w.kernel.records.get(sys(w), "matter", r.id);
    await w.kernel.records.update(sys(w), "matter", r.id, { stage: "Engagement" }, cur.version); await settle(w);
    assert.equal((await tasksOf(w)).length, 2);
  });

  const withRules = (patch) => () => { const c = stagedCatalog(); c.types.matter = { ...c.types.matter, ...patch(c.types.matter) }; return c; };

  test(`stages (${which}): a stage's entry condition holds the record where it is until the record meets it`, async () => {
    const w = await world({ kernel: which, cat: withRules((m) => ({ stages: m.stages.map((s) => s.name === "Engagement" ? { ...s, enter_if: 'client == "Joan"' } : s) }))() });
    const r = await open(w);
    await fill(w, r);
    await finish(w, "Research the client");
    await finish(w, "Welcome email");
    assert.equal(await stageOf(w, r), "Intake", "the client is Jane, so Engagement cannot be entered");
    assert.ok(w.stageEvents.some((e) => e.type === "stage.blocked" && /cannot be entered yet/.test(e.data.why)));
    const cur = await w.kernel.records.get(sys(w), "matter", r.id);
    await w.kernel.records.update(sys(w), "matter", r.id, { client: "Joan" }, cur.version);
    await w.stages.settle(w.stages.entries()[0].key); await settle(w);
    assert.equal(await stageOf(w, r), "Engagement", "once it holds, the same entry moves on");
  });

  test(`stages (${which}): a stage set decides which stage comes next for that record`, async () => {
    const estate = { name: "estate", when: 'practice_area == "Estate"', stages: [{ name: "Intake" }, { name: "Review" }, { name: "Closed" }] };
    const w = await world({ kernel: which, cat: withRules(() => ({ stage_sets: [estate] }))() });
    const r = await open(w);
    await fill(w, r);
    await finish(w, "Research the client");
    await finish(w, "Welcome email");
    assert.equal(await stageOf(w, r), "Review", "the estate set goes Intake to Review, the default would go to Engagement");
    const other = await open(w);
    assert.equal(await stageOf(w, other), "Intake");
  });
}

test("stages: the task id comes from the data or, for the kernel's own events, from the subject", () => {
  assert.equal(taskIdOf({ data: { task: "a" } }), "a");
  assert.equal(taskIdOf({ data: { id: "b" } }), "b");
  assert.equal(taskIdOf({ subject: "vyre://spc_x/task/c", data: { state: "done" } }), "c");
  assert.equal(taskIdOf({ subject: "vyre://spc_x/matter/c", data: {} }), null);
});
