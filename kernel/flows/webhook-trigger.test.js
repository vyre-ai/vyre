// A webhook starts a Flow with its body. The hooks module (core/hooks) checks a delivery's signature, stores it, and hands the Flow whose web trigger is hook-<route> the body as plain data with trust "untrusted" (the
// same call a form or an app's webhook makes: runner.handleWeb). The Flow reads the fields as trigger.*, and a condition on them decides the run. A route no Flow answers is refused as not_found.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { checkFlow } from "./schema.js";

const flow = route => ({
  format: 1, name: "t", label: "Refund request", authorship: "human", trigger: { on: "web", path: `hook-${route}` },
  steps: [{ id: "big", kind: "decide", if: "trigger.amount > 50", then: [{ id: "a", kind: "assign", to: "role:attorney", title: "Approve a large refund", output: { kind: "note" } }], else: [] }],
});

test("the webhook trigger is a valid Flow trigger", () => {
  assert.deepEqual(checkFlow(flow("northwind-orders")), []);
});

test("a delivery's body reaches the Flow as trigger.*, and a condition on it decides the run", async () => {
  const w = await world();
  const { id } = await install(w, flow("orders"));
  const run = async (/** @type {any} */ body, /** @type {string} */ key) => { const r = await w.runner.handleWeb("hook-orders", { body, trust: "untrusted", key }); await settle(w); return r; };
  await run({ amount: 80, email: "pat@example.com" }, "d1");
  await w.kernel.idle();
  assert.equal(w.kernel.tasks.filter((/** @type {any} */ t) => t.title === "Approve a large refund").length, 1, "an amount over 50 makes the task");
  await run({ amount: 20, email: "sam@example.com" }, "d2");
  await w.kernel.idle();
  assert.equal(w.kernel.tasks.filter((/** @type {any} */ t) => t.title === "Approve a large refund").length, 1, "an amount of 20 makes none");
  const runs = await w.runner.listRuns({ flow: id });
  assert.equal(runs.length, 2, "each delivery is its own run");
  assert.equal(runs.every((/** @type {any} */ r) => r.state === "done"), true, JSON.stringify(runs.map((/** @type {any} */ r) => r.error)));
});

test("a delivery to a route no Flow answers starts nothing and says not_found", async () => {
  const w = await world();
  const { id } = await install(w, flow("orders"));
  await assert.rejects(() => w.runner.handleWeb("hook-invoices", { body: { amount: 99 }, trust: "untrusted", key: "d3" }), (/** @type {any} */ e) => e.code === "not_found");
  await settle(w);
  assert.equal((await w.runner.listRuns({ flow: id })).length, 0, "the other route's Flow did not start");
});
