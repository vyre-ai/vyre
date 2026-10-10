// Old finished runs shrink to one line (flows.runs_keep_days), and nothing that still matters is touched.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX, BOB } from "./testing/world.js";
import { prunable, summaryOf } from "./prune.js";
import { compareHistory } from "./replay.js";

const DAY = 86_400_000;
const flowOf = (steps, extra = {}) => ({ format: 1, name: "keep", label: "Keep it", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps, ...extra });
const make = { id: "m", kind: "create", type: "matter", set: { client: "X" } };
const lane = (id, steps) => ({ id, kind: "branch", steps });
const roots = async (w, id) => (await w.runner.listRuns({ flow: id })).filter(r => !r.parent);

test("prune: a run past the keep days shrinks to one line and stays in the list", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([make]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [full] = await roots(w, id);
  assert.equal(full.state, "done");
  assert.ok(Object.keys(full.steps).length > 0);

  w.advance(10 * DAY);
  assert.equal(await w.runner.prune(), 0, "ten days is inside the default ninety");
  w.advance(81 * DAY);
  assert.equal(await w.runner.prune(), 1);
  const [one] = await roots(w, id);
  assert.equal(one.pruned, true);
  assert.equal(one.summary, "Keep it: done");
  assert.equal(one.state, "done");
  assert.equal(one.started_at, full.started_at);
  assert.deepEqual(one.steps, {}, "the step-by-step details are gone");
  assert.equal(await w.runner.prune(), 0, "a second pass finds nothing more");
});

test("prune: the keep days are the Space's setting, and a run inside them is kept whole", async () => {
  let days = "7";
  const w = await world({ settings: async key => (key === "flows.runs_keep_days" ? days : undefined) });
  const { id } = await install(w, flowOf([make]));
  w.kernel.inbound("payment.received", { n: 1 });
  await settle(w);
  w.advance(5 * DAY);
  w.kernel.inbound("payment.received", { n: 2 });
  await settle(w);
  w.advance(4 * DAY);                    // the first run is 9 days old, the second 4
  w.runner.settingsAt = -Infinity;
  await w.runner.tick();                // the tick reads the setting and prunes
  const rows = await roots(w, id);
  assert.deepEqual(rows.map(r => Boolean(r.pruned)).sort(), [false, true], "the old one shrank, the new one is whole");
  days = "30"; w.runner.settingsAt = -Infinity; w.runner.pruneAt = -Infinity;
  w.advance(30 * DAY);
  await w.runner.tick();
  assert.equal((await roots(w, id)).every(r => r.pruned), true, "and after thirty days more, both are");
});

test("prune: a run still going, one waiting for a person, and one that failed and needs a person are never touched", async () => {
  const w = await world();
  const waiting = await install(w, flowOf([{ id: "q", kind: "ask", to: "role:manager", title: "Wait for me" }], { name: "waits" }));
  const failing = await install(w, flowOf([{ id: "q", kind: "ask", to: "role:nobody_holds_this", title: "No one" }], { name: "fails" }));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const [wait] = await roots(w, waiting.id);
  const [fail] = await roots(w, failing.id);
  assert.equal(wait.state, "waiting");
  assert.equal(fail.state, "failed");
  assert.ok(fail.attention, "it needs a person");
  w.advance(400 * DAY);
  assert.equal(await w.runner.prune(), 0);
  assert.equal((await roots(w, waiting.id))[0].pruned, undefined);
  assert.equal((await roots(w, failing.id))[0].pruned, undefined);
  assert.equal(prunable({ state: "running" }), false);
  assert.equal(prunable({ state: "failed", attention: { kind: "failed" } }), false);
  assert.equal(prunable({ state: "failed" }), true, "a failure nobody is waiting on is only history");
});

test("prune: a run with lanes shrinks with its lanes, and one lane still going keeps the whole", async () => {
  const w = await world({ ports: { roles: (_s, role) => (role === "manager" ? [BOB] : role === "attorney" ? [ALEX, BOB] : []) } });
  const { id } = await install(w, flowOf([{ id: "p", kind: "parallel", steps: [lane("a", [make]), lane("b", [{ ...make, id: "m2" }])] }]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  assert.equal((await w.runner.listRuns({ flow: id })).length, 3);
  w.advance(100 * DAY);
  assert.equal(await w.runner.prune(), 3, "the run and both lanes");
  assert.ok((await w.runner.listRuns({ flow: id })).every(r => r.pruned));

  await install(w, flowOf([{ id: "p", kind: "parallel", steps: [lane("a", [make]), lane("b", [{ id: "t", kind: "assign", to: "role:manager", title: "Slow lane", output: { kind: "note" }, how: "person", await: true }])] }], { name: "slow", trigger: { on: "event", event: "slow.started" } }));
  w.kernel.inbound("slow.started", {});
  await settle(w);
  w.advance(100 * DAY);
  assert.equal(await w.runner.prune(), 0, "a lane is still waiting for a person");
});

test("prune: the one line keeps what a list and a timeline read, and a replay leaves pruned runs out", () => {
  const run = { id: "run_1", flow: "fl_1", version: 2, hash: "h", space: "s", approver: { kind: "person", id: "p" }, state: "failed", started_at: 5, finished_at: 9, label: "Welcome", record: "vyre://s/matter/1", tainted: true, error: { code: "x", message: "m".repeat(500) }, trigger: { kind: "event", event: { id: "e" } }, steps: { a: { status: "done" } } };
  const one = summaryOf(run);
  assert.equal(one.summary, "Welcome: did not finish");
  assert.equal(one.record, "vyre://s/matter/1");
  assert.equal(one.error.message.length, 200);
  assert.deepEqual(one.steps, {});
  const sim = { runs: [{ event: "e", at: 5, ran: ["a"], outcome: "completed" }], matched: 1 };
  assert.equal(compareHistory(sim, [{ ...one, trigger: { event: { id: "e" } } }], { since: 0, until: 100 }).ran, 0, "a pruned run is not set beside the replay");
});

test("prune: a backlog bigger than one look still clears, a few runs a pass, and the shrunk ones are not looked at again", async () => {
  const w = await world();
  const { id } = await install(w, flowOf([make]));
  for (let i = 0; i < 5; i++) { w.kernel.inbound("payment.received", { n: i }); await settle(w); w.advance(1000); }
  w.advance(100 * DAY);
  const left = async () => (await roots(w, id)).filter(r => !r.pruned).length;
  assert.equal(await left(), 5);
  assert.equal(await w.runner.pruner.sweep(90 * DAY, 2, 2), 2);
  assert.equal(await w.runner.pruner.sweep(90 * DAY, 2, 2), 2);
  assert.equal(await w.runner.pruner.sweep(90 * DAY, 2, 2), 1, "the last one is reached though four had shrunk before it");
  assert.equal(await left(), 0);
});
