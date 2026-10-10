// The kernel's lease wiring against the REAL sealing process (kernel/gateway/leases.test.js uses a fake process that imitates it). What is still a stand-in is labelled:
//   SHIM(presence): the kernel's own grants and offers acts use the allow-all presence stand-in the other gateway tests use (a real one needs a hardware proof per act);
//   the lease reinstatement below DOES use a real hardware-signed proof, checked by the real process.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { startSealer } from "../seal/client.js";
import { signer, enrolDevice, tmp } from "../seal/testing.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const code = p => p.then(() => null, e => e.code);

async function rig(t) {
  const dir = tmp("leasereal"), sealer = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await sealer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "dev_laptop", person: BOB, path: "direct" });   // the computer asks for its own lease (lease B): the transport proves the device the request names
  const g = k.gateway.grants, role = { person: BOB, role: "member" };
  await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  const mk = (chain, o) => g.offers.offer(chain, o, { presence: proof("grants.offer", o, `vyre://${SPACE}/offer/new`) });
  const un = (chain, id) => g.offers.unoffer(chain, id, { presence: proof("grants.unoffer", { revoke: id }, `vyre://${SPACE}/offer/${id}`) });
  const both = async () => { await mk(owner, { side: "space_allows", member: BOB }); return mk(bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" }); };
  return { k, sealer, owner, bob, g, mk, un, both, L: k.gateway.leases, live: (chain, id) => sealer.lease.check({ chain, id }).then(() => true, () => false) };
}

test("real process: allowed is the kernel's answer from the two Offers, on every issue and renew; a refused issue revokes nothing; another person's lease is unknown", async t => {
  const r = await rig(t);
  assert.deepEqual(await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }), { revoked: true }, "no Offer: refused");
  await r.mk(r.owner, { side: "space_allows", member: BOB });
  assert.deepEqual(await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }), { revoked: true }, "one side is not enough");
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  const lease = await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }); assert.ok(lease.id && Buffer.from(lease.key, "base64").length === 32, "both sides: a key, though two refusals came first");
  assert.deepEqual(await r.L.renew(r.bob, { id: lease.id }), { ttlMs: 3600000 });
  const alice = r.k.chains.fromFacts({ kind: "device", device_key_id: "d-a", person: "per_alice", path: "direct" });
  assert.equal(await code(r.L.renew(alice, { id: lease.id })), "unknown_lease");
  const agent = r.k.chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  assert.equal(await code(r.L.issue(agent, { device: "dev_laptop", device_key: "KEY_LAPTOP" })), "chain_not_person");
  const again = await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }); assert.equal(again.key, lease.key, "the same member and device get the same key while access holds");
});

test("real process: withdrawing an Offer revokes the lease in the process at once, nothing is issued again until an admin reinstates with a real hardware proof, and the key then differs", async t => {
  const r = await rig(t), accept = await r.both(), lease = await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" });
  assert.equal(await r.live(r.bob, lease.id), true);
  await r.un(r.bob, accept.id); await new Promise(res => setTimeout(res, 50));
  assert.equal(await r.live(r.bob, lease.id), false, "revoked in the process now, not at the next renewal");
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  assert.deepEqual(await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }), { revoked: true }, "both Offers are back and still nothing is issued");
  assert.equal(await code(r.L.reinstate(r.bob, { member: BOB, device: "dev_laptop", proof: {} })), "not_allowed", "a member does not reinstate");
  // The owner reinstates with a proof the real process checks: an enrolled hardware key, over exactly this member and device, for this chain.
  const ownerKey = signer(OWNER); await enrolDevice(r.sealer, ownerKey);
  const bad = await code(r.L.reinstate(r.owner, { member: BOB, device: "dev_laptop", proof: ownerKey.proof(r.owner, "lease.reinstate", { member: BOB, device: "another" }) }));
  assert.ok(bad, "a proof over another device is refused: " + bad);
  await r.L.reinstate(r.owner, { member: BOB, device: "dev_laptop", proof: ownerKey.proof(r.owner, "lease.reinstate", { member: BOB, device: "dev_laptop" }) });
  const next = await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }); assert.ok(next.id); assert.notEqual(next.key, lease.key, "a key copied before the revoke opens nothing now");
  // removing the member revokes whatever they hold
  await r.g.removeMember(r.owner, { person: BOB }, { presence: proof("grants.role", { remove: BOB }, `vyre://${SPACE}/member/${BOB}`) }); await new Promise(res => setTimeout(res, 50));
  assert.equal(await r.live(r.bob, next.id), false);
});

test("real process, L-5: another member naming the same device id cannot refuse-and-revoke, revoke or reinstate this member's lease", async t => {
  const r = await rig(t); await r.both(); const lease = await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" });
  const carol = r.k.chains.fromFacts({ kind: "device", device_key_id: "dev_laptop", person: "per_carol", path: "direct" }), role = { person: "per_carol", role: "member" };
  await r.g.setRole(r.owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/per_carol`) });
  assert.deepEqual(await r.L.issue(carol, { device: "dev_laptop" }), { revoked: true });
  assert.equal(await r.live(r.bob, lease.id), true, "a refused issue revoked nothing");
  assert.equal(await code(r.L.revoke(carol, { member: BOB, device: "dev_laptop" })), "not_allowed"); assert.equal(await r.live(r.bob, lease.id), true);
  assert.equal(await code(r.L.reinstate(carol, { member: BOB, device: "dev_laptop", proof: {} })), "not_allowed");
  await r.L.revoke(r.bob, { member: BOB, device: "dev_laptop" }); assert.equal(await r.live(r.bob, lease.id), false, "bob himself may");
});

test("real process: a computer whose member was removed from the Space entirely, lent again, is reinstated by an admin's yes and then runs: the old key opens nothing, and without the reinstate it still does not", async t => {
  const r = await rig(t), accept = await r.both(), lease = await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" });
  assert.equal(await r.live(r.bob, lease.id), true);
  // the member is removed from the Space: everything they held ends at once
  await r.g.removeMember(r.owner, { person: BOB }, { presence: proof("grants.role", { remove: BOB }, `vyre://${SPACE}/member/${BOB}`) }); await new Promise(res => setTimeout(res, 50));
  assert.equal(await r.live(r.bob, lease.id), false);
  void accept;
  // the Space takes them back and the computer is lent again (both Offers made new)
  const role = { person: BOB, role: "member" };
  await r.g.setRole(r.owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  await r.both();
  assert.deepEqual(await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }), { revoked: true }, "lent again, and still no lease: the removal stands until it is reinstated");
  // an admin's yes (a hardware proof the real process checks, over this member and this computer) reinstates it
  const ownerKey = signer(OWNER); await enrolDevice(r.sealer, ownerKey);
  await r.L.reinstate(r.owner, { member: BOB, device: "dev_laptop", proof: ownerKey.proof(r.owner, "lease.reinstate", { member: BOB, device: "dev_laptop" }) });
  const next = await r.L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" });
  assert.ok(next.id, "a working lease after the reinstate");
  assert.notEqual(next.key, lease.key, "the key from before the removal opens nothing now");
  assert.equal(await r.live(r.bob, next.id), true);
  assert.equal(await r.live(r.bob, lease.id), false);
});
