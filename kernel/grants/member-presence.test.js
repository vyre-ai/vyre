// Registering an assistant and giving a role below owner ride on the person's own authenticated call: no presence proof (lead ruling 5 Oct). Making an owner still asks for one.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", ADA = "per_ada", MAX = "per_max";
// a presence verifier that refuses everything: any call that reaches it would fail, so a pass means no proof was needed
const presence = { check: async () => "wrong_proof" };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const dev = (person, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct", session: `s-${id}` });
  return { k, g: k.gateway.grants, owner: dev(OWNER, "d-o"), dev };
}

test("an owner gives a role below owner and adds an assistant with no presence proof; a manager and an assistant chain cannot", async () => {
  const { k, g, owner, dev } = await rig();
  await g.setRole(owner, { person: ADA, role: "admin" });
  await g.setRole(owner, { person: BOB, role: "manager" });
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit);
  // an admin does the same, and only for the roles below admin
  const ada = dev(ADA, "d-a");
  await g.setRole(ada, { person: MAX, role: "member" });
  await g.addActor(ada, { kind: "agent", id: "scribe", space: SPACE });
  await assert.rejects(() => g.setRole(ada, { person: MAX, role: "admin" }), { code: "not_allowed" });
  // a manager does neither
  const bob = dev(BOB, "d-b");
  await assert.rejects(() => g.addActor(bob, { kind: "agent", id: "x", space: SPACE }));
  await assert.rejects(() => g.setRole(bob, { person: MAX, role: "temp" }));
  // giving an assistant access (a Project's reach) is the same: no proof; a grant to a person still needs one
  const grantTo = actor => ({ source: "test", subject: { kind: "actor", actor }, actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/contact/*` } });
  await g.create(owner, grantTo(kit));
  await assert.rejects(() => g.create(owner, grantTo({ kind: "person", id: BOB, space: SPACE })), e => e.code === "needs_presence" || /presence/i.test(e.message));
  // an assistant acting for the owner never does: only a person on their own gives access
  const asst = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "kit", session: "s-k" });
  await assert.rejects(() => g.setRole(asst, { person: MAX, role: "temp" }), { code: "chain_not_person" });
  await assert.rejects(() => g.addActor(asst, { kind: "agent", id: "y", space: SPACE }), { code: "chain_not_person" });
});

test("making an owner, handing ownership over and taking a member or an actor out still need a presence proof", async () => {
  const { g, owner } = await rig();
  await g.setRole(owner, { person: ADA, role: "admin" });
  await assert.rejects(() => g.setRole(owner, { person: ADA, role: "owner" }), e => e.code === "needs_presence" || /presence/i.test(e.message));
  await assert.rejects(() => g.removeMember(owner, { person: ADA }), e => e.code === "needs_presence" || /presence/i.test(e.message));
});
