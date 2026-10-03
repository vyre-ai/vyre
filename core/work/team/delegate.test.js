// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeKernel } from "../../../test/fake-kernel.js";
import { delegateGrants, recheckParent, taskChainActors, chainIncludesAssigner, obligationsFrom, hasOutwardPower } from "./delegate.js";

const P1 = "vyre://spc_test/project/p1";
function world() {
  const f = createFakeKernel();
  const alice = f.person("alice"), research = f.agent("research");
  f.grant(alice, ["grant.create"]);
  return { f, alice, research, chain: f.chain([alice]) };
}

test("a teammate's grants are narrowings of the adder's: containment, with the parent recorded", async () => {
  const { f, alice, research, chain } = world();
  const parent = f.grant(alice, ["records.read", "records.update"], P1);
  const r = await delegateGrants(f.kernel, chain, { adder: alice, teammate: research, wanted: [{ actions: ["records.read"], prefix: P1 }] });
  assert.equal(r.grants.length, 1);
  assert.equal(r.grants[0].parent, parent.id);
  assert.deepEqual(r.grants[0].actions, ["records.read"]);
});

test("a wanted power the adder does not hold refuses the whole add and creates nothing", async () => {
  const { f, alice, research, chain } = world();
  f.grant(alice, ["records.read"], P1);
  await assert.rejects(delegateGrants(f.kernel, chain, { adder: alice, teammate: research, wanted: [{ actions: ["records.read"], prefix: P1 }, { actions: ["email.send"], prefix: P1 }] }), { code: "not_contained" });
  assert.equal((await f.kernel.grants.list(chain, { subject: { kind: "actor", actor: research } })).length, 0);
  await assert.rejects(delegateGrants(f.kernel, chain, { adder: alice, teammate: research, wanted: [{ actions: ["records.read"], prefix: "vyre://spc_test/project/other" }] }), { code: "not_contained" });
});

test("the adder's presence and approval conditions stay on the teammate as obligations, and time is intersected (R6-8)", async () => {
  const { f, alice, research, chain } = world();
  const soon = Date.now() + 3_600_000;
  f.grant(alice, ["records.read"], P1, { how: { presence: "fresh", approval: { by: "owner" } }, when: { expires: soon }, where: { surfaces: ["deck"] } });
  const r = await delegateGrants(f.kernel, chain, { adder: alice, teammate: research, wanted: [{ actions: ["records.read"], prefix: P1, conditions: { when: { expires: soon + 9_999_999 } } }] });
  const g = r.grants[0];
  assert.equal(g.conditions.how.presence, "fresh");
  assert.equal(g.conditions.how.approval.by, "owner");
  assert.equal(g.conditions.when.expires, soon, "never later than the adder's");
  assert.deepEqual(g.conditions.where.surfaces, ["deck"]);
  assert.deepEqual(r.obligations[0].obligations.map(o => o.type), ["presence", "ask"]);
  // At a decision the teammate needs presence: an Ask, not silently dropped.
  const d = await f.kernel.authorize({ chain: f.chain([research]), action: "records.read", resource: P1 + "/x" });
  assert.equal(d.effect, "ask");
  assert.ok(d.obligations.some(o => o.type === "presence"));
});

test("the teammate pauses at the next decision when the adder loses the grant, leaves or is limited (fails closed)", async () => {
  const { f, alice, research, chain } = world();
  const parent = f.grant(alice, ["records.read"], P1);
  const { grants } = await delegateGrants(f.kernel, chain, { adder: alice, teammate: research, wanted: [{ actions: ["records.read"], prefix: P1 }] });
  assert.deepEqual(await recheckParent(f.kernel, chain, { adder: alice, grants }), { ok: true, paused: false });
  assert.equal((await recheckParent(f.kernel, chain, { adder: alice, grants, membership: async () => ({ member: false }) })).reason, "adder_left");
  assert.equal((await recheckParent(f.kernel, chain, { adder: alice, grants, membership: async () => ({ member: true, limited: true }) })).reason, "adder_limited");
  assert.equal((await recheckParent(f.kernel, chain, { adder: alice, grants, membership: async () => { throw new Error("down"); } })).reason, "unknown");
  await f.kernel.grants.revoke(chain, parent.id, "left");
  const r = await recheckParent(f.kernel, chain, { adder: alice, grants });
  assert.deepEqual([r.ok, r.paused, r.reason], [false, true, "parent_gone"]);
  // and the kernel itself no longer lets the teammate act
  assert.equal((await f.kernel.authorize({ chain: f.chain([research]), action: "records.read", resource: P1 })).effect, "deny");
});

test("an expired parent pauses the teammate", async () => {
  const { f, alice, research, chain } = world();
  let t = 1000;
  f.grant(alice, ["records.read"], P1, { when: { expires: 5000 } });
  const { grants } = await delegateGrants(f.kernel, chain, { adder: alice, teammate: research, wanted: [{ actions: ["records.read"], prefix: P1 }] });
  assert.equal((await recheckParent(f.kernel, chain, { adder: alice, grants, now: t })).ok, true);
  t = 6000;
  assert.equal((await recheckParent(f.kernel, chain, { adder: alice, grants, now: t })).reason, "parent_gone");
});

test("a task's chain includes the assigner, so a teammate is no lever for someone with less (R6-9)", async () => {
  const { f, alice, research } = world();
  const bob = f.person("bob");
  f.grant(research, ["records.read", "records.update"], P1);
  f.grant(bob, ["records.read"], P1);
  assert.deepEqual(taskChainActors(bob, research).map(a => a.id), ["bob", "research"]);
  assert.equal(taskChainActors(research, research).length, 1);
  const c = f.chain(taskChainActors(bob, research));
  await assert.rejects(f.kernel.records.create(c, "note", { text: "x" }), { code: "not_found" }, "Bob cannot write through Research");
  assert.equal(chainIncludesAssigner(c, { assigned_by: bob, doer: research }), true);
  assert.equal(chainIncludesAssigner(f.chain([research]), { assigned_by: bob, doer: research }), false);
  assert.equal(alice.id, "alice");
});

test("obligationsFrom and hasOutwardPower", () => {
  assert.deepEqual(obligationsFrom({ conditions: { how: { presence: "none" } } }), []);
  assert.equal(hasOutwardPower([{ actions: ["records.read"] }]), false);
  assert.equal(hasOutwardPower([{ actions: ["records.read", "email.send"] }]), true);
});
