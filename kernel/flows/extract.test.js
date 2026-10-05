// @ts-check
// The extract step: named fields out of a message into a record, through the model door, in the declared shape only, inside the AI budget.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { checkFlow } from "./schema.js";

const FIELDS = [{ name: "client", kind: "text" }, { name: "amount", kind: "number" }, { name: "due", kind: "date", description: "the deadline" }, { name: "urgent", kind: "boolean" }];
const flowOf = (/** @type {any} */ extra = {}) => ({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps: [
  { id: "e", kind: "extract", input: { expr: "trigger.text" }, fields: FIELDS, ...extra },
  { id: "m", kind: "create", type: "payment", set: { client: { expr: "steps.e.fields.client" }, amount: { expr: "steps.e.fields.amount" } } }] });
const last = async (/** @type {any} */ w, /** @type {string} */ id) => (await w.runner.listRuns({ flow: id }))[0];
const mine = (/** @type {any} */ w) => [...(w.kernel.tables.get("payment") || new Map()).values()];

test("extract: the declared fields come back in their kinds, what the text did not say is null, extra keys are dropped, and the values reach the next step", async () => {
  const w = await world();
  w.kernel.modelLabel = '```json\n{"client":"Rivera","amount":"$1,250.50","due":"2026-11-04","urgent":"yes","ssn":"leak","extra":1}\n```';
  const { id } = await install(w, flowOf());
  w.kernel.inbound("payment.received", { text: "Rivera owes 1,250.50 by Nov 4, urgent" });
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.deepEqual(run.steps.e.output.fields, { client: "Rivera", amount: 1250.5, due: "2026-11-04", urgent: true });
  assert.deepEqual(run.steps.e.output.found, ["client", "amount", "due", "urgent"]);
  assert.equal(mine(w)[0].data.client, "Rivera");
  assert.equal(mine(w)[0].data.amount, 1250.5);
});

test("extract: a reply that is not that shape, a bad date and a non-number are null, never a guess; and the step used the model door as purpose extract", async () => {
  const w = await world();
  w.kernel.modelLabel = '{"client":"Rivera","amount":"a lot","due":"next week"}';
  const { id } = await install(w, flowOf());
  w.kernel.inbound("payment.received", { text: "x" });
  await settle(w);
  assert.deepEqual((await last(w, id)).steps.e.output.fields, { client: "Rivera", amount: null, due: null, urgent: null });
  assert.ok(w.kernel.calls.some((/** @type {any} */ c) => c[0] === "model" && c[1] === "extract"));
  const w2 = await world();
  w2.kernel.modelLabel = "I could not find anything";
  const f2 = await install(w2, flowOf());
  w2.kernel.inbound("payment.received", { text: "x" });
  await settle(w2);
  const o = (await last(w2, f2.id)).steps.e.output;
  assert.equal(o.raw_ok, false);
  assert.deepEqual(o.found, []);
});

test("extract: it is a model step the card shows, it needs model.call, and a bad definition is refused with a reason", async () => {
  const w = await world();
  const d = await w.runner.define(null, flowOf(), { kind: "person", id: "per_alex", space: w.cat.space });
  assert.ok(d.ok, JSON.stringify(d.errors));
  assert.deepEqual(d.effects.model_steps, ["e"]);
  for (const bad of [{ fields: [] }, { fields: [{ name: "Bad Name" }] }, { fields: [{ name: "a" }, { name: "a" }] }, { fields: [{ name: "a", kind: "money" }] }]) {
    const r = checkFlow(flowOf(bad));
    assert.ok((Array.isArray(r) ? r : r.errors || []).length, JSON.stringify(bad));
  }
});

test("extract: the AI budget applies: used up for the day or for the run, the step is refused in plain words and the model is not asked", async () => {
  const w = await world();
  w.kernel.modelLabel = '{"client":"A"}';
  await w.runner.setAiBudget(0);
  const { id } = await install(w, flowOf());
  w.kernel.inbound("payment.received", { text: "x" });
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.error.code, "ai_budget");
  assert.equal(run.error.message, "This space's AI budget for today is used up");
  assert.ok(!w.kernel.calls.some((/** @type {any} */ c) => c[0] === "model"));
});
