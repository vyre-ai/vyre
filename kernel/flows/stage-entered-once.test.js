// A stage move says so once: one record.stage-entered on the log, one run of a Flow that triggers on it.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";

const entries = (w, stage) => w.kernel.rawLog.read({ type: "record.stage-entered" }).filter(e => e.data.stage === stage);

test("stage entered: a move into a stage, and a record created at one, each say so once and start a Flow once", async () => {
  const w = await world();
  const chain = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space });
  const { id } = await install(w, { format: 1, name: "on_engagement", authorship: "human", trigger: { on: "stage", type: "matter", stage: "Engagement" }, steps: [{ id: "n", kind: "create", type: "payment", set: { amount: 1 } }] });

  const m = await w.kernel.records.create(chain, "matter", { client: "Jane", stage: "Intake" });
  await settle(w);
  assert.equal(entries(w, "Intake").length, 1, "created at Intake: one entry");
  assert.equal((await w.runner.listRuns({ flow: id })).length, 0);

  await w.kernel.records.update(chain, "matter", m.id, { stage: "Engagement" }, m.version);
  await settle(w);

  assert.equal(entries(w, "Engagement").length, 1, "one move, one entry on the log");
  const runs = await w.runner.listRuns({ flow: id });
  assert.equal(runs.length, 1, "one entry, one run");
  assert.equal(runs[0].state, "done", JSON.stringify(runs[0].error));

  const n = await w.kernel.records.create(chain, "matter", { client: "Joe", stage: "Engagement" });
  await settle(w);
  assert.equal(entries(w, "Engagement").filter(e => e.subject === n.urn).length, 1, "created at Engagement: one entry");
  assert.equal((await w.runner.listRuns({ flow: id })).length, 2, "and one more run");
});

test("a run is about the record that started it: the record's links find it, and a record that is gone does not lose the run", async () => {
  const w = await world({ store: "records" });
  const chain = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space });
  const { id } = await install(w, { format: 1, name: "on_engagement", label: "Welcome the client", authorship: "human", trigger: { on: "stage", type: "matter", stage: "Engagement" }, steps: [{ id: "n", kind: "create", type: "payment", set: { amount: 1 } }] });
  const m = await w.kernel.records.create(chain, "matter", { client: "Jane", stage: "Intake" });
  await w.kernel.records.update(chain, "matter", m.id, { stage: "Engagement" }, m.version);
  await settle(w);
  const [run] = await w.runner.listRuns({ flow: id });
  assert.equal(run.record, m.urn, "the run names the record the stage move was about");
  const { rows } = await w.kernel.gw.records.linked(chain, m.urn);
  const hit = rows.filter(r => r.type === "flow-run");
  assert.equal(hit.length, 1, "the matter's links find its run");
  assert.deepEqual([hit[0].record.data.title, hit[0].record.data.state], ["Welcome the client", "done"]);

  // the record is removed before a later write of the run: the run is kept, without the link
  const cur = await w.kernel.records.get(chain, "matter", m.id);
  await w.kernel.records.remove(chain, "matter", m.id, cur.version);
  await w.store.putRun({ ...run, updated_at: run.updated_at + 1 });
  assert.equal((await w.runner.getRun(run.id)).id, run.id, "the run is still there");
});
