import { test } from "node:test";
import assert from "node:assert/strict";
import { addsLine, asksIn, buildGraph, flowCode, paint } from "./logic.js";

const flow = {
  id: "on_payment", name: "On payment", trigger: "A payment is received", triggerCode: "on: 'event', event: 'payment.received'",
  steps: [
    { id: "who", kind: "find", label: "Look up the payer", args: "type: 'payment'" },
    { id: "big", kind: "decide", label: "Is this a repeat client?", args: "if: 'len(steps.who.rows) > 1'", then: [{ id: "note", kind: "assign", label: "Tell the manager", args: "to: 'role:manager'" }] },
    { id: "ok", kind: "ask", label: "Ask the attorney", args: "to: 'role:attorney'" },
  ],
};

test("the graph has a trigger, one row per step, and a lane for a branch", () => {
  const g = buildGraph(flow);
  assert.deepEqual(g.nodes.map((n) => [n.id, n.lane, n.y]), [["trigger", 0, 0], ["who", 0, 1], ["big", 0, 2], ["note", 1, 3], ["ok", 0, 4]]);
  assert.ok(g.edges.some((e) => e.from === "big" && e.to === "note" && e.kind === "then"));
  assert.ok(g.edges.some((e) => e.from === "big" && e.to === "ok"), "after a branch the flow carries on from the decide itself, as the kernel draws it");
  assert.equal(g.nodes.find((n) => n.id === "ok").waits, true);
});

test("a run is painted: done above, waiting at the stop, pending below; a finished run is all done", () => {
  const g = buildGraph(flow);
  const p = paint(g.nodes, "ok");
  assert.deepEqual(p.map((n) => n.state), ["done", "done", "done", "done", "waiting"]);
  assert.ok(paint(g.nodes, null).every((n) => n.state === "done"));
  assert.equal(paint(g.nodes, "who", "failed", "Could not reach Clio.")[1].note, "Could not reach Clio.");
});

test("See as code prints every step and keeps branches inside their step", () => {
  const t = flowCode(flow);
  assert.match(t, /^import \{ defineFlow, step \} from '@vyre\/sdk';/);
  assert.match(t, /step\.decide\('big', \{ if: 'len\(steps\.who\.rows\) > 1',\n\s+then: \[/);
  assert.match(t, /step\.assign\('note'/);
  assert.doesNotMatch(t, /—|§/);
});

test("asks are counted through branches, and a Kit's additions read as a sentence", () => {
  assert.equal(asksIn(flow.steps), 1);
  assert.equal(addsLine({ types: 2, flows: 3, views: 4, roles: 1 }), "2 record types, 3 Flows, 4 views, 1 role");
  assert.equal(addsLine({ flows: 1 }), "1 Flow");
});
