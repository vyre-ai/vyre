// A webhook starts a Flow: the listener announces hook.received { route, id, bytes, at } (core/hooks), and a Flow whose trigger is that event with the condition trigger.route == "<route>" starts for its own route and
// no other. What the Flow can read is the announcement, not the body: the body is read with hooks.delivery by the owner's watchers, never by a model (core/hooks/index.js).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { checkFlow } from "./schema.js";

const flow = route => ({ format: 1, name: "t", label: "T", authorship: "human", trigger: { on: "event", event: "hook.received", where: `trigger.route == "${route}"` }, steps: [{ id: "a", kind: "assign", to: "role:attorney", title: "Look at the delivery", output: { kind: "note" } }] });
const runs = async (/** @type {any} */ w, /** @type {string} */ id) => w.runner.listRuns({ flow: id });

test("the webhook trigger is a valid Flow trigger", () => {
  assert.deepEqual(checkFlow(flow("northwind-orders")), []);
});

test("a delivery on the Flow's route starts it, and one on another route does not", async () => {
  const w = await world();
  const { id } = await install(w, flow("orders"));
  w.kernel.inbound("hook.received", { route: "other", id: "d0", bytes: 10, at: "2026-10-19T00:00:00Z" });
  await settle(w);
  assert.equal((await runs(w, id)).length, 0, "another route starts nothing");
  w.kernel.inbound("hook.received", { route: "orders", id: "d1", bytes: 42, at: "2026-10-19T00:00:01Z" });
  await settle(w);
  const list = await runs(w, id);
  assert.equal(list.length, 1, "its own route starts one run");
  assert.equal(list[0].trigger.event.data.route, "orders");
  assert.equal(list[0].trigger.event.data.id, "d1", "the Flow sees the delivery's id, which the owner's tools read the body from");
  w.kernel.inbound("hook.received", { route: "orders", id: "d2", bytes: 7, at: "2026-10-19T00:00:02Z" });
  await settle(w);
  assert.equal((await runs(w, id)).length, 2, "each delivery is its own run");
});

test("two Flows on two routes each start only on their own", async () => {
  const w = await world();
  const a = await install(w, { ...flow("orders"), name: "a" });
  const b = await install(w, { ...flow("invoices"), name: "b" });
  w.kernel.inbound("hook.received", { route: "invoices", id: "i1", bytes: 1, at: "2026-10-19T00:00:00Z" });
  await settle(w);
  assert.equal((await runs(w, a.id)).length, 0);
  assert.equal((await runs(w, b.id)).length, 1);
});
