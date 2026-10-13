// "A record is created or updated": one trigger with a list of events, an optional field filter, and what a changed record does to the run it already started (start over, or keep both).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";

const HOUR = 3_600_000;
const mine = (/** @type {any} */ w, /** @type {string} */ type) => [...(w.kernel.tables.get(type) || new Map()).values()];
const reminder = (/** @type {any} */ trigger) => ({ format: 1, name: "reminder", authorship: "builder", trigger: { on: "event", event: ["matter.created", "matter.updated"], ...trigger }, steps: [
  { id: "w", kind: "wait", for_ms: HOUR },
  { id: "pay", kind: "create", type: "payment", set: { amount: 1, client: { expr: "trigger.after.client" } } },
] });
const chainOf = (/** @type {any} */ w) => w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space });
const live = async (/** @type {any} */ w, /** @type {string} */ flow) => (await w.runner.listRuns({ flow })).filter((/** @type {any} */ r) => r.state === "waiting");

test("created or updated: a reschedule leaves exactly one live run, with the new value", async () => {
  const w = await world();
  const { id } = await install(w, reminder({ field: "client" }));
  const chain = chainOf(w);
  const m = await w.kernel.records.create(chain, "matter", { client: "Old", stage: "Intake" });
  await settle(w);
  assert.equal((await live(w, id)).length, 1);
  await w.kernel.records.update(chain, "matter", m.id, { client: "New" }, (await w.kernel.records.get(chain, "matter", m.id)).version);
  await settle(w);
  const runs = await w.runner.listRuns({ flow: id });
  assert.equal((await live(w, id)).length, 1, "one live run");
  const gone = runs.filter((/** @type {any} */ r) => r.state === "cancelled");
  assert.equal(gone.length, 1);
  assert.equal(gone[0].cancelled.reason, "replaced by a newer change");
  w.advance(HOUR + 1); await w.runner.tick(); await settle(w);
  assert.deepEqual(mine(w, "payment").map((/** @type {any} */ p) => p.data.client), ["New"], "one reminder, for the new value");
});

test("an edit to another field does not fire when the filter is set, and does not cancel the waiting run", async () => {
  const w = await world();
  const { id } = await install(w, reminder({ field: "client" }));
  const chain = chainOf(w);
  const m = await w.kernel.records.create(chain, "matter", { client: "Pat", stage: "Intake" });
  await settle(w);
  await w.kernel.records.update(chain, "matter", m.id, { email: "pat@example.com" }, (await w.kernel.records.get(chain, "matter", m.id)).version);
  await settle(w);
  const runs = await w.runner.listRuns({ flow: id });
  assert.equal(runs.length, 1, "no second run");
  assert.equal(runs[0].state, "waiting", "and the first is untouched");
});

test("a run held at the Gate for the same record is never cancelled", async () => {
  const w = await world();
  const { id } = await install(w, reminder({ field: "client" }));
  const chain = chainOf(w);
  const m = await w.kernel.records.create(chain, "matter", { client: "Pat", stage: "Intake" });
  await settle(w);
  const gate = await w.runner.gateOpen({ key: `matter/${m.id}#Intake`, urn: m.urn || `vyre://${w.cat.space}/matter/${m.id}`, type: "matter", id: m.id, stage: "Intake", next: null, tasks: [{ id: "t1", title: "Sign", required: true }] });
  await w.kernel.records.update(chain, "matter", m.id, { client: "Pat Two" }, (await w.kernel.records.get(chain, "matter", m.id)).version);
  await settle(w);
  assert.equal((await w.runner.getRun(gate)).state, "waiting", "the gate keeps waiting");
  assert.equal((await live(w, id)).length, 1);
});

test("keep: both runs go on, as before; and an old single-event trigger behaves as it always did", async () => {
  const w = await world();
  const keep = await install(w, reminder({ when_record_changes: "keep" }));
  const chain = chainOf(w);
  const m = await w.kernel.records.create(chain, "matter", { client: "A", stage: "Intake" });
  await settle(w);
  await w.kernel.records.update(chain, "matter", m.id, { client: "B" }, (await w.kernel.records.get(chain, "matter", m.id)).version);
  await settle(w);
  assert.equal((await live(w, keep.id)).length, 2, "keep both");
  const w2 = await world();
  const old = await install(w2, { ...reminder({}), name: "old", trigger: { on: "event", event: "matter.*" } });
  const m2 = await w2.kernel.records.create(chainOf(w2), "matter", { client: "A", stage: "Intake" });
  await settle(w2);
  await w2.kernel.records.update(chainOf(w2), "matter", m2.id, { client: "B" }, (await w2.kernel.records.get(chainOf(w2), "matter", m2.id)).version);
  await settle(w2);
  assert.equal((await live(w2, old.id)).length, 2, "a flow that never said created-or-updated keeps today's behaviour");
});

test("the trigger reads in words and refuses a bad list or field", async () => {
  const { describeTrigger, checkTrigger } = await import("./triggers.js");
  assert.equal(describeTrigger({ on: "event", event: ["matter.created", "matter.updated"], field: "client" }), "When matter.created or matter.updated happens and client changes");
  const bad = [];
  checkTrigger({ on: "event", event: ["matter.created", "nope"], field: "Bad Field", when_record_changes: "both" }, bad, { onlyKeys() {}, checkExpr() {}, EVENT_RE: /^[a-z][a-z0-9_-]*\.(?:[a-z][a-z0-9_-]*|\*)$/, NAME_RE: /^[a-z][a-z0-9_-]{0,63}$/ });
  assert.deepEqual(bad.map(b => b.path), ["trigger.event", "trigger.field", "trigger.when_record_changes"]);
});
