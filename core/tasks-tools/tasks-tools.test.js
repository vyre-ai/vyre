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
