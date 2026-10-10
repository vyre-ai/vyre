import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlows } from "./index.js";
import { RealKernel } from "./testing/real-kernel.js";
import { CORE_TYPES } from "../../records/core-types.js";
import { catalog, onPayment, estateKit, SPACE } from "./testing/fixtures.js";
import { ALEX } from "./testing/world.js";

async function build() {
  const clock = { t: Date.UTC(2026, 9, 3, 12) };
  const kernel = new RealKernel({ now: () => clock.t, actions: { "email.send": { risk: "outward.send" } } });
  kernel.setRole("attorney", [ALEX]); kernel.addActor({ kind: "agent", id: "intake" }); kernel.addActor({ kind: "service", id: "flows" });
  const cat = catalog(); cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
  const define = kernel.records.define;
  kernel.records.define = async (c, diff) => { const r = await define(c, diff); for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) cat.types[t.name] = t; return r; };
  await kernel.records.define(kernel.sysChain(), { add_types: [...Object.values(cat.types), ...CORE_TYPES.filter(t => !cat.types[t.name])] });
  const flows = createFlows({ kernel, chains: { forFlow: x => kernel.chainFor(x), forDoer: () => kernel.moduleChain({ module: "flows", approver: ALEX }) }, catalog: () => cat, clock: () => clock.t, ports: { roles: () => [ALEX] }, installerRole: () => "admin" });
  kernel.onEvent(e => { void flows.onEvent(e); }, "flows");
  // a person's own chain, and the same person with an assistant in it, both built by the kernel
  const person = kernel.as(ALEX);
  const withAgent = kernel.as({ kind: "agent", id: "intake", space: SPACE });
  const settle = async () => { for (let i = 0; i < 3; i++) { await kernel.idle(); await flows.runner.drain(); } };
  return { kernel, flows, person, withAgent, cat, settle };
}

test("service: define from text, read the card, approve as a person, and the Flow runs", async () => {
  const { kernel, flows, person, settle } = await build();
  const text = flows.text(onPayment());
  const d = await flows.tools["flows.define"](person, { text });
  assert.equal(d.ok, true, JSON.stringify(d.errors));
  const card = await flows.tools["flows.card"](person, { id: d.id, version: d.version });
  assert.equal(card.hash, d.hash);
  assert.deepEqual(card.effects.writes, ["matter"]);
  assert.match(card.text, /defineFlow/);
  await flows.tools["flows.approve"](person, { id: d.id, version: d.version, hash: d.hash });
  kernel.inbound("payment.received", { amount: 1, client: "Svc" });
  await settle();
  const runs = await flows.tools["flows.runs"](person, { id: d.id });
  assert.equal(runs.length, 1);
  const one = await flows.tools["flows.run"](person, { run: runs[0].id });
  assert.equal(one.painted.nodes.find(n => n.id === "open").state, "done");
  const g = await flows.tools["flows.graph"](person, { id: d.id });
  assert.equal(g.nodes[0].kind, "trigger");
});

test("service: approving, pausing and installing are a person's own act: a chain with an agent in it is refused", async () => {
  const { flows, person, withAgent } = await build();
  const d = await flows.tools["flows.define"](person, { flow: onPayment() });
  for (const [tool, input] of [["flows.approve", { id: d.id, version: d.version, hash: d.hash }], ["flows.pause", { id: d.id }], ["flows.resume", { id: d.id }], ["kits.remove", { id: "x" }]])
    await assert.rejects(() => flows.tools[tool](withAgent, input), e => e.code === "chain_not_person", tool);
});

test("service: a text that is not valid is refused with a line, and nothing is stored", async () => {
  const { flows, person } = await build();
  const r = await flows.tools["flows.define"](person, { text: "import x from 'fs';\nexport default 1;" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /only @vyre\/sdk may be imported/);
  assert.deepEqual(await flows.tools["flows.list"](person, {}), []);
});

test("service: a new version shows what changed in words, and a Kit goes through the same service", async () => {
  const { kernel, flows, person, settle } = await build();
  const d = await flows.tools["flows.define"](person, { flow: onPayment() });
  await flows.tools["flows.approve"](person, { id: d.id, version: d.version, hash: d.hash });
  const f2 = onPayment(); f2.steps[1].limit = 2;
  const d2 = await flows.tools["flows.define"](person, { id: d.id, flow: f2 });
  assert.equal(d2.version, 2);
  assert.ok(d2.changes.some(c => /Changes a step: Look up payment records/.test(c)));
  const p = await flows.tools["kits.propose"](person, { kit: estateKit(1) });
  assert.equal(p.ok, true);
  kernel.completeTask(p.task, { outcome: "approved" });
  await settle();
  assert.equal((await flows.tools["kits.list"](person, {}))[0].status, "installed");
  const kd = await flows.tools["kits.diff"](person, { kit: estateKit(2) });
  assert.equal(kd.installed, true);
  assert.equal(kd.newer, true);
});

test("service: simulation through the tool reports without writing", async () => {
  const { kernel, flows, person, settle } = await build();
  kernel.inbound("payment.received", { amount: 1, client: "A" });
  const r = await flows.tools["flows.simulate"](person, { flow: onPayment(), since: 0, until: Date.UTC(2027, 0, 1) });
  assert.equal(r.matched, 1);
  assert.equal([...(kernel.tables.get("matter") || new Map())].length, 0);
});

test("service: a run with lanes paints the lanes' steps on its picture and lists each lane, and flows.simulate sets last week beside what really happened", async () => {
  const { kernel, flows, person, settle } = await build();
  const flow = { format: 1, name: "both_ways", label: "Both ways", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps: [
    { id: "p", kind: "parallel", steps: [
      { id: "left", kind: "branch", steps: [{ id: "a", kind: "create", type: "matter", set: { client: "A" } }] },
      { id: "right", kind: "branch", steps: [{ id: "b", kind: "create", type: "matter", set: { client: "B" } }] },
    ] },
  ] };
  const d = await flows.tools["flows.define"](person, { flow });
  assert.equal(d.ok, true, JSON.stringify(d.errors));
  await flows.tools["flows.approve"](person, { id: d.id, version: d.version, hash: d.hash });
  const since = Date.UTC(2026, 9, 3, 11);
  kernel.inbound("payment.received", { amount: 1, client: "Svc" });
  await settle();
  const roots = (await flows.tools["flows.runs"](person, { id: d.id })).filter(r => !r.parent);
  assert.equal(roots.length, 1);
  const one = await flows.tools["flows.run"](person, { run: roots[0].id });
  assert.deepEqual(one.lanes.map(l => [l.lane, l.state]).sort(), [["left", "done"], ["right", "done"]]);
  assert.equal(one.painted.nodes.find(n => n.id === "a").state, "done", "a step inside a lane is painted from the lane's own run");
  const sim = await flows.tools["flows.simulate"](person, { id: d.id, since });
  assert.equal(sim.ok, true, JSON.stringify(sim.errors));
  assert.equal(sim.history.matches, true, sim.history.line);
  assert.equal(sim.history.ran, 1);
});
