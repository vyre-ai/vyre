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
