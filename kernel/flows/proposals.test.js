import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { onPayment } from "./testing/fixtures.js";
import { Proposals, proposerOf, assistantOf } from "./proposals.js";
import { createFlows } from "./index.js";
import { estateKit } from "./testing/fixtures.js";

async function pworld() {
  const w = await world({ store: "records" });
  const chains = { forFlow: x => w.kernel.chainFor(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) };
  const applied = [];
  const proposals = new Proposals({ kernel: w.kernel, runner: w.runner, store: w.store, chain: () => w.kernel.sysChain(), chains, catalog: () => w.cat,
    isAdmin: who => who.id === ALEX.id, applyTypes: async (approver, diff) => { applied.push({ approver: approver.id, diff }); } });
  w.offs.push(w.kernel.onEvent(e => { void proposals.onEvent(e); }, "proposals"));
  const assistant = w.kernel.chains.fromFacts({ kind: "agent_session", person: ALEX.id, agent: "research", session: "s", thread: "t", vouched: true });
  return { w, proposals, assistant, applied };
}

test("proposerOf: a person, or a person with only assistants behind them; nobody else", async () => {
  const { w, assistant } = await pworld();
  assert.equal(proposerOf(assistant).id, ALEX.id);
  assert.equal(assistantOf(assistant), "research");
  assert.equal(proposerOf(w.kernel.as(ALEX)).id, ALEX.id);
  assert.equal(proposerOf(w.kernel.moduleChain({ module: "flows", approver: ALEX })), null, "a service behind the person is not an assistant");
  assert.equal(proposerOf(w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space })), null, "a Flow's chain proposes nothing");
  assert.equal(proposerOf(null), null);
});

test("proposals: an assistant's draft Flow becomes one task for the admin; nothing is approved until they say yes, and then it is approved as them", async () => {
  const { w, proposals, assistant } = await pworld();
  const d = await w.runner.define(null, onPayment(), { kind: "agent", id: "research", space: w.cat.space });
  assert.ok(d.ok, JSON.stringify(d));
  const p = await proposals.propose(assistant, { what: "flow", id: d.id, version: d.version });
  assert.equal(p.ok, true); assert.equal(p.by, "research"); assert.equal(p.approver, ALEX.id);
  await settle(w);
  const task = w.kernel.tasks.find(t => t.id === p.task);
  assert.equal(task.form.kind, "proposal"); assert.equal(task.form.what, "flow"); assert.equal(task.form.hash, d.hash); assert.equal(task.form.by, "research");
  assert.deepEqual([task.doer.id, task.checker.id], ["flows", ALEX.id], "the Flows service asks, the admin checks");
  assert.equal((await w.store.getVersion(d.id, d.version)).approver, null, "still a draft");
  const again = await proposals.propose(assistant, { what: "flow", id: d.id, version: d.version });
  assert.equal(again.task, p.task, "asking twice for the same draft is the same task");
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  const v = await w.store.getVersion(d.id, d.version);
  assert.equal(v.approver && v.approver.id, ALEX.id, "approved as the approver, not as the assistant");
  await assert.rejects(proposals.propose(assistant, { what: "flow", id: d.id, version: d.version }), /already approved/);
});

test("proposals: a rejected proposal changes nothing; a non-admin or a Flow's own chain is not asked or heard", async () => {
  const { w, proposals, assistant } = await pworld();
  const d = await w.runner.define(null, onPayment(), { kind: "agent", id: "research", space: w.cat.space });
  const p = await proposals.propose(assistant, { what: "flow", id: d.id, version: d.version });
  await settle(w);
  w.kernel.completeTask(p.task, { outcome: "rejected" });
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  assert.equal((await w.store.getVersion(d.id, d.version)).approver, null);
  const bobsAssistant = w.kernel.chains.fromFacts({ kind: "agent_session", person: BOB.id, agent: "research", session: "s", thread: "t", vouched: true });
  await assert.rejects(proposals.propose(bobsAssistant, { what: "flow", id: d.id, version: d.version }), e => e.code === "not_found");
  await assert.rejects(proposals.propose(w.kernel.moduleChain({ module: "flows", approver: ALEX }), { what: "flow", id: d.id, version: d.version }), e => e.code === "chain_not_person");
  await assert.rejects(proposals.propose(assistant, { what: "flow", id: "fl_nope", version: 1 }), e => e.code === "not_found");
  await assert.rejects(proposals.propose(assistant, { what: "send" }), /propose a flow or types/);
});

test("proposals: a definition change is held in the task and defined as the approver, only after the yes", async () => {
  const { w, proposals, assistant, applied } = await pworld();
  const diff = { add_types: [{ name: "intake-note", label: "Intake note", fields: [{ name: "body", kind: "text", label: "Body" }] }] };
  await assert.rejects(proposals.propose(assistant, { what: "types", diff: { add_types: [{ name: "Bad Name" }] } }), /naming the types/);
  const p = await proposals.propose(assistant, { what: "types", diff });
  await settle(w);
  assert.deepEqual(applied, []);
  assert.equal(w.kernel.tasks.find(t => t.id === p.task).form.what, "types");
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  assert.equal(applied.length, 1); assert.equal(applied[0].approver, ALEX.id); assert.deepEqual(applied[0].diff, diff);
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  assert.equal(applied.length, 1, "applied once");
});

test("kits.propose: an assistant's chain asks for a Kit for the person it acts for (they are the approver); a Flow's chain or a bare service still cannot", async () => {
  const { w, assistant } = await pworld();
  w.cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
  const chains = { forFlow: x => w.kernel.chainFor(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) };
  const f = createFlows({ kernel: w.kernel, chains, catalog: () => w.cat, store: w.store });
  const p = await f.tools["kits.propose"](assistant, { kit: estateKit(1) });
  assert.equal(p.ok, true, JSON.stringify(p));
  await settle(w);
  const task = w.kernel.tasks.find(t => t.id === p.task);
  assert.equal(task.form.kind, "kit_install"); assert.equal(task.checker.id, ALEX.id);
  assert.equal(w.kernel.tables.get("estate-matter"), undefined, "nothing installed before the yes");
  await assert.rejects(f.tools["kits.propose"](w.kernel.moduleChain({ module: "flows", approver: ALEX }), { kit: estateKit(2) }), e => e.code === "chain_not_person");
  await assert.rejects(f.tools["kits.remove"](assistant, { id: "estate-planning" }), e => e.code === "chain_not_person", "removing stays a person's own");
});

test("PR-4: two events for one approved task apply one change", async () => {
  const { w, proposals, assistant, applied } = await pworld();
  const diff = { add_types: [{ name: "twice-note", label: "Twice note", fields: [{ name: "body", kind: "text", label: "Body" }] }] };
  const p = await proposals.propose(assistant, { what: "types", diff });
  await settle(w);
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w);
  const ev = { type: "task.completed", subject: `vyre://${w.cat.space}/task/${p.task}`, data: { task: p.task } };
  await Promise.all([proposals.onEvent(ev), proposals.onEvent(ev), proposals.onEvent(ev)]);
  await new Promise(r => setImmediate(r)); await settle(w);
  assert.equal(applied.length, 1);
});

test("flows.start: a run an assistant's chain starts is tainted (its input is a model's); a person's own is not", async () => {
  const { w, assistant } = await pworld();
  const d = await w.runner.define(null, { format: 1, name: "manual_probe", label: "Probe", authorship: "human", trigger: { on: "manual" }, steps: [] }, ALEX);
  await w.runner.approve(d.id, d.version, ALEX, d.hash);
  const a = await w.runner.start(d.id, { x: 1 }, assistant, "k1");
  const p = await w.runner.start(d.id, { x: 1 }, w.kernel.as(ALEX), "k2");
  await w.runner.drain();
  assert.equal((await w.store.getRun(a.run)).tainted, true);
  assert.equal((await w.store.getRun(p.run)).tainted, false);
});
