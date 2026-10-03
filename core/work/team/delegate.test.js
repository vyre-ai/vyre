// @ts-check
// Delegation on the REAL kernel (test/kernel-rig.js): the real grants store contains a teammate's grant in its parent, records the parent, carries the adder's
// presence and approval conditions as obligations, and revokes a child with its parent. Only the presence verifier is a stand-in (SHIM(presence)).
import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "../../../test/kernel-rig.js";
const presenceOf = (rig) => (input) => rig.proof("grants.create", input, `vyre://${rig.space}/grant/new`);
import { tighten, delegateGrants, recheckParent, taskChainActors, chainIncludesAssigner, obligationsFrom, hasOutwardPower } from "./delegate.js";

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

// ---- DL-2 (reviewer-2): the helper starts from the parent's conditions and only tightens ----
const strict = (soon) => ({ delegate: { allowed: true, max_depth: 2 }, how: { presence: "fresh", approval: { by: "owner", once: true } }, when: { expires: soon, schedule: "0 9 * * 1" }, where: { surfaces: ["deck", "phone"] }, budget: { meter: "ai_spend", limit: 5 }, rate: { n: 10, per_seconds: 60 } });

async function strictWorld() {
  const w = await world();
  const soon = Date.now() + 3_600_000;
  const parent = await w.rig.grantTo(w.alice, ["records.read"], w.P1, { conditions: strict(soon) });
  const add = (/** @type {any} */ conditions, /** @type {any} */ extra = {}) => delegateGrants(w.rig.kernel, w.chain, { adder: w.alice, teammate: w.research, presence: presenceOf(w.rig), wanted: [{ actions: ["records.read"], prefix: w.P1, conditions, ...extra }] });
  const children = async () => (await w.rig.kernel.grants.list(w.chain, { subject: { kind: "actor", actor: w.research } })).length;
  return { ...w, soon, parent, add, children };
}

test("a wanted condition that would LOOSEN the parent's is refused, and nothing is created, for each condition", async () => {
  const x = await strictWorld();
  const cases = {
    "presence none": { how: { presence: "none" } },
    "presence session": { how: { presence: "session" } },
    "approval removed": { how: { approval: null } },
    "approval by someone else": { how: { approval: { by: "anyone" } } },
    "approval once relaxed": { how: { approval: { by: "owner", once: false } } },
    "a later expiry is not looser, but a different schedule is": { when: { schedule: "* * * * *" } },
    "a wider surface list": { where: { surfaces: ["deck", "phone", "capsule"] } },
    "a different surface": { where: { surfaces: ["capsule"] } },
    "a bigger budget on another meter": { budget: { meter: "other", limit: 1 } },
    "a faster rate": { rate: { n: 100, per_seconds: 60 } },
    "deeper delegation": { delegate: { allowed: true, max_depth: 9 } },
    "delegation as deep as the parent's": { delegate: { allowed: true, max_depth: 2 } },
  };
  for (const [name, conditions] of Object.entries(cases)) {
    await assert.rejects(x.add(conditions), { code: "loosens" }, name);
    assert.equal(await x.children(), 0, `${name}: nothing created`);
  }
});

test("a tighter wanted condition is kept, and the rest is the parent's own", async () => {
  const x = await strictWorld();
  const r = await x.add({ how: { presence: "fresh" }, when: { expires: x.soon - 1000 }, where: { surfaces: ["deck"] }, budget: { meter: "ai_spend", limit: 2 }, rate: { n: 5, per_seconds: 60 } });
  const c = r.grants[0].conditions;
  assert.equal(c.how.presence, "fresh");
  assert.deepEqual(c.how.approval, { by: "owner", once: true });
  assert.equal(c.when.expires, x.soon - 1000);
  assert.equal(c.when.schedule, "0 9 * * 1", "the parent's schedule rides along");
  assert.deepEqual(c.where.surfaces, ["deck"]);
  assert.deepEqual(c.budget, { meter: "ai_spend", limit: 2 });
  assert.deepEqual(c.rate, { n: 5, per_seconds: 60 });
  // a bare ask inherits every one of the parent's conditions
  const bare = (await x.add({})).grants[0].conditions;
  assert.equal(bare.how.presence, "fresh");
  assert.deepEqual(bare.where.surfaces, ["deck", "phone"]);
  assert.equal(bare.budget.limit, 5);
});

test("tighten on its own: the field list is a subset of the parent's and the parent's own when none is asked for", () => {
  const parent = { resource: { fields: ["a", "b"] }, conditions: {} };
  assert.deepEqual(tighten(parent, { fields: ["a"] }).fields, ["a"]);
  assert.deepEqual(tighten(parent, {}).fields, ["a", "b"]);
  assert.throws(() => tighten(parent, { fields: ["a", "c"] }), { code: "loosens" });
  assert.throws(() => tighten({ conditions: { how: { presence: "fresh" } } }, { conditions: { how: { presence: "bogus" } } }), { code: "loosens" });
});

test("a Kit role's field-limited grant becomes a real field allow-list on the teammate's grant", async () => {
  const { rig, P1, alice, research, chain } = await world();
  await rig.grantTo(alice, ["records.update"], P1, { conditions: delegable });
  const r = await delegateGrants(rig.kernel, chain, { adder: alice, teammate: research, presence: presenceOf(rig), wanted: [{ actions: ["records.update"], prefix: P1, fields: ["practice_area"] }] });
  assert.deepEqual(r.grants[0].resource.fields, ["practice_area"]);
});

// ---- DH-1 and DH-2 (reviewer-2): every parent dimension is carried, and what is accepted is what the kernel accepts ----
test("once, audience and the selector's own predicates are carried from the parent, and an unknown parent condition is refused", async () => {
  const w = await world();
  const soon = Date.now() + 3_600_000;
  await w.rig.grantTo(w.alice, ["records.read"], w.P1, { conditions: { delegate: { allowed: true, max_depth: 2 }, once: true, audience: ["memory", "flows"], how: { presence: "fresh" }, when: { expires: soon } } });
  const add = (c, e = {}) => delegateGrants(w.rig.kernel, w.chain, { adder: w.alice, teammate: w.research, presence: presenceOf(w.rig), wanted: [{ actions: ["records.read"], prefix: w.P1, conditions: c, ...e }] });
  await assert.rejects(add({ once: false }), { code: "loosens" });
  await assert.rejects(add({ audience: ["memory", "mail"] }), { code: "loosens" });
  const r = await add({ audience: ["memory"] });
  const c = r.grants[0].conditions;
  assert.equal(c.once, true);
  assert.deepEqual(c.audience, ["memory"]);
  assert.equal(c.how.presence, "fresh");
  assert.equal((await add({})).grants.at(-1).conditions.audience.join(), "memory,flows");
});

test("tighten on its own: unknown parent condition refused, the parent's predicates kept, schedule by value, rate the kernel's way", () => {
  assert.throws(() => tighten({ conditions: { shiny: true } }, {}), { code: "loosens" });
  const parent = { resource: { where: [{ attr: "project", op: "eq", value: "p1" }] }, conditions: { when: { expires: 9, schedule: "0 9 * * 1" }, rate: { n: 10, per_seconds: 60 } } };
  const t = tighten(parent, { resource_where: [{ attr: "sensitivity", op: "eq", value: "low" }], conditions: { when: { schedule: "0  9 * *  1" }, rate: { n: 5, per_seconds: 120 } } });
  assert.deepEqual(t.where, [{ attr: "project", op: "eq", value: "p1" }, { attr: "sensitivity", op: "eq", value: "low" }]);
  assert.equal(t.conditions.when.schedule, "0 9 * * 1");
  assert.throws(() => tighten(parent, { conditions: { rate: { n: 5, per_seconds: 30 } } }), { code: "loosens" }, "a shorter window is looser even with a smaller count");
  assert.throws(() => tighten(parent, { conditions: { rate: { n: 20, per_seconds: 600 } } }), { code: "loosens" }, "a larger count is looser even with a longer window");
  assert.throws(() => tighten(parent, { conditions: { when: { schedule: "* * * * *" } } }), { code: "loosens" });
});
