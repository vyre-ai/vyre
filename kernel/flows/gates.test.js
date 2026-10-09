// @ts-check
// s1: a stage with tasks is a gate on the runner: written down, shown, logged, and the record can be moved on early by the people who may.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { stagedCatalog } from "./testing/fixtures.js";
import { createStages } from "./stages.js";
import { describeRun, explainRun } from "./describe.js";
import { timelineOf } from "./timeline.js";

const mk = () => world({ kernel: "real", cat: stagedCatalog() });
const sys = (/** @type {any} */ w) => w.kernel.sysChain();
const open = async (/** @type {any} */ w, stage = "Intake") => { const r = await w.kernel.records.create(sys(w), "matter", { client: "Jane", stage }); await settle(w); return r; };
const stageOf = async (/** @type {any} */ w, /** @type {any} */ r) => (await w.kernel.records.get(sys(w), "matter", r.id)).data.stage;
const gatesOf = async (/** @type {any} */ w) => (await w.runner.listRuns({})).filter((/** @type {any} */ r) => r.gate);
const finish = async (/** @type {any} */ w, /** @type {string} */ title) => { const t = (await w.kernel.allTasks()).find((/** @type {any} */ x) => x.title === title); await w.kernel.completeTask(t.id); await settle(w); };

test("s1: entering a stage with tasks opens a gate run that lists its tasks", async () => {
  const w = await mk();
  const r = await open(w);
  const [g] = await gatesOf(w);
  assert.ok(g, "a gate run exists");
  assert.equal(g.state, "waiting");
  assert.equal(g.gate.stage, "Intake");
  assert.equal(g.gate.next, "Engagement");
  assert.deepEqual(Object.keys(g.steps), ["tasks", "task:Research the client", "task:Welcome email"]);
  assert.equal(g.gate.urn, r.urn);
  const lines = describeRun(g, null);
  assert.match(lines[0], /^Stage gate for matter .* in Intake, then Engagement\./);
  assert.ok(lines.some((/** @type {string} */ l) => /0 of 2 tasks done/.test(l)), lines.join("\n"));
  assert.ok(lines.some((/** @type {string} */ l) => /role:attorney \(or an admin\) can move it on early/.test(l)));
  assert.match(explainRun(g, null), /entered Intake, which has 2 tasks; 0 done\. When they are done it moves on to Engagement\./);
  assert.ok(timelineOf(g, null).lines.length >= 3, "the timeline shows the gate's steps");
});

test("s1: finishing the tasks moves the record on and closes the gate with a move on its ledger", async () => {
  const w = await mk();
  const r = await open(w);
  const cur = await w.kernel.records.get(sys(w), "matter", r.id);
  await w.kernel.records.update(sys(w), "matter", r.id, { practice_area: "Estate" }, cur.version);
  await finish(w, "Research the client");
  const [mid] = await gatesOf(w);
  assert.equal(mid.steps["task:Research the client"].status, "done");
  assert.equal(mid.steps["task:Welcome email"].status, "waiting");
  await finish(w, "Welcome email");
  assert.equal(await stageOf(w, r), "Engagement");
  const g = (await gatesOf(w)).find((/** @type {any} */ x) => x.gate.stage === "Intake");
  assert.equal(g.state, "done");
  assert.equal(g.steps.move.output.to, "Engagement");
  assert.match(explainRun(g, null), /Its tasks were done, so it moved on to Engagement\./);
});

test("s1: the stage's owner moves a record on early with a reason, which stays on the ledger; anyone else is refused", async () => {
  const w = await mk();
  const r = await open(w);
  const [g] = await gatesOf(w);
  await assert.rejects(() => w.stages.advance(g.id, { kind: "person", id: "per_zed" }, "i want to"), /only the stage's owner or an admin/);
  await assert.rejects(() => w.stages.advance(g.id, BOB, "  "), /reason is required/);
  const out = await w.stages.advance(g.id, BOB, "the client signed in person");
  assert.deepEqual([out.from, out.to], ["Intake", "Engagement"]);
  assert.equal(await stageOf(w, r), "Engagement");
  const done = await w.runner.getRun(g.id);
  assert.equal(done.state, "done");
  assert.deepEqual([done.steps.move.output.early, done.steps.move.output.by, done.steps.move.output.reason], [true, BOB.id, "the client signed in person"]);
  assert.match(explainRun(done, null), new RegExp(`${BOB.id} moved it on early to Engagement: the client signed in person`));
  assert.ok(w.stageEvents.some((/** @type {any} */ e) => e.type === "stage.advanced-early" && e.data.by === BOB.id));
  await assert.rejects(() => w.stages.advance(g.id, BOB, "again"), /already over/);
  // finishing the tasks afterwards moves nothing a second time
  const c2 = await w.kernel.records.get(sys(w), "matter", r.id);
  await w.kernel.records.update(sys(w), "matter", r.id, { practice_area: "Estate" }, c2.version);
  await finish(w, "Research the client");
  assert.equal(await stageOf(w, r), "Engagement");
});

test("s1: a gate is not retried or cancelled like a Flow run", async () => {
  const w = await mk();
  await open(w);
  const [g] = await gatesOf(w);
  await assert.rejects(() => w.runner.cancel(g.id, {}), /not cancelled/);
  await assert.rejects(() => w.runner.retry(g.id, {}), /not retried/);
});

test("s1: a restart loses nothing: the new module takes the open gates back and finishes the stage once", async () => {
  const w = await mk();
  const r = await open(w);
  const cur = await w.kernel.records.get(sys(w), "matter", r.id);
  await w.kernel.records.update(sys(w), "matter", r.id, { practice_area: "Estate" }, cur.version);
  const fresh = createStages({ kernel: w.kernel, catalog: () => w.cat, chain: () => w.kernel.moduleChain({ module: "stages", approver: ALEX }), gates: w.runner.gatePort(), clock: () => w.clock.t, emit: () => {}, hook: true,
    ports: { roles: () => [ALEX, BOB] } });
  assert.equal(fresh.entries().length, 0, "it starts knowing nothing");
  assert.equal(await fresh.resume(), 1, "it takes the one open gate back");
  w.offs.splice(0).forEach((/** @type {any} */ o) => o());                      // the old module stops listening
  w.offs.push(w.kernel.onEvent((/** @type {any} */ e) => fresh.onEvent(e), "stages2"));
  await finish(w, "Research the client"); await finish(w, "Welcome email");
  await fresh.idle();
  assert.equal(await stageOf(w, r), "Engagement");
  const titles = (await w.kernel.allTasks()).filter((/** @type {any} */ t) => t.stage === "Intake").map((/** @type {any} */ t) => t.title);
  assert.deepEqual(titles, [...new Set(titles)], "no task was made twice");
});

test("s1: a stage held back by the next stage's entry condition shows it on the gate, and the tick moves it on once it holds", async () => {
  const c = stagedCatalog();
  c.types.matter = { ...c.types.matter, stages: c.types.matter.stages.map((/** @type {any} */ s) => s.name === "Engagement" ? { ...s, enter_if: 'client == "Joan"' } : s) };
  const w = await world({ kernel: "real", cat: c });
  const r = await open(w);
  const cur = await w.kernel.records.get(sys(w), "matter", r.id);
  await w.kernel.records.update(sys(w), "matter", r.id, { practice_area: "Estate" }, cur.version);
  await finish(w, "Research the client"); await finish(w, "Welcome email");
  let [g] = await gatesOf(w);
  assert.equal(g.steps.condition.status, "waiting");
  assert.match(g.steps.condition.output.say, /Engagement cannot be entered yet/);
  assert.match(describeRun(g, null).join("\n"), /Held by the next stage: Engagement cannot be entered yet/);
  const now = await w.kernel.records.get(sys(w), "matter", r.id);
  await w.kernel.records.update(sys(w), "matter", r.id, { client: "Joan" }, now.version);
  await w.stages.tick(); await settle(w);
  assert.equal(await stageOf(w, r), "Engagement");
  g = (await gatesOf(w))[0];
  assert.equal(g.state, "done");
});
