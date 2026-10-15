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

// ------------------------------------------------------------------ the kernel part (ADR 0054)

const taskOf = (r) => r.steps.go.task;

test("past the due time the task is withdrawn: skipped and marked, and a late hand-in, start and reopen are refused", async () => {
  const { w, run, pass } = await start([agent({ timeout_ms: HOUR })]);
  const task = taskOf(await run());
  await pass(HOUR + 1000);
  const t = await w.kernel.tasksApi.get(w.kernel.sysChain(), task);
  assert.equal(t.state, "skipped");
  assert.equal(t.withdrawn.reason, "timeout");
  await assert.rejects(() => w.kernel.completeTask(task), /./, "no late hand-in");
  await assert.rejects(() => w.kernel.tasksApi.start(w.kernel.as({ kind: "agent", id: "research" }), task), /./, "no late start");
  await assert.rejects(() => w.kernel.tasksApi.reopen(w.kernel.as(ALEX), task), /withdrawn/, "a person cannot reopen it either");
});

test("a task already being worked on is withdrawn too", async () => {
  const { w, run, pass } = await start([agent({ timeout_ms: HOUR })]);
  const task = taskOf(await run());
  await w.kernel.tasksApi.start(w.kernel.as(ALEX), task).catch(() => {});
  await pass(HOUR + 1000);
  assert.equal((await w.kernel.tasksApi.get(w.kernel.sysChain(), task)).state, "skipped");
});

test("only the Flows service withdraws: an agent, a person, another module and the runner's own run chain are refused", async () => {
  const { w, run } = await start([agent({ timeout_ms: 100 * HOUR })]);
  const task = taskOf(await run());
  const refused = [
    ["an agent", w.kernel.as({ kind: "agent", id: "research" })],
    ["a person (a member's key rides this)", w.kernel.as(ALEX)],
    ["another module", w.kernel.moduleChain({ module: "wink", approver: ALEX })],
    ["the run's own chain", w.kernel.chainFor({ flow: "t", approver: ALEX, run: "run_x" })],
  ];
  for (const [who, chain] of refused) await assert.rejects(() => w.kernel.tasksApi.withdraw(chain, task, {}), /./, who);
  assert.equal((await w.kernel.tasksApi.get(w.kernel.sysChain(), task)).state, "ready", "nothing changed");
  const done = await w.kernel.tasksApi.withdraw(w.kernel.moduleChain({ module: "flows", approver: ALEX }), task, { reason: "test" });
  assert.equal(done.state, "skipped");
});

test("a withdrawal is safe to repeat and changes nothing the second time", async () => {
  const { w, run } = await start([agent({ timeout_ms: 100 * HOUR })]);
  const task = taskOf(await run());
  const flows = w.kernel.moduleChain({ module: "flows", approver: ALEX });
  const first = await w.kernel.tasksApi.withdraw(flows, task, {});
  await assert.rejects(() => w.kernel.tasksApi.withdraw(flows, task, {}), /skipped/);
  assert.equal((await w.kernel.tasksApi.get(w.kernel.sysChain(), task)).withdrawn.at, first.withdrawn.at);
});

test("the agent's session ends from the durable event, and a replay after a crash ends it again and ends the lend once more", async () => {
  const { createAgentWake } = await import("../../core/daemon/agent-wake.js");
  const { w, run, pass } = await start([agent({ timeout_ms: HOUR })]);
  const task = taskOf(await run());
  await w.kernel.tasksApi.edit(w.kernel.as(ALEX), task, { form: { thread: "thr-1" } }).catch(() => {});
  await pass(HOUR + 1000);
  const stopped = [], reclaimed = [];
  const onEvent = createAgentWake({ space: w.cat.space, gw: { ask: { get: (c, i) => w.kernel.ask.get(c, i) } }, chain: () => w.kernel.sysChain(), reclaim: async (id) => { reclaimed.push(id); },
    clock: () => w.clock.t, callModule: async (tool, input) => { if (tool === "threads.stop") stopped.push(input.thread); return {}; }, log: () => {} });
  const events = [...w.kernel.rawLog.read({ type: "task.withdrawn" })];
  assert.equal(events.length, 1, "one durable event says it");
  await onEvent(events[0]);
  await onEvent(events[0]);   // the host restarted before it was marked handled: the same event comes again
  assert.deepEqual(reclaimed, [task, task]);
  assert.ok(stopped.every((t) => t === "thr-1"));
  assert.ok(stopped.length >= 1);
});

test("a run that crashed after the withdrawal and before it failed the step ends up failed once, not twice", async () => {
  const { w, run, pass } = await start([agent({ timeout_ms: HOUR, on_fail: { then: "continue", steps: [make("late", "late")] } })]);
  const task = taskOf(await run());
  // the crash: the kernel ended the task, but the runner did not get to write the result
  await w.kernel.tasksApi.withdraw(w.kernel.moduleChain({ module: "flows", approver: ALEX }), task, {});
  const r = await pass(HOUR + 1000);
  assert.equal(r.state, "done", JSON.stringify(r.error));
  assert.equal(matters(w).filter((m) => m === "late").length, 1, "its failure steps ran exactly once");
});
