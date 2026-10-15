// A For each goes through at most its limit; a longer list is cut and the run says so (roadmap 0.6 item 13).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";

const flow = (steps) => ({ format: 1, name: "t", label: "T", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });
const make = (id, client) => ({ id, kind: "create", type: "matter", set: { client } });
const run = async (max) => {
  const w = await world();
  await install(w, flow([make("a", "one"), make("b", "two"), make("c", "three"), { id: "f", kind: "find", type: "matter", limit: 20 },
    { id: "each", kind: "repeat", over: "steps.f.rows", as: "m", max, steps: [{ id: "note", kind: "create", type: "matter", set: { client: { expr: "text(m.data.client) + \"!\"" } } }] }]));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  return { w, r: (await w.runner.listRuns())[0] };
};

test("a list longer than the limit is cut, and the step says how many there were", async () => {
  const { w, r } = await run(2);
  assert.equal(r.state, "done", JSON.stringify(r.error));
  assert.deepEqual([r.steps.each.output.count, r.steps.each.output.cut, r.steps.each.output.total], [2, true, 3]);
  assert.equal([...(w.kernel.tables.get("matter") || new Map()).values()].filter((m) => String(m.data.client).endsWith("!")).length, 2);
});

test("a list within the limit is handled whole and says nothing about a cut", async () => {
  const { r } = await run(10);
  assert.equal(r.state, "done");
  assert.equal(r.steps.each.output.count, 3);
  assert.equal(r.steps.each.output.cut, undefined);
});
