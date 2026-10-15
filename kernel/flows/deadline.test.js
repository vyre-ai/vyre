// Agent step deadlines (roadmap 0.6 item 3): an awaiting agent or task step has a due time (its own `timeout_ms`, or for an agent the Space's default); past it the step fails with `timeout` and runs its own
// nested steps, and the run goes on or stops as the Flow says.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { checkFlow } from "./schema.js";

const HOUR = 3_600_000;
const flow = (steps, extra = {}) => ({ format: 1, name: "t", label: "T", authorship: "human", trigger: { on: "manual" }, steps, ...extra });
const matters = (w) => [...(w.kernel.tables.get("matter") || new Map()).values()].map((m) => m.data.client).sort();
const make = (id, client) => ({ id, kind: "create", type: "matter", set: { client } });
const agent = (extra = {}) => ({ id: "go", kind: "agent", assistant: "teammate:research", title: "Draft the refund note", instructions: "Write it", output: { kind: "note" }, ...extra });

async function start(steps, o = {}) {
  const w = await world({ kernel: "real", ...o });
  w.kernel.addActor({ kind: "agent", id: "research", space: w.cat.space });
  const { id } = await install(w, flow(steps, o.flow));
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  const run = async () => (await w.runner.listRuns())[0];
  const pass = async (ms) => { w.clock.t += ms; await w.runner.tick(); await settle(w); return run(); };
  return { w, run, pass };
}

test("an agent step with a due time waits, and is still waiting just before it", async () => {
  const { run, pass } = await start([agent({ timeout_ms: 2 * HOUR })]);
  assert.equal((await run()).state, "waiting");
  assert.equal((await pass(HOUR)).state, "waiting");
});

test("past the due time the step fails with timeout and the run fails with that code", async () => {
  const { pass } = await start([agent({ timeout_ms: HOUR })]);
  const r = await pass(HOUR + 1000);
  assert.equal(r.state, "failed");
  assert.equal(r.error.code, "timeout");
  assert.equal(r.steps.go.status, "failed");
});

test("its own nested steps run, and then the run goes on when the Flow says so", async () => {
  const { w, pass } = await start([
    agent({ timeout_ms: HOUR, on_fail: { then: "continue", steps: [make("late", "{timed out}")] } }),
    make("after", "after"),
  ]);
  const r = await pass(HOUR + 1000);
  assert.equal(r.state, "done", JSON.stringify(r.error));
  assert.equal(r.steps.go.status, "failed_handled");
  assert.deepEqual(matters(w), ["after", "{timed out}"]);
});

test("a nested step of the failure path that itself waits completes when it is answered", async () => {
  const { w, run, pass } = await start([
    agent({ timeout_ms: HOUR, on_fail: { then: "continue", steps: [{ id: "tell", kind: "assign", to: "person:" + ALEX.id, title: "Chase the agent's work", output: { kind: "note" }, await: true }] } }),
    make("after", "after"),
  ]);
  const r = await pass(HOUR + 1000);
  assert.equal(r.state, "waiting", "the run now waits on the person's task");
  const mine = Object.entries(r.steps).filter(([, e]) => e.status === "waiting" && e.task);
  assert.equal(mine.length, 1);
  await w.kernel.completeTask(mine[0][1].task);
  await settle(w);
  assert.equal((await run()).state, "done");
  assert.deepEqual(matters(w), ["after"]);
});

test("an agent step with no due time of its own takes the Space's default; a person's task has none", async () => {
  const a = await start([agent()], { limits: { agent_due_ms: 5 * HOUR } });
  assert.equal((await a.pass(4 * HOUR)).state, "waiting");
  assert.equal((await a.pass(2 * HOUR)).error.code, "timeout");
  const p = await start([{ id: "go", kind: "assign", to: "person:" + ALEX.id, title: "Call Jane", output: { kind: "note" }, await: true }], { limits: { agent_due_ms: HOUR } });
  assert.equal((await p.pass(30 * HOUR)).state, "waiting", "people are not given a due time unless the step says so");
});

test("the due time is written once: a changed default does not move a step already waiting", async () => {
  const { w, pass } = await start([agent()], { limits: { agent_due_ms: 5 * HOUR } });
  w.runner.limits.agent_due_ms = HOUR;
  assert.equal((await pass(2 * HOUR)).state, "waiting");
});

test("a due time on a step that waits for an agent may be days, on other steps it stays within an hour", () => {
  assert.deepEqual(checkFlow(flow([agent({ timeout_ms: 30 * 24 * HOUR })])), []);
  const bad = checkFlow(flow([{ id: "f", kind: "create", type: "matter", set: { client: "x" }, timeout_ms: 2 * HOUR }]));
  assert.match(JSON.stringify(bad), /timeout_ms/);
});
