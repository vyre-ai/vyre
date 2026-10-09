// @ts-check
// e5: a draft is checked and practice-run before a person is asked.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX } from "./testing/world.js";
import { onPayment } from "./testing/fixtures.js";
import { createFlows } from "./index.js";

async function setup() {
  const w = await world({ store: "records" });
  const chains = { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) };
  const f = createFlows({ kernel: w.kernel, chains, catalog: () => w.cat, store: w.store, proposals: { chain: () => w.kernel.sysChain(), isAdmin: (/** @type {any} */ who) => who.id === ALEX.id } });
  w.offs.push(w.kernel.onEvent((/** @type {any} */ e) => { void f.onEvent(e); }, "flows-test"));
  const assistant = w.kernel.chains.fromFacts({ kind: "agent_session", person: ALEX.id, agent: "research", session: "s", thread: "t", vouched: true });
  const person = w.kernel.as(ALEX);
  return { w, f, assistant, person };
}

test("e5: a good draft is proposed with what was checked", async () => {
  const { w, f, assistant } = await setup();
  const d = await w.runner.define(null, onPayment(), { kind: "agent", id: "research", space: w.cat.space });
  const r = await f.tools["flows.propose"](assistant, { what: "flow", id: d.id, version: d.version });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.checked, /^Checked: compiles; no saved test cases; /);
});

test("e5: a draft that no longer compiles is not proposed, and the errors say where", async () => {
  const { w, f, assistant } = await setup();
  const d = await w.runner.define(null, onPayment(), { kind: "agent", id: "research", space: w.cat.space });
  w.cat.types = {};          // the Space lost its record types after the draft was stored
  const r = await f.tools["flows.propose"](assistant, { what: "flow", id: d.id, version: d.version });
  assert.equal(r.ok, false);
  assert.match(r.message, /does not compile/);
  assert.ok(r.errors.length > 0);
});

test("e5: a failing saved test case stops the proposal, with its line", async () => {
  const { w, f, assistant, person } = await setup();
  const d = await w.runner.define(null, onPayment(), { kind: "agent", id: "research", space: w.cat.space });
  await f.tools["flows.test.save"](person, { id: d.id, name: "never", event: { type: "payment.received", data: { amount: 5, client: "c1" } }, expect: { state: "failed" } });
  const r = await f.tools["flows.propose"](assistant, { what: "flow", id: d.id, version: d.version });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /^never: it completed, expected it to be failed/);
});

test("e5: an assistant cannot propose unchecked; a person can, and the card says so", async () => {
  const { w, f, assistant, person } = await setup();
  const d = await w.runner.define(null, onPayment(), { kind: "agent", id: "research", space: w.cat.space });
  await assert.rejects(() => f.tools["flows.propose"](assistant, { what: "flow", id: d.id, version: d.version, unchecked: true }), /only a checked draft/);
  const p = await f.tools["flows.propose"](person, { what: "flow", id: d.id, version: d.version, unchecked: true });
  assert.equal(p.ok, true);
  await settle(w);
  const task = w.kernel.tasks.find((/** @type {any} */ t) => t.id === p.task);
  assert.match(task.form.note, /^Not checked before proposing\./);
});

test("e5: a checked proposal carries the checked line on its card", async () => {
  const { w, f, assistant } = await setup();
  const d = await w.runner.define(null, onPayment(), { kind: "agent", id: "research", space: w.cat.space });
  const p = await f.tools["flows.propose"](assistant, { what: "flow", id: d.id, version: d.version, note: "please" });
  await settle(w);
  const task = w.kernel.tasks.find((/** @type {any} */ t) => t.id === p.task);
  assert.match(task.form.note, /^Checked: compiles; no saved test cases; .* please$/);
});
