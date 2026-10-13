// @ts-check
// When a template stage counts as done, and whether projects move through stages at all: "done_when" per stage (every task, only the tasks needed to finish, or a person's sign-off) and `stage_mode` per template
// (stages in order, in any order, or none: a person moves a project or nobody does). Built on the stage module's own rule: the required tasks done move the stage on.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { stagedCatalog } from "./testing/fixtures.js";
import { snapshotOf, problems } from "../../lib/project-template.js";

const task = (/** @type {string} */ title, /** @type {any} */ more = {}) => ({ title, doer: "teammate:research", output: { kind: "note" }, ...more });
const tpl = (/** @type {any} */ over = {}) => ({ name: "Matter", roles: [{ role: "attorney" }], stages: [{ name: "Opening", tasks: [task("A"), task("B", { required: false })] }, { name: "Review", tasks: [task("C")] }, { name: "Done" }], ...over });
const mk = () => world({ kernel: "real", cat: stagedCatalog() });
async function start(/** @type {any} */ w, /** @type {any} */ t) {
  const k = w.kernel, sys = k.sysChain();
  const r = await k.records.create(sys, "project", { name: "Rivera", slug: `r-${Math.random().toString(36).slice(2, 7)}`, status: "active", template: "tpl_m", template_version: "1", template_stage: t.stages[0].name, template_snapshot: snapshotOf(t, { id: "tpl_m", version: 1 }) });
  await w.stages.enter({ urn: r.urn, type: "project", id: r.id, stage: t.stages[0].name, entry: "start" });
  await settle(w);
  return r;
}
const stageOf = async (/** @type {any} */ w, /** @type {any} */ r) => (await w.kernel.records.get(w.kernel.sysChain(), "project", r.id)).data.template_stage;
const finish = async (/** @type {any} */ w, /** @type {string} */ title) => { const t = (await w.kernel.allTasks()).find((/** @type {any} */ x) => x.title === title); await w.kernel.completeTask(t.id); await settle(w); };

test("the shape: a stage says when it is done, a template says how its stages run, each in a short list of words", () => {
  const ok = tpl({ stage_mode: "any" }); ok.stages[0].done_when = "all"; ok.stages[1].done_when = "needed"; ok.stages[1].sign_off = undefined;
  delete ok.stages[1].sign_off; assert.deepEqual(problems(ok), []);
  const sign = tpl(); sign.stages[1].done_when = "sign_off"; sign.stages[1].sign_off = "role:attorney"; assert.deepEqual(problems(sign), []);
  const bad = (/** @type {(t: any) => void} */ f, /** @type {RegExp} */ re, /** @type {string} */ at) => { const t = tpl(); f(t); assert.ok(problems(t).some((p) => re.test(p.message) && p.path.startsWith(at)), JSON.stringify(problems(t))); };
  bad((t) => { t.stage_mode = "sometimes"; }, /stage_mode is one of/, "stage_mode");
  bad((t) => { t.stages[0].done_when = "whenever"; }, /done_when is one of/, "stages[0].done_when");
  bad((t) => { t.stages[0].done_when = "sign_off"; }, /sign_off names who signs/, "stages[0].sign_off");
  bad((t) => { t.stages[0].done_when = "all"; t.stages[0].sign_off = "role:attorney"; }, /sign_off is only for done_when sign_off/, "stages[0].sign_off");
  bad((t) => { t.stages[0].done_when = "sign_off"; t.stages[0].sign_off = "somebody"; }, /sign_off names who signs/, "stages[0].sign_off");
});

test("done when every task is done: a task marked optional still has to be finished", async () => {
  const w = await mk(); const t = tpl(); t.stages[0].done_when = "all";
  const r = await start(w, t);
  await finish(w, "A");
  assert.equal(await stageOf(w, r), "Opening", "B is not done, and the stage waits for it");
  await finish(w, "B");
  assert.equal(await stageOf(w, r), "Review");
});

test("done when the tasks needed to finish are done: the optional one does not hold the stage", async () => {
  const w = await mk(); const t = tpl(); t.stages[0].done_when = "needed";
  const r = await start(w, t);
  await finish(w, "A");
  assert.equal(await stageOf(w, r), "Review");
});

test("done when a person signs it off: the tasks done is not enough; the person (here the role's holder) moves it on, an outsider cannot", async () => {
  const w = await mk(); const t = tpl(); t.stages[0].done_when = "sign_off"; t.stages[0].sign_off = "person:per_bob";
  const r = await start(w, t);
  await finish(w, "A");
  assert.equal(await stageOf(w, r), "Opening", "the tasks are done and the stage waits for the sign-off");
  assert.ok(w.stageEvents.some((/** @type {any} */ e) => e.type === "stage.waiting" && /sign/.test(e.data.why)), "it says it waits for a sign-off");
  const gate = [...w.stages.entries()].find((/** @type {any} */ e) => e.stage === "Opening");
  await assert.rejects(w.stages.advance(gate.run, { kind: "person", id: "per_nobody" }, "looks fine"), /only the stage's owner/);
  await w.stages.advance(gate.run, { kind: "person", id: BOB.id }, "Signed off");
  await settle(w);
  assert.equal(await stageOf(w, r), "Review");
});

test("stages in any order or none: finishing the tasks never moves the project on by itself", async () => {
  for (const mode of ["any", "none"]) {
    const w = await mk(); const t = tpl({ stage_mode: mode });
    const r = await start(w, t);
    await finish(w, "A");
    assert.equal(await stageOf(w, r), "Opening", `${mode}: a person moves it, not the module`);
  }
  void ALEX;
});
