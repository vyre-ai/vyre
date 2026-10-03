import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlows } from "./index.js";
import { FakeKernel } from "./testing/fake-kernel.js";
import { catalog, onPayment, estateKit, SPACE } from "./testing/fixtures.js";
import { ALEX } from "./testing/world.js";

function build() {
  const clock = { t: Date.UTC(2026, 9, 3, 12) };
  const kernel = new FakeKernel({ now: () => clock.t });
  const cat = catalog(); cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
  const define = kernel.records.define;
  kernel.records.define = async (c, diff) => { const r = await define(c, diff); for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) cat.types[t.name] = t; return r; };
  const flows = createFlows({ kernel, chains: { forFlow: x => kernel.chainFor(x) }, catalog: () => cat, clock: () => clock.t, ports: { roles: () => [ALEX] }, installerRole: () => "admin" });
  kernel.subs.add(e => { void flows.onEvent(e); });
  const person = { space: SPACE, hops: [{ actor: ALEX, entered_by: "surface" }], labels: { trust: "member", red: "internal", source_spaces: [SPACE] }, built_at: clock.t };
  const withAgent = { ...person, hops: [{ actor: ALEX }, { actor: { kind: "agent", id: "intake", space: SPACE } }] };
  return { kernel, flows, person, withAgent, cat };
}

test("service: define from text, read the card, approve as a person, and the Flow runs", async () => {
  const { kernel, flows, person } = build();
  const text = flows.text(onPayment());
  const d = await flows.tools["flows.define"](person, { text });
  assert.equal(d.ok, true, JSON.stringify(d.errors));
  const card = await flows.tools["flows.card"](person, { id: d.id, version: d.version });
  assert.equal(card.hash, d.hash);
  assert.deepEqual(card.effects.writes, ["matter"]);
  assert.match(card.text, /defineFlow/);
  await flows.tools["flows.approve"](person, { id: d.id, version: d.version, hash: d.hash });
  kernel.inbound("payment.received", { amount: 1, client: "Svc" });
  await new Promise(r => setImmediate(r)); await flows.runner.drain();
  const runs = await flows.tools["flows.runs"](person, { id: d.id });
  assert.equal(runs.length, 1);
  const one = await flows.tools["flows.run"](person, { run: runs[0].id });
  assert.equal(one.painted.nodes.find(n => n.id === "open").state, "done");
  const g = await flows.tools["flows.graph"](person, { id: d.id });
  assert.equal(g.nodes[0].kind, "trigger");
});

test("service: approving, pausing and installing are a person's own act: a chain with an agent in it is refused", async () => {
  const { flows, person, withAgent } = build();
  const d = await flows.tools["flows.define"](person, { flow: onPayment() });
  for (const [tool, input] of [["flows.approve", { id: d.id, version: d.version, hash: d.hash }], ["flows.pause", { id: d.id }], ["flows.resume", { id: d.id }], ["kits.propose", { kit: estateKit(1) }], ["kits.remove", { id: "x" }]])
    await assert.rejects(() => flows.tools[tool](withAgent, input), e => e.code === "chain_not_person", tool);
});

test("service: a text that is not valid is refused with a line, and nothing is stored", async () => {
  const { flows, person } = build();
  const r = await flows.tools["flows.define"](person, { text: "import x from 'fs';\nexport default 1;" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /only @vyre\/sdk may be imported/);
  assert.deepEqual(await flows.tools["flows.list"](person, {}), []);
});

test("service: a new version shows what changed in words, and a Kit goes through the same service", async () => {
  const { kernel, flows, person } = build();
  const d = await flows.tools["flows.define"](person, { flow: onPayment() });
  await flows.tools["flows.approve"](person, { id: d.id, version: d.version, hash: d.hash });
  const f2 = onPayment(); f2.steps[1].limit = 2;
  const d2 = await flows.tools["flows.define"](person, { id: d.id, flow: f2 });
  assert.equal(d2.version, 2);
  assert.ok(d2.changes.some(c => /Changes a step: Look up payment records/.test(c)));
  const p = await flows.tools["kits.propose"](person, { kit: estateKit(1) });
  assert.equal(p.ok, true);
  kernel.completeTask(p.task, { outcome: "approved" });
  await new Promise(r => setImmediate(r)); await flows.runner.drain(); await new Promise(r => setImmediate(r));
  assert.equal((await flows.tools["kits.list"](person, {}))[0].status, "installed");
});

test("service: simulation through the tool reports without writing", async () => {
  const { kernel, flows, person } = build();
  kernel.inbound("payment.received", { amount: 1, client: "A" });
  const r = await flows.tools["flows.simulate"](person, { flow: onPayment(), since: 0, until: Date.UTC(2027, 0, 1) });
  assert.equal(r.matched, 1);
  assert.equal([...(kernel.tables.get("matter") || new Map())].length, 0);
});
