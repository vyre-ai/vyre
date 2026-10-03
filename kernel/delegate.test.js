import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "./index.js";
import { canonical, sha256 } from "./core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) ? null : "wrong_proof") };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 6), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  const r = { person: BOB, role: "member" };
  await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${BOB}`) });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const forBob = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: BOB, agent: "assistant", session: "s1" });
  const forOwner = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "assistant", session: "s2" });
  const alone = k.chains.fromFacts({ kind: "socket", surface: "mcp", uid: 501, pid: 1, inside_model_process: true, capsule_verified: false });
  const decide = (chain, action, resource) => k.gateway.authorize({ chain, action, resource });
  return { k, owner, bob, forBob, forOwner, alone, decide, g };
}
const contact = `vyre://${SPACE}/contact/c1`;

test("the default assistant is a delegate: alone it can do nothing; for a person it can do what that person can and no more", async () => {
  const { k, bob, forBob, alone, decide, owner, g } = await rig();
  // alone: no grants of its own
  assert.equal((await decide(alone, "records.read", contact)).effect, "deny", "alone, no read");
  assert.equal((await decide(alone, "records.update", contact)).effect, "deny");
  // for a member: exactly what the member can, and not what the member cannot
  const member = await decide(bob, "records.read", contact);
  assert.equal(member.effect, "allow");
  assert.equal((await decide(forBob, "records.read", contact)).effect, "allow", "reads what Bob reads");
  assert.equal((await decide(forBob, "records.update", contact)).effect, (await decide(bob, "records.update", contact)).effect, "updates what Bob updates and no more");
  // narrow Bob's own authority and the assistant follows it down
  const gi = { subject: { kind: "actor", actor: { kind: "person", id: BOB, space: SPACE } }, actions: ["seal.deliver"], resource: { prefix: `vyre://${SPACE}/message/*` }, conditions: {}, source: "test" };
  await g.create(owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) });
  assert.equal((await decide(forBob, "records.update", `vyre://${SPACE}/invoice/i1`)).effect, (await decide(bob, "records.update", `vyre://${SPACE}/invoice/i1`)).effect);
  // never a grant or role change, never chat membership
  assert.equal((await decide(forBob, "grants.role", `vyre://${SPACE}/member/per_x`)).effect, "deny", "a role change is refused to a model chain");
  assert.equal((await decide(forBob, "grants.create", `vyre://${SPACE}/grant/new`)).effect, "deny");
  const role = { person: "per_x", role: "member" };
  await assert.rejects(() => g.setRole(forBob, role, {}), { code: "chain_not_person" });
  await assert.rejects(() => g.chats.create(forBob, {}), { code: "chain_not_person" });
  // a sealed reveal needs the person themselves
  assert.notEqual((await decide(forBob, "seal.reveal", `vyre://${SPACE}/contact/c1`)).effect, "allow");
  // anything that leaves the Space raises a task instead of running, even for the owner's own assistant
  assert.equal((await decide(bob, "seal.deliver", `vyre://${SPACE}/message/m1`)).effect, "ask", "Bob's own send asks too");
  assert.equal((await decide(forBob, "seal.deliver", `vyre://${SPACE}/message/m1`)).effect, "ask", "a send by his assistant raises a task instead of running");
  assert.equal((await decide(forBob, "seal.deliver", `vyre://${SPACE}/other/m1`)).effect, "deny", "and only where Bob may send");
  assert.ok(k);
});

test("a named assistant is not a delegate: its own grants narrow it, and with none it does nothing", async () => {
  const { k, owner, decide, g } = await rig();
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const forOwnerKit = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "kit", session: "s3" });
  assert.equal((await decide(forOwnerKit, "records.read", contact)).effect, "deny", "kit has no grant, so even for the owner it can read nothing");
});

test("a Space without the default assistant (made before it existed) is told so, and gets it only by an owner's approval with presence", async () => {
  const { k, owner, g, forBob, decide } = await rig();
  assert.equal(g.defaultAssistant.present(), true, "a new Space starts with it");
  // the same chain in a Space that lacks the actor is not a member, so it can do nothing and the reason is plain
  const k2 = await createKernel({ space: "spc_bbbbbbbbbbbb", owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence, bootstrap: false });
  assert.equal(k2.gateway.grants.defaultAssistant.present(), false);
  assert.ok(k && owner && forBob && decide);
});

test("the default assistant has an off switch: an owner removes it with presence, unnamed chats are then refused plainly, and an owner can add it back", async () => {
  const { owner, bob, forBob, decide, g } = await rig();
  const dflt = { kind: "agent", id: "assistant", space: SPACE };
  assert.equal((await decide(forBob, "records.read", contact)).effect, "allow");
  await assert.rejects(() => g.defaultAssistant.remove(owner, {}), { code: "needs_presence" }, "needs the owner's presence");
  await assert.rejects(() => g.defaultAssistant.remove(bob, { presence: proof("grants.role", { remove_actor: dflt }, `vyre://${SPACE}/member/assistant`) }), e => ["chain_not_person", "not_found", "not_allowed", "denied"].includes(e.code), "not a member's act");
  await g.defaultAssistant.remove(owner, { presence: proof("grants.role", { remove_actor: dflt }, `vyre://${SPACE}/member/assistant`) });
  assert.equal(g.defaultAssistant.present(), false);
  const gone = await decide(forBob, "records.read", contact);
  assert.equal(gone.effect, "deny");
  assert.equal(gone.reason, "not_a_member", "the reason is plain: no assistant is available");
  assert.equal((await decide(bob, "records.read", contact)).effect, "allow", "Bob himself is unaffected");
  await g.defaultAssistant.add(owner, { presence: proof("grants.role", { actor: dflt }, `vyre://${SPACE}/member/assistant`) });
  assert.equal((await decide(forBob, "records.read", contact)).effect, "allow", "added back");
  await g.rebuild();
  assert.equal(g.defaultAssistant.present(), true, "and it survives a rebuild from the log");
});
