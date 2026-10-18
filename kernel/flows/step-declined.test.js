// @ts-check
// A Flow step waiting on a task that its person declines fails at once (code refused), and the step's on_fail path runs; the run does not wait for the due time.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";

const flow = (/** @type {any} */ extra = {}) => ({ format: 1, name: "t", label: "T", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps: [
  { id: "a", kind: "assign", to: "teammate:research", title: "Look into it", output: { kind: "note" }, how: "assistant", await: true, ...extra },
] });

test("a declined task fails the step that waits on it, naming the decline", { timeout: 60_000 }, async () => {
  const w = await world({ kernel: "real" });
  const { id } = await install(w, flow());
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const task = w.kernel.tasks.find((/** @type {any} */ t) => t.title === "Look into it");
  assert.ok(task, "the task was given");
  await w.kernel.declineTask(task.id, "this is not ours");
  await settle(w);
  const run = (await w.runner.listRuns({ flow: id }))[0];
  assert.equal(run.state, "failed", JSON.stringify(run));
  assert.equal(run.error.code, "refused");
  assert.match(run.error.message, /was declined/);
});
