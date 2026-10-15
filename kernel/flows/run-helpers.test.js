// What a run can print about itself (roadmap 0.6 item 12b): its number among the Flow's, the Flow's name, who approved it, who started it and the Space's name. Fixed once when the run starts.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";

const flow = { format: 1, name: "refunds", label: "Refund requests", authorship: "human", trigger: { on: "manual" }, steps: [
  { id: "note", kind: "create", type: "matter", set: { client: { expr: `"Run " + text(run.number) + " of " + text(run.flow_name) + " for " + text(run.approver_name) + ", started by " + text(run.starter_name) + ", in " + text(run.space_name)` } } }] };
const matters = (w) => [...(w.kernel.tables.get("matter") || new Map()).values()].map((m) => m.data.client).sort();

test("a run prints its number, the Flow's name, the approver, the starter and the Space", async () => {
  const w = await world({ kernel: "real", ports: { names: async (q) => (q.person ? (q.person === ALEX.id ? "Alex Rivera" : "Someone") : "Harlow Legal") } });
  const { id } = await install(w, flow);
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  assert.deepEqual(matters(w), ["Run 1 of Refund requests for Alex Rivera, started by Alex Rivera, in Harlow Legal", "Run 2 of Refund requests for Alex Rivera, started by Alex Rivera, in Harlow Legal"]);
});

test("a name the host cannot find prints as nothing, and a host with no names still gives the number and the Flow's name", async () => {
  const w = await world({ kernel: "real" });
  const { id } = await install(w, flow);
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  assert.deepEqual(matters(w), ["Run 1 of Refund requests for , started by , in "]);
});

for (const kind of ["memory", "records"]) {
  test(`run numbers only grow, in the ${kind} store: concurrent starts never share a number and a number is never given twice`, async () => {
    const w = await world({ kernel: "real", ...(kind === "records" ? { store: "records" } : {}) });
    const { id } = await install(w, flow);
    const got = await Promise.all([1, 2, 3, 4, 5].map(() => w.store.nextRunNumber(id)));
    assert.deepEqual([...got].sort((a, b) => a - b), [1, 2, 3, 4, 5], "five at once, five different numbers");
    assert.equal(await w.store.nextRunNumber(id), 6);
    assert.equal(await w.store.nextRunNumber("another_flow"), 1, "each Flow counts for itself");
    // a run takes the next number whatever runs the Flow still holds: with every earlier run gone the count does not start over
    await w.runner.start(id, {}, w.kernel.as(ALEX));
    await settle(w);
    const run = (await w.runner.listRuns({ flow: id }))[0];
    assert.equal(run.number, 7);
  });
}
