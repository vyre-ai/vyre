// The Flow builder's record trigger: a type's own created event ("matter.created") starts a Flow, and `event.subject` is the record that started it.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";

test("a type's own created event starts a Flow, which reads the record from event.subject and the fields from trigger.after", async () => {
  const w = await world();
  const chain = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space });
  const { id } = await install(w, { format: 1, name: "on_matter", authorship: "builder", trigger: { on: "event", event: "matter.created" }, steps: [
    { id: "seen", kind: "update", type: "matter", record: { expr: "event.subject" }, set: { stage: "Engagement" } },
    { id: "copy", kind: "create", type: "payment", set: { amount: 1, client: { expr: "trigger.after.client" } } },
  ] });
  const m = await w.kernel.records.create(chain, "matter", { client: "Jane", stage: "Intake" });
  await settle(w);
  const runs = await w.runner.listRuns({ flow: id });
  assert.equal(runs.length, 1, "one created record, one run");
  assert.equal(runs[0].state, "done", JSON.stringify(runs[0].error));
  assert.equal((await w.kernel.records.get(chain, "matter", m.id)).data.stage, "Engagement", "the update reached the record that started the Flow");
});

test("a form trigger hands its body to the steps as `trigger`, and a later step reads the record the create step made", async () => {
  const w = await world();
  const chain = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space });
  const { id } = await install(w, { format: 1, name: "on_form", authorship: "builder", trigger: { on: "web", path: "refund-request" }, steps: [
    { id: "make", kind: "create", type: "matter", set: { client: { expr: "trigger.name" }, stage: "Intake" } },
    { id: "mark", kind: "update", type: "matter", record: { expr: "steps.make.record.id" }, set: { stage: "Engagement" } },
  ] });
  await w.runner.handleWeb("refund-request", { body: { name: "Pat" } });
  await settle(w);
  const [run] = await w.runner.listRuns({ flow: id });
  assert.equal(run.state, "done", JSON.stringify(run.error));
  const rows = (await w.kernel.records.query(chain, "matter", { page: { limit: 10 } })).rows;
  assert.deepEqual(rows.map(r => [r.data.client, r.data.stage]), [["Pat", "Engagement"]]);
});
