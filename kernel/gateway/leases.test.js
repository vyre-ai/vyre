import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };

/** A sealer whose lease.* behaves like vault's Leases (revocation memory, epoch) without the process, so the kernel's wiring is what is tested. */
function fakeSealer() {
  const st = { revoked: new Set(), live: new Map(), calls: [] };
  let n = 0;
  const one = c => { if (!c || c.hops.length !== 1 || c.hops[0].actor.kind !== "person") throw Object.assign(new Error("human_only"), { code: "human_only" }); };
  return { st, lease: {
    issue: async i => { one(i.chain); st.calls.push(["issue", i.device, i.allowed]); if (!i.allowed) { st.revoked.add(i.device); return { revoked: true }; } if (st.revoked.has(i.device)) return { revoked: true }; const id = `lease_${++n}`; st.live.set(id, i.device); return { id, key: "k", ttlMs: 3600000 }; },
    renew: async i => { one(i.chain); st.calls.push(["renew", i.id, i.allowed]); if (!i.allowed) { st.revoked.add(st.live.get(i.id)); st.live.delete(i.id); return { revoked: true }; } return { ttlMs: 3600000 }; },
    revoke: async i => { one(i.chain); st.calls.push(["revoke", i.device]); st.revoked.add(i.device); for (const [id, d] of st.live) if (d === i.device) st.live.delete(id); return { revoked: true }; },
    reinstate: async i => { st.calls.push(["reinstate", i.device]); st.revoked.delete(i.device); return { reinstated: true }; },
    check: async i => { if (!st.live.has(i.id)) throw Object.assign(new Error("no_lease"), { code: "no_lease" }); return { space: SPACE, device: st.live.get(i.id) }; },
  }, presenceCheck: presence.check };
}

async function rig() {
  const sealer = fakeSealer();
  const released = [];
  const k = createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence, resolveCredential: async i => { released.push(i); return { secret: "v" }; } });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const g = k.gateway.grants;
  const role = { person: BOB, role: "member" };
  await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  const mk = (chain, o) => g.offers.offer(chain, o, { presence: proof("grants.offer", o, `vyre://${SPACE}/offer/new`) });
  return { k, sealer, owner, bob, g, mk, released, un: (chain, id) => g.offers.unoffer(chain, id, { presence: proof("grants.offer", { revoke: id }, `vyre://${SPACE}/offer/${id}`) }) };
}

test("leases: `allowed` is the kernel's answer from the two Offers, on every issue and renew, never the caller's", async () => {
  const r = await rig();
  const L = r.k.gateway.leases;
  assert.deepEqual(await L.issue(r.bob, { device: "dev_laptop" }), { revoked: true }, "no Offer at all: refused, and the process is told allowed is false");
  assert.deepEqual(r.sealer.st.calls.at(-1), ["issue", "dev_laptop", false]);
  const r2 = await rig();
  await r2.mk(r2.owner, { side: "space_allows", member: BOB });
  assert.deepEqual((await r2.k.gateway.leases.issue(r2.bob, { device: "dev_laptop" })), { revoked: true }, "one side is not enough");
  const r3 = await rig();
  await r3.mk(r3.owner, { side: "space_allows", member: BOB });
  await r3.mk(r3.bob, { side: "member_accepts", member: BOB, device: "dev_laptop" });
  const lease = await r3.k.gateway.leases.issue(r3.bob, { device: "dev_laptop" });
  assert.ok(lease.id);
  assert.deepEqual(r3.sealer.st.calls.at(-1), ["issue", "dev_laptop", true]);
  assert.deepEqual(await r3.k.gateway.leases.renew(r3.bob, { id: lease.id }), { ttlMs: 3600000 });
  assert.equal(r3.sealer.st.calls.at(-1)[2], true);
  // another person's lease is unknown, an assistant's chain is refused
  const alice = r3.k.chains.fromFacts({ kind: "device", device_key_id: "d-a", person: "per_alice", path: "direct" });
  await assert.rejects(() => r3.k.gateway.leases.renew(alice, { id: lease.id }), { code: "unknown_lease" });
  const agent = r3.k.chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  await assert.rejects(() => r3.k.gateway.leases.issue(agent, { device: "dev_laptop" }), { code: "chain_not_person" });
});

test("leases: withdrawing either Offer, or removing the member, revokes the lease at once through the person whose act it was; reinstating is an admin's", async () => {
  const r = await rig();
  const allow = await r.mk(r.owner, { side: "space_allows", member: BOB });
  const accept = await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop" });
  const lease = await r.k.gateway.leases.issue(r.bob, { device: "dev_laptop" });
  assert.ok(r.sealer.st.live.has(lease.id));
  await r.un(r.bob, accept.id);
  await new Promise(res => setTimeout(res, 10));
  assert.ok(!r.sealer.st.live.has(lease.id), "the member withdrew: revoked in the process now, not at the next renewal");
  assert.ok(r.sealer.st.revoked.has("dev_laptop"));
  // nothing is issued again, even with both Offers back, until an admin reinstates
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop" });
  assert.deepEqual(await r.k.gateway.leases.issue(r.bob, { device: "dev_laptop" }), { revoked: true });
  await assert.rejects(() => r.k.gateway.leases.reinstate(r.bob, { device: "dev_laptop", proof: {} }), { code: "not_allowed" }, "a member does not reinstate");
  await r.k.gateway.leases.reinstate(r.owner, { device: "dev_laptop", proof: { sig: "admin" } });
  assert.ok((await r.k.gateway.leases.issue(r.bob, { device: "dev_laptop" })).id);
  // removing the member revokes whatever they hold
  const live = [...r.sealer.st.live.keys()][0];
  await r.k.gateway.grants.removeMember(r.owner, { person: BOB }, { presence: proof("grants.role", { remove: BOB }, `vyre://${SPACE}/member/${BOB}`) });
  await new Promise(res => setTimeout(res, 10));
  assert.ok(!r.sealer.st.live.has(live));
  assert.ok(allow);
});

test("leases: a credential is used by route only from a session with a live lease, per request, and the event carries no value", async () => {
  const r = await rig();
  await r.mk(r.owner, { side: "space_allows", member: BOB });
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop" });
  const gi = { subject: { kind: "actor", actor: { kind: "person", id: BOB, space: SPACE } }, actions: ["vault.read"], resource: { prefix: `vyre://${SPACE}/credential/*` }, conditions: {}, source: "test" };
  await r.g.create(r.owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) });
  const lease = await r.k.gateway.leases.issue(r.bob, { device: "dev_laptop" });
  const L = r.k.gateway.leases;
  await assert.rejects(() => L.use(r.bob, { ref: "gh", session: "s1", route: "api.github.com" }), { code: "no_lease" }, "no session bound to a lease");
  L.bind("s1", lease.id);
  const v = await L.use(r.bob, { ref: "gh", session: "s1", route: "api.github.com" });
  assert.deepEqual(v, { secret: "v" });
  assert.deepEqual(r.released, [{ space: SPACE, ref: "gh", route: "api.github.com" }]);
  const ev = r.k.log.read({ type: "vault.used" });
  assert.equal(ev.length, 1);
  assert.ok(!JSON.stringify(ev).includes("secret"));
  // after the lease is gone the session can no longer use it
  r.sealer.st.live.clear();
  await assert.rejects(() => L.use(r.bob, { ref: "gh", session: "s1", route: "api.github.com" }), { code: "no_lease" });
});
