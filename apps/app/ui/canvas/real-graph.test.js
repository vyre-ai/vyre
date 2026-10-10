// The canvas against the real producer: the graph the kernel's own graph() draws for a Flow with a parallel and a step after it, through the layout the canvas uses.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { graph } from "../../../../kernel/flows/canvas.js";
import { catalog } from "../../../../kernel/flows/testing/fixtures.js";
import { arrange } from "./layout.js";

const lane = (id, steps) => ({ id, kind: "branch", steps });

test("the kernel's parallel Flow lays out with its lanes level and the step after it as the join", () => {
  const flow = { format: 1, name: "par", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps: [
    { id: "p", kind: "parallel", steps: [
      lane("left", [{ id: "a1", kind: "create", type: "matter", set: { client: { expr: "trigger.client" } } }, { id: "a2", kind: "create", type: "matter", set: { client: { expr: "trigger.client" } } }]),
      lane("right", [{ id: "m", kind: "create", type: "matter", set: { client: { expr: "trigger.client" } } }]),
    ] },
    { id: "after", kind: "create", type: "payment", set: { client: { expr: "trigger.client" }, amount: 1 } },
  ] };
  const g = graph(flow, catalog());
  const r = arrange(g.nodes, g.edges);
  const at = Object.fromEntries(r.nodes.map((n) => [n.id, [n.lane, n.y]]));
  assert.equal(at.left[1], at.right[1], "the two lanes start on the same row");
  assert.notEqual(at.left[0], at.right[0], "in different columns");
    assert.deepEqual(r.joins, ["p:join"]);
  assert.deepEqual(r.edges.filter((e) => e.kind === "join").map((e) => e.from).sort(), ["a2", "m"]);
  assert.ok(at["p:join"][1] > Math.max(at.a2[1], at.m[1]) && at.after[1] > at["p:join"][1], "the join sits under the lanes and the step after under the join");
});
