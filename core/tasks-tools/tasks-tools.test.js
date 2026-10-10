import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

test("tasks.*: the owner's device requests, lists, starts and submits a task under its own chain; a model, a guest and anonymous are refused; a decision without presence is refused", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const owner = d.kernel.id.owner;
  const ok = async (tool, input, caller = "cli") => { const r = await call(tool, input, { root, caller }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const made = (await ok("tasks.request", { task: { title: "Call Jane", doer: owner, output: { kind: "note" } } })).task;
  assert.equal(made.state, "ready");
  assert.equal(made.doer.id, owner);
  const listed = (await ok("tasks.list", {})).tasks;
  assert.equal(listed.length, 1);
  assert.equal((await ok("tasks.list", { state: ["done"] })).tasks.length, 0, "filtered by state");
  assert.equal((await ok("tasks.list", { doer: "per_nobody" })).tasks.length, 0, "filtered by doer");
  assert.equal((await ok("tasks.get", { id: made.id })).task.title, "Call Jane");
  assert.equal((await ok("tasks.get", { id: "00000000-0000-4000-8000-000000000000" })).task, null);
  const started = (await ok("tasks.move", { id: made.id, to: "working" })).task;
  assert.equal(started.state, "working");
  const done = (await ok("tasks.submit", { id: made.id, evidence: { note: { text: "Spoke to Jane", sources: ["call"] } } })).task;
  assert.ok(["done", "needs_check"].includes(done.state), done.state);
  // the kernel's own refusals come through with its codes
  const again = await call("tasks.move", { id: made.id, to: "working" }, { root, caller: "cli" });
  assert.ok(again.error && ["bad_state", "not_allowed"].includes(again.error.code), JSON.stringify(again));
  assert.equal((await call("tasks.decide", { id: made.id, outcome: "approved" }, { root, caller: "cli" })).error.code !== undefined, true);
  for (const caller of ["mcp", "mcp:agent:kit", "tailnet-guest:x", "anonymous"]) {
    const r = await call("tasks.list", {}, { root, caller });
    assert.ok(r.error, `${caller}: ${JSON.stringify(r)}`);
  }
  assert.equal((await call("tasks.request", { task: { title: "x", output: { kind: "note" } } }, { root, caller: "cli" })).error.code, "bad_input", "a task needs a doer");
});

test("tasks.submit takes a decision the way the app sends it ({ decision: { answer, reason } }), and a note the same way", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const owner = d.kernel.id.owner;
  const ok = async (tool, input) => { const r = await call(tool, input, { root, caller: "cli" }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const task = (await ok("tasks.request", { task: { title: "Approve the draft trust", doer: owner, output: { kind: "decision" } } })).task;
  await ok("tasks.move", { id: task.id, to: "working" });
  const done = (await ok("tasks.submit", { id: task.id, evidence: { decision: { answer: "yes", reason: "Done by hand." } } })).task;
  assert.equal(done.state, "done", "a person's own decision task closes when they say yes with a reason");
  const bad = (await ok("tasks.request", { task: { title: "Another decision", doer: owner, output: { kind: "decision" } } })).task;
  await ok("tasks.move", { id: bad.id, to: "working" });
  const refused = await call("tasks.submit", { id: bad.id, evidence: { decision: { answer: "maybe", reason: "" } } }, { root, caller: "cli" });
  assert.equal(refused.error && refused.error.code, "output_check_failed", "a decision still needs yes or no and a reason");
});
