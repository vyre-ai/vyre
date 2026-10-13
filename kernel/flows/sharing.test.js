// Who may reach what in a Flow: each step records who added it (`added_by`, set by the server), the adder must reach the step's targets when it is added and again when it runs,
// and changing a Flow that someone else made takes Can edit (the creator, an owner or admin, or a grant of flows.define on that Flow).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { createFlows } from "./index.js";

const base = (steps, extra = {}) => ({ format: 1, name: "t", label: "T", authorship: "builder", trigger: { on: "manual" }, steps, ...extra });
const make = (id, extra = {}) => ({ id, kind: "create", type: "payment", set: { amount: 1 }, ...extra });
const toolsOf = (w) => createFlows({ kernel: w.kernel, chains: { forFlow: x => w.kernel.chainFor(x), forModule: x => w.kernel.moduleChain(x), forDoer: x => w.kernel.moduleChain({ module: "flows", approver: x.approver }) }, catalog: () => w.cat, store: w.store, clock: () => w.clock.t, emit: () => {}, ports: w.runner.ports });
const chainOf = actor => ({ hops: [{ actor }] });

test("each step records who added it, and a value sent by a client is ignored", async () => {
  const w = await world();
  const a = await w.runner.define(null, base([make("one", { added_by: "per_bob" })]), ALEX);
  assert.equal(a.ok, true, JSON.stringify(a.errors));
  const v1 = (await w.store.getVersion(a.id, a.version)).flow;
  assert.equal(v1.steps[0].added_by, ALEX.id, "the server, not the client, says who added it");
  // BOB adds a second step to ALEX's Flow: the first keeps ALEX, the new one is BOB's
  const b = await w.runner.define(a.id, base([make("one"), make("two")]), BOB);
  assert.equal(b.ok, true, JSON.stringify(b.errors));
  const v2 = (await w.store.getVersion(b.id, b.version)).flow;
  assert.deepEqual(v2.steps.map(s => [s.id, s.added_by]), [["one", ALEX.id], ["two", BOB.id]]);
});

test("a step the adder cannot reach is refused when it is added", async () => {
  const w = await world();
  w.kernel.rules.push({ match: i => i.action === "records.create" && i.resource.endsWith("/payment/*") && i.chain.hops.at(-1).actor.id === BOB.id, effect: "deny", reason: "no access" });
  const d = await w.runner.define(null, base([make("one")]), BOB);
  assert.equal(d.ok, false);
  assert.match(d.errors[0].message, /cannot reach/);
  const ok = await w.runner.define(null, base([make("one")]), ALEX);
  assert.equal(ok.ok, true, "someone who can reach it may add it");
});

test("a step runs only if its adder can still reach what it touches, even when the approver can", async () => {
  const w = await world();
  const d = await w.runner.define(null, base([make("one")]), BOB);
  assert.equal(d.ok, true, JSON.stringify(d.errors));
  await w.runner.approve(d.id, d.version, ALEX, d.hash);
  w.kernel.rules.push({ match: i => i.action === "records.create" && i.resource.endsWith("/payment/*") && i.chain.hops.at(-1).actor.id === BOB.id, effect: "deny", reason: "no access" });
  await w.runner.start(d.id, {}, chainOf(ALEX));
  await settle(w);
  const [run] = await w.runner.listRuns({ flow: d.id });
  assert.notEqual(run.state, "done", "the adder lost access to payments, so the step does not run");
  assert.match(JSON.stringify(run), /added it|adder/);
});

test("changing a Flow someone else made takes Can edit", async () => {
  const w = await world();
  const t = toolsOf(w);
  const made = await t.tools["flows.define"](chainOf(ALEX), { flow: base([make("one")]) });
  assert.equal(made.ok, true, JSON.stringify(made.errors));
  const next = base([make("one"), make("two")]);
  await assert.rejects(() => t.tools["flows.define"](chainOf(BOB), { id: made.id, flow: next }), /edit/);
  const mine = await t.tools["flows.define"](chainOf(ALEX), { id: made.id, flow: next });
  assert.equal(mine.ok, true, "the creator edits freely");
  // a grant of flows.define on that Flow is Can edit
  w.kernel.rules.push({ match: i => i.action === "flows.define" && i.resource.endsWith(`/flow/${made.id}`) && i.chain.hops.at(-1).actor.id === BOB.id, effect: "allow", reason: "granted" });
  const shared = await t.tools["flows.define"](chainOf(BOB), { id: made.id, flow: base([make("one"), make("two"), make("three")]) });
  assert.equal(shared.ok, true, JSON.stringify(shared.errors));
});
