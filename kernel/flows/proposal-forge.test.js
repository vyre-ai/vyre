// reviewer-2 repro PR-1: Proposals.onEvent acts on ANY done+approved task whose form says kind "proposal", whoever created it. An assistant can request such a task itself
// with a benign card name and a pointer at a different draft Flow; the admin's yes then approves the pointed-at Flow.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX } from "./testing/world.js";
import { onPayment } from "./testing/fixtures.js";
import { Proposals } from "./proposals.js";

test("PR-1: a proposal task the assistant wrote itself (not made by Proposals.propose) is applied when approved", async () => {
  const w = await world({ store: "records" });
  const chains = { forFlow: x => w.kernel.chainFor(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) };
  const proposals = new Proposals({ kernel: w.kernel, runner: w.runner, store: w.store, chain: () => w.kernel.sysChain(), chains, catalog: () => w.cat, isAdmin: who => who.id === ALEX.id, applyTypes: async () => {} });
  w.offs.push(w.kernel.onEvent(e => { void proposals.onEvent(e); }, "proposals"));
  const assistant = w.kernel.chains.fromFacts({ kind: "agent_session", person: ALEX.id, agent: "research", session: "s", thread: "t", vouched: true });
  const d = await w.runner.define(null, onPayment(), { kind: "agent", id: "research", space: w.cat.space });   // the draft the assistant wants approved
  const t = await w.kernel.ask.request(assistant, { title: "Approve the Flow \"Weekly newsletter\"?", output: { kind: "decision" }, source: "manual",
    form: { kind: "proposal", what: "flow", flow: d.id, version: d.version, hash: d.hash, name: "Weekly newsletter" },
    doer: { kind: "agent", id: "research", space: w.cat.space }, checker: ALEX });
  await settle(w);
  w.kernel.completeTask(t.id, { outcome: "approved" });   // the admin's yes on the card they were shown
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  const v = await w.store.getVersion(d.id, d.version);
  console.log("flow approved by:", v.approver && v.approver.id, "card name shown: Weekly newsletter; flow label:", v.flow.label || v.flow.name);
  assert.equal(v.approver, null, "a task Proposals did not make must not approve a Flow, and the card name must come from the stored Flow");
});
