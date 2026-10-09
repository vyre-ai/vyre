import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { Proposals } from "./proposals.js";

// Another module's kind of proposal (an agent's change to itself, a template, a skill) rides the same card, task, hash and approve-and-apply path as a Flow: R031-09's "agent proposes, owner approves".
async function kworld(kind) {
  const w = await world({ store: "records" });
  const chains = { forFlow: x => w.kernel.chainFor(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) };
  const proposals = new Proposals({ kernel: w.kernel, runner: w.runner, store: w.store, chain: () => w.kernel.sysChain(), chains, catalog: () => w.cat, isAdmin: who => who.id === ALEX.id, kinds: { thing: kind } });
  w.offs.push(w.kernel.onEvent(e => { void proposals.onEvent(e); }, "proposals"));
  const bobsAssistant = w.kernel.chains.fromFacts({ kind: "agent_session", person: BOB.id, agent: "research", session: "s", thread: "t", vouched: true });
  return { w, proposals, bobsAssistant };
}
const settleAll = async w => { await settle(w); await new Promise(r => setImmediate(r)); await settle(w); };

test("a registered kind: its checker (not the proposer) is asked, its own yes applies it as that person, once, and a rejection applies nothing", async () => {
  const calls = [];
  let title = "Change kit: instructions?";
  const kind = {
    draft: async (chain, spec, proposer) => ({ form: { thing: "kit", draft: "d1" }, title, idem: "d1", checker: { kind: "person", id: ALEX.id, space: proposer.space } }),
    title: async () => title,
    mayCheck: async checker => checker.id === ALEX.id,
    apply: async (checker, form) => { calls.push([checker.id, form.draft]); },
  };
  const { w, proposals, bobsAssistant } = await kworld(kind);
  // Bob is not an admin; for an ordinary proposal he would be refused. A kind decides who may propose and who says yes.
  const p = await proposals.propose(bobsAssistant, { what: "thing" });
  assert.equal(p.ok, true); assert.equal(p.approver, ALEX.id); assert.equal(p.by, "research");
  await settle(w);
  const task = w.kernel.tasks.find(t => t.id === p.task);
  assert.deepEqual([task.form.kind, task.form.what, task.form.draft, task.checker.id], ["proposal", "thing", "d1", ALEX.id]);
  assert.deepEqual(calls, [], "nothing applied before the yes");
  assert.equal((await proposals.propose(bobsAssistant, { what: "thing" })).task, p.task, "asking again is the same task");
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settleAll(w);
  assert.deepEqual(calls, [[ALEX.id, "d1"]], "applied as the checker, once");
});

test("a registered kind: a rejection applies nothing, and a card whose draft changed since (its title no longer matches) applies nothing", async () => {
  const calls = [];
  let title = "Change kit: instructions?";
  const kind = {
    draft: async (c, s, proposer) => ({ form: { draft: s.n }, title, idem: `d${s.n}`, checker: { kind: "person", id: ALEX.id, space: proposer.space } }),
    title: async () => title, mayCheck: async () => true, apply: async (checker, form) => { calls.push(form.draft); },
  };
  const { w, proposals, bobsAssistant } = await kworld(kind);
  const a = await proposals.propose(bobsAssistant, { what: "thing", n: 1 });
  await settle(w);
  w.kernel.completeTask(a.task, { outcome: "rejected" });
  await settleAll(w);
  const b = await proposals.propose(bobsAssistant, { what: "thing", n: 2 });
  await settle(w);
  title = "Change kit: skills?";   // the stored draft is not what the card says any more
  w.kernel.completeTask(b.task, { outcome: "approved" });
  await settleAll(w);
  assert.deepEqual(calls, []);
});

test("a kind that names no person to say yes is refused, and a kind it does not have is the old error", async () => {
  const kind = { draft: async () => ({ form: {}, title: "x", idem: "x", checker: null }), title: async () => "x", mayCheck: async () => true, apply: async () => {} };
  const { proposals, bobsAssistant } = await kworld(kind);
  await assert.rejects(proposals.propose(bobsAssistant, { what: "thing" }), /needs a person/);
  await assert.rejects(proposals.propose(bobsAssistant, { what: "other" }), e => e.code === "not_found");
});
