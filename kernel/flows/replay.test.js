// Try it on last week (R032-10): the real triggers of a window replayed through a version of a Flow, set beside what the Flow really did.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { compareHistory, stepsDone } from "./replay.js";

const DAY = 86_400_000;
const mine = (w, type) => [...(w.kernel.tables.get(type) || new Map()).values()];
const steps = limit => [
  { id: "m", kind: "create", type: "matter", set: { client: { expr: "trigger.client" } } },
  { id: "big", kind: "decide", if: `trigger.amount > ${limit}`, then: [{ id: "pay", kind: "create", type: "payment", set: { client: { expr: "trigger.client" }, amount: { expr: "trigger.amount" } } }] },
];
const flowOf = (name, limit) => ({ format: 1, name, authorship: "human", trigger: { on: "event", event: "payment.received" }, steps: steps(limit) });

/** A week of real payments, each handled by the live Flow. */
async function week() {
  const w = await world();
  const live = await install(w, flowOf("handle_payment", 100));
  const t0 = w.clock.t;
  for (let i = 0; i < 6; i++) { w.advance(DAY); w.kernel.inbound("payment.received", { client: `C${i}`, amount: i * 60 }); await settle(w); }
  return { w, live, t0, t1: w.clock.t };
}

test("try it on last week: the same version replayed over the week matches what really happened", async () => {
  const { w, live, t0, t1 } = await week();
  assert.equal(mine(w, "matter").length, 6, "the live Flow handled six payments");
  const sim = await w.runner.simulate(flowOf("handle_payment", 100), { approver: ALEX, since: t0, until: t1 });
  assert.equal(sim.ok, true, JSON.stringify(sim.errors));
  const h = compareHistory(sim, await w.runner.listRuns({ flow: live.id, limit: 1000 }), { since: t0, until: t1 });
  assert.equal(h.matches, true, JSON.stringify(h));
  assert.deepEqual([h.ran, h.would, h.same, h.new, h.dropped], [6, 6, 6, 0, 0]);
  assert.match(h.line, /really ran 6 times\. This version would run 6 times: 6 the same, 0 different, 0 new, 0 it would not run\./);
});

test("try it on last week: a changed version shows which runs would have gone another way, and why", async () => {
  const { w, live, t0, t1 } = await week();
  const sim = await w.runner.simulate(flowOf("handle_payment", 200), { approver: ALEX, since: t0, until: t1 });
  const h = compareHistory(sim, await w.runner.listRuns({ flow: live.id, limit: 1000 }), { since: t0, until: t1 });
  assert.equal(h.matches, false);
  assert.equal(h.same + h.differ.length, 6);
  assert.equal(h.differ.length, 2, "the payments of 120 and 180 made a payment record before; with a limit of 200 they would not");
  assert.deepEqual(h.differ[0].was, ["big", "m", "pay"]);
  assert.deepEqual(h.differ[0].now, ["big", "m"]);
  assert.match(h.differ[0].why, /would do big, m$/);
});

test("try it on last week: a trigger the live Flow never answered is new, and one it answered that the new version skips is dropped", async () => {
  const { w, live, t0, t1 } = await week();
  const narrower = { ...flowOf("handle_payment", 100), trigger: { on: "event", event: "payment.received", where: "trigger.amount >= 120" } };
  const sim = await w.runner.simulate(narrower, { approver: ALEX, since: t0, until: t1 });
  const h = compareHistory(sim, await w.runner.listRuns({ flow: live.id, limit: 1000 }), { since: t0, until: t1 });
  assert.deepEqual([h.would, h.dropped, h.new], [4, 2, 0], "the payments of 0 and 60 would not start it");
  const other = compareHistory({ runs: [{ event: "evt_new", at: t0, ran: ["m"], outcome: "completed" }], matched: 1 }, [], { since: t0, until: t1 });
  assert.equal(other.new, 1);
});

test("try it on last week: a run still waiting counts as the same so far, and a loop's turns are one step", async () => {
  const { live, t0, t1 } = await week();
  const waiting = { state: "waiting", started_at: t0 + 1, trigger: { event: { id: "e1" } }, steps: { m: { status: "done" } } };
  const h = compareHistory({ runs: [{ event: "e1", at: t0 + 1, ran: ["m", "big"], outcome: "completed" }], matched: 1 }, [waiting], { since: t0, until: t1 });
  assert.equal(h.same, 1, "what it did so far is what the practice run did first");
  assert.deepEqual(stepsDone({ steps: { "a@0": { status: "done" }, "a@1": { status: "done" }, "b?ask": { status: "done" }, "c!x": { status: "done" }, d: { status: "failed" } } }), ["a"]);
  void live;
});
