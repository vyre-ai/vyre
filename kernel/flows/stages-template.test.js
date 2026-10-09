// @ts-check
// A project started from a template (R031-10): its stages are the ones pinned on the record when it started (`template_snapshot`), its stage is the text field `template_stage`, and the stage module alone
// drives it: tasks with their briefs and doers, "moves on when" (the next stage's entry condition), early moves by the stage owner with a reason, and the next stage entered by the module itself.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { stagedCatalog } from "./testing/fixtures.js";
import { snapshotOf } from "../../lib/project-template.js";

const template = () => ({
  name: "Estate plan",
  roles: [{ role: "attorney" }],
  stages: [
    { name: "Intake", owner: "person:per_bob", tasks: [{ title: "Gather documents", doer: "teammate:research", output: { kind: "note" }, context: ["a folder was shared"] }] },
    { name: "Drafting", moves_on_when: 'repo == "retained"', tasks: [{ title: "Draft the trust", doer: "teammate:research", output: { kind: "draft" }, needs_yes: ["sending it out"] }] },
    { name: "Signing", tasks: [{ title: "Sign", doer: "teammate:research", output: { kind: "decision" } }] },
    { name: "Done" },
  ],
});
const mk = () => world({ kernel: "real", cat: stagedCatalog() });
const sys = (/** @type {any} */ w) => w.kernel.sysChain();
/** A project pinned to the template, entered at its first stage by the module (the way projects.start does it). */
async function start(/** @type {any} */ w, /** @type {any} */ data = {}) {
  const r = await w.kernel.records.create(sys(w), "project", { name: "Rivera", slug: `rivera-${Math.random().toString(36).slice(2, 7)}`, status: "active", template: "tpl_estate", template_version: "1", template_stage: "Intake", template_snapshot: snapshotOf(template(), { id: "tpl_estate", version: 1 }), ...data });
  await w.stages.enter({ urn: r.urn, type: "project", id: r.id, stage: "Intake", entry: "start" });
  await settle(w);
  return r;
}
const stageOf = async (/** @type {any} */ w, /** @type {any} */ r) => (await w.kernel.records.get(sys(w), "project", r.id)).data.template_stage;
const tasks = async (/** @type {any} */ w) => w.kernel.allTasks();
const finish = async (/** @type {any} */ w, /** @type {string} */ title) => { const t = (await tasks(w)).find((/** @type {any} */ x) => x.title === title); await w.kernel.completeTask(t.id); await settle(w); };

test("starting makes the first stage's tasks, each with the brief written from the template, for the doer it names", async () => {
  const w = await mk();
  const r = await start(w);
  const ts = await tasks(w);
  assert.deepEqual(ts.map((/** @type {any} */ t) => t.title), ["Gather documents"]);
  assert.deepEqual([ts[0].doer.kind, ts[0].doer.id, ts[0].stage, ts[0].record], ["agent", "research", "Intake", r.urn]);
  assert.match(ts[0].note, /Goal: Gather documents for Rivera\./, "{record.name} is filled from the project");
  assert.match(ts[0].note, /a folder was shared/);
  assert.equal(await stageOf(w, r), "Intake");
});

test("the stages move on their gates: the required tasks done, then the next stage's condition (moves_on_when), then its tasks are made by the module; a stage with no tasks is where it ends", async () => {
  const w = await mk();
  const r = await start(w);
  await finish(w, "Gather documents");
  assert.equal(await stageOf(w, r), "Drafting", "Intake has no condition on Drafting, so it moves at once");
  assert.ok((await tasks(w)).some((/** @type {any} */ t) => t.title === "Draft the trust" && t.stage === "Drafting"), "Drafting's task was made");
  await finish(w, "Draft the trust");
  assert.equal(await stageOf(w, r), "Drafting", "Drafting moves on when the project is retained: not yet");
  assert.ok(w.stageEvents.some((/** @type {any} */ e) => e.type === "stage.blocked" && /Signing cannot be entered yet/.test(e.data.why)));
  const cur = await w.kernel.records.get(sys(w), "project", r.id);
  await w.kernel.records.update(sys(w), "project", r.id, { repo: "retained" }, cur.version);
  await w.stages.tick(); await settle(w);
  assert.equal(await stageOf(w, r), "Signing");
  await finish(w, "Sign");
  assert.equal(await stageOf(w, r), "Done");
});

test("the stage's owner moves it on early with a reason, which stays on the ledger, and the next stage is entered; a stranger is refused; a running project keeps the version it started with", async () => {
  const w = await mk();
  const r = await start(w);
  const g = w.stages.entries().find((/** @type {any} */ e) => e.stage === "Intake");
  await assert.rejects(() => w.stages.advance(g.run, { kind: "person", id: "per_zed" }, "i want to"), /only the stage's owner or an admin/);
  const out = await w.stages.advance(g.run, BOB, "the client brought everything in person");
  assert.deepEqual([out.from, out.to], ["Intake", "Drafting"]);
  assert.equal(await stageOf(w, r), "Drafting");
  assert.ok((await tasks(w)).some((/** @type {any} */ t) => t.title === "Draft the trust"), "the next stage's tasks exist after an early move too");
  assert.ok(w.stageEvents.some((/** @type {any} */ e) => e.type === "stage.advanced-early" && e.data.by === BOB.id));
  // editing the template afterwards changes nothing here: the stages are on the record
  const snap = JSON.parse((await w.kernel.records.get(sys(w), "project", r.id)).data.template_snapshot);
  assert.deepEqual([snap.template, snap.version, snap.stages.map((/** @type {any} */ s) => s.name)], ["tpl_estate", 1, ["Intake", "Drafting", "Signing", "Done"]]);
  void ALEX;
});
