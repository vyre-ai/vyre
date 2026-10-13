// A Flow's agent step wakes the agent (core/daemon/agent-wake.js) on the real gateway and tasks: the task the step makes is read back through the kernel, the agents module is asked once, and the thread
// it answers with is written on the task by the kernel's own edit.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { createAgentWake } from "../../core/daemon/agent-wake.js";

const flow = steps => ({ format: 1, name: "t", label: "T", authorship: "human", trigger: { on: "manual" }, steps });

async function run(steps) {
  const w = await world({ kernel: "real" });
  w.kernel.addActor({ kind: "agent", id: "research", space: w.cat.space });
  const { id } = await install(w, flow(steps));
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  const woke = [];
  const onEvent = createAgentWake({ space: w.cat.space, gw: { ask: { get: (c, i) => w.kernel.ask.get(c, i), edit: (c, i, p) => w.kernel.tasksApi.edit(c, i, p) } }, chain: () => w.kernel.sysChain(), editChain: () => w.kernel.as(ALEX),
    clock: () => w.kernel.clock(), callModule: async (tool, input) => { woke.push(input); return { agent: input.agent, thread: `thr-${input.task}`, already: woke.filter(x => x.task === input.task).length > 1 }; }, log: () => {} });
  const feed = async () => { for (const e of w.kernel.rawLog.read({ type: "task.*" })) await onEvent(e); };
  return { w, woke, feed };
}

test("a Flow agent step wakes the agent once with the step's words, the task gets the thread, and a replay of the log starts nothing more", async () => {
  const { w, woke, feed } = await run([{ id: "go", kind: "agent", assistant: "teammate:research", title: "Draft the refund note", instructions: "Escalate to Dana", output: { kind: "note" } }]);
  await feed();
  assert.equal(woke.length, 1);
  assert.equal(woke[0].agent, "research");
  assert.equal(woke[0].title, "Draft the refund note");
  assert.match(woke[0].instructions, /Escalate to Dana/);
  // (the approver rides as the task's assigned_by when the run is built by chains.forFlow, which this harness's chainFor does not do: core/daemon/agent-wake.test.js covers that path)
  const task = await w.kernel.tasksApi.get(w.kernel.sysChain(), woke[0].task);
  assert.equal(task.form.thread, `thr-${woke[0].task}`);
  await feed();
  assert.equal(new Set(woke.map(x => x.task)).size, 1, "a replay wakes no other task");
});

test("a task assigned to a person wakes nothing", async () => {
  const { woke, feed } = await run([{ id: "go", kind: "assign", to: "person:" + ALEX.id, title: "Call Jane", output: { kind: "note" }, brief: "Call her" }]);
  await feed();
  assert.deepEqual(woke, []);
});
