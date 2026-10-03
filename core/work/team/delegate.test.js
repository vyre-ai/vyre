// @ts-check
// Delegation on the REAL kernel (test/kernel-rig.js): the real grants store contains a teammate's grant in its parent, records the parent, carries the adder's
// presence and approval conditions as obligations, and revokes a child with its parent. Only the presence verifier is a stand-in (SHIM(presence)).
import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "../../../test/kernel-rig.js";
const presenceOf = (rig) => (input) => rig.proof("grants.create", input, `vyre://${rig.space}/grant/new`);
import { delegateGrants, recheckParent, taskChainActors, chainIncludesAssigner, obligationsFrom, hasOutwardPower } from "./delegate.js";

async function world() {
  const rig = await createRig({ people: { per_alice: "admin", per_bob: "member" }, agents: ["research"] });
  const P1 = `vyre://${rig.space}/project/p1`;
  const alice = rig.actor("person", "per_alice"), research = rig.actor("agent", "research"), bob = rig.actor("person", "per_bob");
  return { rig, P1, alice, research, bob, chain: rig.person("per_alice") };
}
const delegable = { delegate: { allowed: true, max_depth: 2 } };

test("a teammate's grants are narrowings of the adder's: containment, with the parent recorded", async () => {
  const { rig, P1, alice, research, chain } = await world();
  const parent = await rig.grantTo(alice, ["records.read", "records.update"], P1, { conditions: delegable });
  const r = await delegateGrants(rig.kernel, chain, { adder: alice, teammate: research, presence: presenceOf(rig), wanted: [{ actions: ["records.read"], prefix: P1 }] });
  assert.equal(r.grants.length, 1);
  assert.equal(r.grants[0].parent, parent.id, "the most specific grant that may be delegated is the parent");
  assert.deepEqual(r.grants[0].actions, ["records.read"]);
});

test("a wanted power the adder does not hold refuses the whole add and creates nothing", async () => {
  const { rig, P1, alice, research, chain } = await world();
  await assert.rejects(delegateGrants(rig.kernel, chain, { adder: alice, teammate: research, presence: presenceOf(rig), wanted: [{ actions: ["records.read"], prefix: P1 }, { actions: ["email.send"], prefix: P1 }] }), { code: "not_contained" });
  assert.equal((await rig.kernel.grants.list(chain, { subject: { kind: "actor", actor: research } })).length, 0);
  // A member's own grants may not be delegated at all: only an owner or an admin gives access (the kernel's rule).
  await assert.rejects(delegateGrants(rig.kernel, rig.person("per_bob"), { adder: rig.actor("person", "per_bob"), teammate: research, presence: presenceOf(rig), wanted: [{ actions: ["records.read"], prefix: P1 }] }), /./);
  assert.equal((await rig.kernel.grants.list(chain, { subject: { kind: "actor", actor: research } })).length, 0);
});

test("the adder's presence and approval conditions stay on the teammate as obligations, and time is intersected (R6-8)", async () => {
  const { rig, P1, alice, research, chain } = await world();
  const soon = Date.now() + 3_600_000;
  await rig.grantTo(alice, ["records.read"], P1, { conditions: { ...delegable, how: { presence: "fresh", approval: { by: "owner" } }, when: { expires: soon }, where: { surfaces: ["deck"] } } });
  const r = await delegateGrants(rig.kernel, chain, { adder: alice, teammate: research, presence: presenceOf(rig), wanted: [{ actions: ["records.read"], prefix: P1, conditions: { when: { expires: soon + 9_999_999 } } }] });
  const g = r.grants[0];
  assert.equal(g.conditions.how.presence, "fresh");
  assert.equal(g.conditions.how.approval.by, "owner");
  assert.equal(g.conditions.when.expires, soon, "never later than the adder's");
  assert.deepEqual(g.conditions.where.surfaces, ["deck"]);
  assert.ok(r.obligations[0].obligations.map(o => o.type).includes("presence"));
  assert.ok(r.obligations[0].obligations.map(o => o.type).includes("ask"));
  // At a decision the teammate needs presence: an Ask, not silently dropped. (Its `where` names the deck surface, which an agent session is not: the kernel denies it,
  // so the Ask is shown on a second path with the same conditions and no surface limit.)
  const P2 = `vyre://${rig.space}/project/p2`;
  await rig.grantTo(alice, ["records.read"], P2, { conditions: { ...delegable, how: { presence: "fresh", approval: { by: "owner" } } } });
  await delegateGrants(rig.kernel, chain, { adder: alice, teammate: research, presence: presenceOf(rig), wanted: [{ actions: ["records.read"], prefix: P2 }] });
  assert.equal((await rig.kernel.authorize({ chain: rig.assistant("per_alice", "research"), action: "records.read", resource: P1 + "/x" })).effect, "deny", "outside the deck, the teammate may not act on P1");
  const d = await rig.kernel.authorize({ chain: rig.assistant("per_alice", "research"), action: "records.read", resource: P2 + "/x" });
  assert.equal(d.effect, "ask");
  assert.ok(d.obligations.some((/** @type {any} */ o) => o.type === "presence"));
});

test("the teammate pauses at the next decision when the adder loses the grant, leaves or is limited (fails closed)", async () => {
  const { rig, P1, alice, research, chain } = await world();
  const parent = await rig.grantTo(alice, ["records.read"], P1, { conditions: delegable });
  const { grants } = await delegateGrants(rig.kernel, chain, { adder: alice, teammate: research, presence: presenceOf(rig), wanted: [{ actions: ["records.read"], prefix: P1 }] });
  assert.deepEqual(await recheckParent(rig.kernel, chain, { adder: alice, grants }), { ok: true, paused: false });
  assert.equal((await recheckParent(rig.kernel, chain, { adder: alice, grants, membership: async () => ({ member: false }) })).reason, "adder_left");
  assert.equal((await recheckParent(rig.kernel, chain, { adder: alice, grants, membership: async () => ({ member: true, limited: true }) })).reason, "adder_limited");
  assert.equal((await recheckParent(rig.kernel, chain, { adder: alice, grants, membership: async () => { throw new Error("down"); } })).reason, "unknown");
  assert.equal((await rig.kernel.authorize({ chain: rig.assistant("per_alice", "research"), action: "records.read", resource: P1 + "/x" })).effect, "allow");
  const input = { id: parent.id, reason: "left" };
  await rig.k.gateway.grants.revoke(chain, parent.id, "left", { presence: rig.proof("grants.revoke", input, `vyre://${rig.space}/grant/${parent.id}`) });
  const r = await recheckParent(rig.kernel, chain, { adder: alice, grants });
  assert.deepEqual([r.ok, r.paused, r.reason], [false, true, "parent_gone"]);
  // and the kernel itself no longer lets the teammate act: the child went with its parent
  assert.equal((await rig.kernel.authorize({ chain: rig.assistant("per_alice", "research"), action: "records.read", resource: P1 + "/x" })).effect, "deny");
});

test("an expired parent pauses the teammate", async () => {
  const { rig, P1, alice, research, chain } = await world();
  const expires = Date.now() + 60_000;
  await rig.grantTo(alice, ["records.read"], P1, { conditions: { ...delegable, when: { expires } } });
  const { grants } = await delegateGrants(rig.kernel, chain, { adder: alice, teammate: research, presence: presenceOf(rig), wanted: [{ actions: ["records.read"], prefix: P1 }] });
  assert.equal((await recheckParent(rig.kernel, chain, { adder: alice, grants, now: Date.now() })).ok, true);
  assert.equal((await recheckParent(rig.kernel, chain, { adder: alice, grants, now: expires + 1 })).reason, "parent_gone");
});

test("a task's chain includes the assigner, so a teammate is no lever for someone with less (R6-9)", async () => {
  const { rig, P1, research, bob } = await world();
  await rig.grantTo(research, ["records.read", "records.update", "records.create"], P1);
  await rig.restrict("per_bob", { actions: ["records.read"], prefix: P1 });
  assert.deepEqual(taskChainActors(bob, research).map(a => a.id), ["per_bob", "research"]);
  assert.equal(taskChainActors(research, research).length, 1);
  const c = rig.assistant("per_bob", "research");
  assert.equal((await rig.kernel.authorize({ chain: c, action: "records.update", resource: P1 + "/x" })).effect, "deny", "Bob cannot write through Research");
  assert.equal((await rig.kernel.authorize({ chain: c, action: "records.read", resource: P1 + "/x" })).effect, "allow");
  assert.equal(chainIncludesAssigner(c, { assigned_by: bob, doer: research }), true);
  assert.equal(chainIncludesAssigner(rig.assistant("per_alex", "research"), { assigned_by: bob, doer: research }), false);
});

test("obligationsFrom and hasOutwardPower", () => {
  assert.deepEqual(obligationsFrom({ conditions: { how: { presence: "none" } } }), []);
  assert.equal(hasOutwardPower([{ actions: ["records.read"] }]), false);
  assert.equal(hasOutwardPower([{ actions: ["records.read", "email.send"] }]), true);
});
