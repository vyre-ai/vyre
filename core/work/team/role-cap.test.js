// @ts-check
// A teammate acts under the grants of the person who added them, capped by that person's role (contract 9.4, R6-8), on the REAL kernel (test/kernel-rig.js). The cap is by role, not
// by one grant: an admin's teammate holds at most what the admin's role gives; when the owner narrows, demotes or removes the adder, the teammate loses the same power at the next
// decision, with nothing to re-add. Only the presence verifier is a stand-in (SHIM(presence)).
import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "../../../test/kernel-rig.js";
import { delegateGrants, recheckParent } from "./delegate.js";

const presenceOf = (/** @type {any} */ rig) => (/** @type {any} */ input) => rig.proof("grants.create", input, `vyre://${rig.space}/grant/new`);
const delegable = { delegate: { allowed: true, max_depth: 2 } };
const allowed = async (/** @type {any} */ rig, /** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource) => (await rig.kernel.authorize({ chain, action, resource })).effect === "allow";

async function world(role = "admin") {
  const rig = await createRig({ people: { per_alice: /** @type {any} */ (role), per_bob: "member" }, agents: ["research"] });
  const P1 = `vyre://${rig.space}/project/p1`;
  const alice = rig.actor("person", "per_alice"), research = rig.actor("agent", "research");
  return { rig, P1, alice, research, chain: rig.person("per_alice") };
}
const addRead = async (/** @type {any} */ w, actions = ["records.read", "records.update"]) => {
  await w.rig.grantTo(w.alice, actions, w.P1, { conditions: delegable });
  return delegateGrants(w.rig.kernel, w.chain, { adder: w.alice, teammate: w.research, presence: presenceOf(w.rig), wanted: [{ actions, prefix: w.P1 }] });
};

test("the teammate's powers are the adder's, and the chain of the adder's assistant is the narrower of the two", async () => {
  const w = await world();
  await addRead(w);
  const mine = w.rig.assistant("per_alice", "research");
  assert.equal(await allowed(w.rig, mine, "records.update", w.P1 + "/x"), true, "Alice's teammate acts for Alice with what Alice gave");
  assert.equal(await allowed(w.rig, mine, "records.update", `vyre://${w.rig.space}/project/p2/x`), false, "not beyond the prefix it was given");
  assert.equal(await allowed(w.rig, mine, "records.delete", w.P1 + "/x"), false, "not an action it was not given");
  // The same teammate asked by Bob, whose own reach the owner cut to reading: the chain holds both hops and each must allow, so Bob gets no write through it.
  await w.rig.restrict("per_bob", { actions: ["records.read"] });
  assert.equal(await allowed(w.rig, w.rig.assistant("per_bob", "research"), "records.update", w.P1 + "/x"), false);
  assert.equal(await allowed(w.rig, w.rig.assistant("per_bob", "research"), "records.read", w.P1 + "/x"), true);
});

test("a member cannot add a teammate with any power, whatever grants the teammate's kit asks for", async () => {
  const w = await world("member");
  await assert.rejects(delegateGrants(w.rig.kernel, w.rig.person("per_bob"), { adder: w.rig.actor("person", "per_bob"), teammate: w.research, presence: presenceOf(w.rig), wanted: [{ actions: ["records.read"], prefix: w.P1 }] }), /./);
  assert.equal((await w.rig.kernel.grants.list(w.rig.ownerChain, { subject: { kind: "actor", actor: w.research } })).length, 0, "nothing was created");
});

test("narrowing the adder cuts the teammate in the same call: no re-add, no stale power", async () => {
  const w = await world();
  const { grants } = await addRead(w);
  const mine = w.rig.assistant("per_alice", "research");
  assert.equal(await allowed(w.rig, mine, "records.update", w.P1 + "/x"), true);
  await w.rig.restrict("per_alice", { actions: ["records.read"] });
  assert.equal(await allowed(w.rig, mine, "records.update", w.P1 + "/x"), false, "the adder can no longer update, so neither can their teammate");
  // The kernel stops honouring a child its parent no longer contains, and the teammate says so (paused with a reason) rather than looking active while every call is refused.
  assert.equal(await allowed(w.rig, mine, "records.read", w.P1 + "/x"), false, "a child its parent no longer contains is not live");
  assert.equal(await allowed(w.rig, w.rig.person("per_alice"), "records.read", w.P1 + "/x"), true, "Alice herself still reads");
  assert.deepEqual(await recheckParent(w.rig.kernel, w.chain, { adder: w.alice, grants }), { ok: false, paused: true, reason: "parent_narrowed" });
});

test("demoting the adder to a member takes the role-derived power from the teammate; removing the adder from the Space takes the rest", async () => {
  const w = await world();
  await addRead(w);
  const mine = w.rig.assistant("per_alice", "research");
  const G = w.rig.k.gateway.grants;
  const role = { person: "per_alice", role: "member" };
  await G.setRole(w.rig.ownerChain, role, { presence: w.rig.proof("grants.role", role, `vyre://${w.rig.space}/member/per_alice`) });
  // What the teammate holds on P1 came through a grant given to Alice by hand, which a role change leaves alone; nothing outside it was ever the teammate's.
  assert.equal(await allowed(w.rig, mine, "records.update", w.P1 + "/x"), true, "the explicit grant still stands");
  assert.equal(await allowed(w.rig, mine, "records.update", `vyre://${w.rig.space}/matter/m_9`), false, "no admin-role reach for the teammate");
  const gone = { person: "per_alice" };
  await G.removeMember(w.rig.ownerChain, gone, { presence: w.rig.proof("grants.role", { remove: "per_alice" }, `vyre://${w.rig.space}/member/per_alice`) });
  assert.equal(await allowed(w.rig, mine, "records.read", w.P1 + "/x"), false, "the adder left the Space: the teammate acts for no one");
});
