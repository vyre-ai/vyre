// The runner on the real gateway and tasks (testing/real-kernel.js), for the paths where the fake could hide a mismatch: record events,
// idempotency, the automation chain through authorize, the ask task and its approval with a real presence proof, and corr on events.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { onPayment } from "./testing/fixtures.js";

const rows = async (w, type) => (await w.kernel.records.query(w.kernel.sysChain(), type, { page: { limit: 50 } })).rows;
const real = async () => world({ kernel: "real" });

test("real: a payment opens a matter, asks the attorney, and finishes when they approve", async () => {
  const w = await real();
  const { id } = await install(w, onPayment());
  w.kernel.inbound("payment.received", { amount: 500, client: "Jane Doe" });
  await settle(w);
  const runs = await w.runner.listRuns({ flow: id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "waiting");
  const matters = await rows(w, "matter");
  assert.equal(matters.length, 1);
  assert.equal(matters[0].data.stage, "Intake");
  const tasks = await w.kernel.allTasks();
  const ask = tasks.find(t => /Send the engagement letter to Jane Doe/.test(t.title));
  assert.ok(ask, "an ask card for the attorney");
  assert.equal(ask.doer.id, "per_alex");
  await w.kernel.completeTask(ask.id, { answer: { ok: true } });
  await settle(w);
  const done = await w.runner.getRun(runs[0].id);
  assert.equal(done.state, "done");
  // every event the run caused carries the run id as corr (the harness shims it from the chain's job)
  const caused = w.kernel.rawLog.read({ type: "matter.*" });
  assert.ok(caused.length >= 1 && caused.every(e => e.corr === runs[0].id));
  assert.equal(w.kernel.rawLog.verify().ok, true, "the audit chain still verifies");
});

test("real: the same event delivered twice is one run and one matter", async () => {
  const w = await real();
  await install(w, onPayment());
  const e = w.kernel.inbound("payment.received", { amount: 5, client: "A" });
  await settle(w);
  await Promise.all([w.runner.onEvent(e), w.runner.onEvent(e)]);
  await settle(w);
  assert.equal((await w.runner.listRuns()).length, 1);
  assert.equal((await rows(w, "matter")).length, 1);
});

test("real: a lost grant is a denial from the real authorizer, and it pauses the Flow", async () => {
  const w = await real();
  const { id } = await install(w, onPayment());
  w.kernel.gatewayGrants.get(`gr_person_${ALEX.id}`).actions = ["events.read"];
  w.kernel.inbound("payment.received", { amount: 5, client: "A" });
  await settle(w);
  const [run] = await w.runner.listRuns({ flow: id });
  assert.notEqual(run.state, "done");
  assert.equal((await rows(w, "matter")).length, 0, "nothing was written without the approver's grant");
});
