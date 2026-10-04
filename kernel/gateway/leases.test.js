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
  const slot = (m, d) => `${m}|${d}`;
  let n = 0;
  const one = c => { if (!c || c.hops.length !== 1 || c.hops[0].actor.kind !== "person") throw Object.assign(new Error("human_only"), { code: "human_only" }); };
  return { st, lease: {
    issue: async i => { one(i.chain); const m = i.chain.hops[0].actor.id; st.calls.push(["issue", i.device, i.allowed]); if (!i.allowed) return { revoked: true }; if (st.revoked.has(slot(m, i.device))) return { revoked: true }; const id = `lease_${++n}`; st.live.set(id, slot(m, i.device)); return { id, key: "k", ttlMs: 3600000 }; },
    renew: async i => { one(i.chain); st.calls.push(["renew", i.id, i.allowed]); if (!i.allowed) { st.revoked.add(st.live.get(i.id)); st.live.delete(i.id); return { revoked: true }; } return { ttlMs: 3600000 }; },
    revoke: async i => { one(i.chain); st.calls.push(["revoke", i.member, i.device]); st.revoked.add(slot(i.member, i.device)); for (const [id, d] of st.live) if (d === slot(i.member, i.device)) st.live.delete(id); return { revoked: true }; },
    reinstate: async i => { st.calls.push(["reinstate", i.member, i.device]); st.revoked.delete(slot(i.member, i.device)); return { reinstated: true }; },
    check: async i => { if (!st.live.has(i.id)) throw Object.assign(new Error("no_lease"), { code: "no_lease" }); const [member, device] = st.live.get(i.id).split("|"); return { space: SPACE, member, device }; },
  }, presenceCheck: presence.check };
}

/** A Drive with just what a forwarded file touches: one file under clients/, and writes recorded. */
const fakeDrive = () => ({ wrote: [], stat: (p, { version = null } = {}) => ({ path: p, version: version || 1, size: 4, sha256: "ab" }), stream: async function* () { yield Buffer.from("data"); },
  async putStream(p, src, o) { let n = 0; for await (const c of src) n += c.length; this.wrote.push([p, o]); return { version: 1, size: n, sha256: "cd" }; } });

async function rig() {
  const sealer = fakeSealer();
  const released = [], forwarded = [];
  const drive = fakeDrive();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence, drive, resolveCredential: async i => { released.push(i); return { secret: "v" }; }, forwardCredential: async q => { forwarded.push(q); return { status: 200, ok: true, headers: {}, body: "e30=" }; } });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const g = k.gateway.grants;
  const role = { person: BOB, role: "member" };
  await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  const mk = (chain, o) => g.offers.offer(chain, o, { presence: proof("grants.offer", o, `vyre://${SPACE}/offer/new`) });
  return { k, sealer, owner, bob, g, mk, released, forwarded, drive, un: (chain, id) => g.offers.unoffer(chain, id, { presence: proof("grants.offer", { revoke: id }, `vyre://${SPACE}/offer/${id}`) }) };
}

test("leases: `allowed` is the kernel's answer from the two Offers, on every issue and renew, never the caller's", async () => {
  const r = await rig();
  const L = r.k.gateway.leases;
  assert.deepEqual(await L.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }), { revoked: true }, "no Offer at all: refused, and the process is told allowed is false");
  assert.deepEqual(r.sealer.st.calls.at(-1), ["issue", "dev_laptop", false]);
  const r2 = await rig();
  await r2.mk(r2.owner, { side: "space_allows", member: BOB });
  assert.deepEqual((await r2.k.gateway.leases.issue(r2.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" })), { revoked: true }, "one side is not enough");
  const r3 = await rig();
  await r3.mk(r3.owner, { side: "space_allows", member: BOB });
  await r3.mk(r3.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  const lease = await r3.k.gateway.leases.issue(r3.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" });
  assert.ok(lease.id);
  assert.deepEqual(r3.sealer.st.calls.at(-1), ["issue", "dev_laptop", true]);
  assert.deepEqual(await r3.k.gateway.leases.renew(r3.bob, { id: lease.id }), { ttlMs: 3600000 });
  assert.equal(r3.sealer.st.calls.at(-1)[2], true);
  // another person's lease is unknown, an assistant's chain is refused
  const alice = r3.k.chains.fromFacts({ kind: "device", device_key_id: "d-a", person: "per_alice", path: "direct" });
  await assert.rejects(() => r3.k.gateway.leases.renew(alice, { id: lease.id }), { code: "unknown_lease" });
  const agent = r3.k.chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  await assert.rejects(() => r3.k.gateway.leases.issue(agent, { device: "dev_laptop", device_key: "KEY_LAPTOP" }), { code: "chain_not_person" });
});

test("leases: withdrawing either Offer, or removing the member, revokes the lease at once through the person whose act it was; reinstating is an admin's", async () => {
  const r = await rig();
  const allow = await r.mk(r.owner, { side: "space_allows", member: BOB });
  const accept = await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  const lease = await r.k.gateway.leases.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" });
  assert.ok(r.sealer.st.live.has(lease.id));
  await r.un(r.bob, accept.id);
  await new Promise(res => setTimeout(res, 10));
  assert.ok(!r.sealer.st.live.has(lease.id), "the member withdrew: revoked in the process now, not at the next renewal");
  assert.ok(r.sealer.st.revoked.has(`${BOB}|dev_laptop`));
  // nothing is issued again, even with both Offers back, until an admin reinstates
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  assert.deepEqual(await r.k.gateway.leases.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }), { revoked: true });
  await assert.rejects(() => r.k.gateway.leases.reinstate(r.bob, { member: BOB, device: "dev_laptop", proof: {} }), { code: "not_allowed" }, "a member does not reinstate");
  await r.k.gateway.leases.reinstate(r.owner, { member: BOB, device: "dev_laptop", proof: { sig: "admin" } });
  assert.ok((await r.k.gateway.leases.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" })).id);
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
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  const gi = { subject: { kind: "actor", actor: { kind: "person", id: BOB, space: SPACE } }, actions: ["vault.read"], resource: { prefix: `vyre://${SPACE}/credential/*` }, conditions: {}, source: "test" };
  await r.g.create(r.owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) });
  const lease = await r.k.gateway.leases.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" });
  const L = r.k.gateway.leases;
  const req = { session: "s1", route: "api.github.com", method: "GET", path: "/repos/x/y" };
  await assert.rejects(() => L.use(r.bob, req), { code: "not_found" }, "no definition bound");
  L.bind("s1", lease.id, { routes: [{ route: "api.github.com", ref: "gh", paths: ["/repos/*"] }] });
  const v = await L.use(r.bob, req);
  assert.deepEqual(v, { secret: "v" });
  assert.deepEqual(r.released, [{ space: SPACE, ref: "gh", route: "api.github.com", method: "GET", path: "/repos/x/y" }]);
  const ev = r.k.log.read({ type: "vault.used" });
  assert.equal(ev.length, 1);
  assert.ok(!JSON.stringify(ev).includes("secret"));
  // F-1: the runner cannot name a credential, however many it may read; only what the session's definition maps for this host, method and path is released
  r.released.length = 0;
  assert.deepEqual(await L.use(r.bob, { ...req, ref: "other" }), { secret: "v" }, "a ref the runner sends is ignored");
  assert.equal(r.released[0].ref, "gh");
  for (const bad of [{ route: "evil.example" }, { path: "/user/keys" }, { path: "/repos/../user" }, { path: "/repos/%2e%2e/user" }, { path: "repos/x" }, { method: "HEAD", path: "/other" }, { session: "s2" }]) {
    await assert.rejects(() => L.use(r.bob, { ...req, ...bad }), { code: "not_found" }, JSON.stringify(bad));
  }
  assert.equal(r.released.length, 1, "nothing mapped nothing released");
  // a write method is an outward call, not a read: even where the definition names it, the outward check asks and nothing is released
  L.bind("s1", lease.id, { routes: [{ route: "api.github.com", ref: "gh", methods: ["GET", "POST"], paths: ["/repos/*"] }] });
  r.released.length = 0;
  await assert.rejects(() => L.use(r.bob, { ...req, method: "POST", path: "/repos/x/refunds" }), e => typeof e.code === "string");
  assert.equal(r.released.length, 0, "a POST was not released on a read grant");
  // after the lease is gone the session can no longer use it
  r.sealer.st.live.clear();
  await assert.rejects(() => L.use(r.bob, req), { code: "no_lease" });
});

test("L-5: another member naming the same device id cannot revoke, refuse-and-revoke or reinstate this member's lease", async () => {
  const r = await rig();
  await r.mk(r.owner, { side: "space_allows", member: BOB });
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  const lease = await r.k.gateway.leases.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" });
  const carol = r.k.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: "per_carol", path: "direct" });
  const g = r.g, role = { person: "per_carol", role: "member" };
  await g.setRole(r.owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/per_carol`) });
  // carol, who holds no offers, asks for a lease on bob's device id: refused, and bob's lease is untouched
  assert.deepEqual(await r.k.gateway.leases.issue(carol, { device: "dev_laptop" }), { revoked: true });
  assert.ok(r.sealer.st.live.has(lease.id), "a refused issue revoked nothing");
  await assert.rejects(() => r.k.gateway.leases.revoke(carol, { member: BOB, device: "dev_laptop" }), { code: "not_allowed" });
  assert.ok(r.sealer.st.live.has(lease.id));
  // bob himself, or an admin, may
  await r.k.gateway.leases.revoke(r.bob, { member: BOB, device: "dev_laptop" });
  assert.ok(!r.sealer.st.live.has(lease.id));
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" }).catch(() => {});
});

import { runnerPorts } from "./runner-ports.js";
test("runnerPorts: the runner's lease, access answer and revocation are the kernel's, bound to this computer's key", async () => {
  const r = await rig();
  const ports = runnerPorts({ leases: r.k.gateway.leases, offers: r.k.gateway.grants.offers }, { chain: () => r.bob, member: BOB, deviceId: () => "dev_laptop", deviceKey: () => "KEY_LAPTOP" });
  assert.deepEqual(ports.grants(), { spaceAllows: false, memberAccepts: false });
  assert.deepEqual(await ports.vault.lease({ space: SPACE }), { revoked: true }, "no Offers: no key");
  await r.mk(r.owner, { side: "space_allows", member: BOB });
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });
  assert.deepEqual(ports.grants(), { spaceAllows: true, memberAccepts: true });
  const lease = await ports.vault.lease({ space: SPACE });
  assert.ok(lease.id);
  assert.deepEqual(await ports.vault.renew({ id: lease.id }), { ttlMs: 3600000 });
  // told at once, only for this computer
  const told = [];
  ports.onRevoke(e => told.push(e.reason));
  const acceptId = await findAccept(r);
  await r.k.gateway.grants.offers.unoffer(r.bob, acceptId, { presence: proof("grants.offer", { revoke: acceptId }, `vyre://${SPACE}/offer/${acceptId}`) });
  await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(told, ["withdrawn"]);
  // the runner never says `allowed` and never builds a chain
  assert.throws(() => runnerPorts({ leases: null, offers: r.k.gateway.grants.offers }, { chain: () => r.bob, member: BOB, deviceId: () => "d", deviceKey: () => "k" }), { code: "unavailable" });
  assert.throws(() => runnerPorts({ leases: r.k.gateway.leases, offers: r.k.gateway.grants.offers }, { chain: () => r.bob, member: BOB, deviceId: () => "", deviceKey: () => "k" }), { code: "bad_input" });
});
async function findAccept(r) { const l = r.k.log.read({ type: "offer.created" }).map(e => e.data.offer).find(o => o.side === "member_accepts"); return l.id; }


test("leases.forward: authorized for the caller's chain against the route before the vault is asked; the credential comes from the Space's session definition; a change asks; a file needs the caller's own drive right", async () => {
  const r = await rig();
  const { bob, owner, g, forwarded } = r;
  const L = r.k.gateway.leases;
  const grant = async actions => { const gi = { subject: { kind: "actor", actor: { kind: "person", id: BOB, space: SPACE } }, actions, resource: { prefix: `vyre://${SPACE}/${actions[0].startsWith("drive") ? "file" : "service"}/*` }, conditions: {}, source: "test" }; await g.create(owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) }); };
  L.bind("s1", "lease1", { routes: [{ route: "api.stripe.com", ref: "stripe_key", connector: "stripe", methods: ["GET", "POST"], paths: ["/v1/*"] }] });
  const req = { session: "s1", route: "api.stripe.com", method: "GET", path: "/v1/charges" };
  await assert.rejects(() => L.forward(bob, req), { code: "not_found" }, "no service grant: absent");
  assert.equal(forwarded.length, 0, "the vault was never asked");
  await grant(["service.read", "service.call"]);
  const ok = await L.forward(bob, { ...req, ref: "other_key", connector: "evil" });
  assert.equal(ok.status, 200);
  assert.equal(forwarded[0].ref, "stripe_key", "the credential is the session definition's, never the caller's");
  assert.equal(forwarded[0].connector, "stripe");
  const held = await L.forward(bob, { ...req, method: "POST", path: "/v1/refunds" });
  assert.equal(held.held, true, "a change is an outward act: it asks first");
  assert.equal(forwarded.length, 1, "and nothing was sent");
  for (const bad of [{ route: "evil.example" }, { path: "/v2/x" }, { path: "/v1/../v2" }, { method: "DELETE", path: "/v1/x" }, { session: "s2" }]) await assert.rejects(() => L.forward(bob, { ...req, ...bad }), { code: "not_found" }, JSON.stringify(bad));
  // a connector form (a Flow's "Call a service")
  assert.equal((await L.forward(bob, { connector: "stripe", method: "GET", path: "/v1/balance" })).status, 200);
  assert.equal(forwarded.at(-1).connector, "stripe");
  // a file the request reads or saves must be the caller's own drive right
  await assert.rejects(() => L.forward(bob, { ...req, upload: { drive: { path: "clients/a.pdf" } } }), { code: "not_found" }, "no drive.read");
  await assert.rejects(() => L.forward(bob, { ...req, saveTo: "inbox/out.json" }), { code: "not_found" }, "no drive.write");
  await grant(["drive.read", "drive.write"]);
  assert.equal((await L.forward(bob, { ...req, upload: { drive: { path: "clients/a.pdf" } }, saveTo: "inbox/out.json" })).status, 200);
});

const gmake = (r, actions, conditions, prefix) => { const gi = { subject: { kind: "actor", actor: { kind: "person", id: BOB, space: SPACE } }, actions, resource: { prefix: `vyre://${SPACE}/${prefix}/*` }, conditions, source: "test" }; return r.g.create(r.owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) }); };
test("LF-1: leases.forward counts a grant's rate, budget and once through the same enforcement as every gated act; a refused request counts nothing", async () => {
  const r = await rig();
  const { bob, owner, g, forwarded } = r;
  const L = r.k.gateway.leases;
  const grant = (actions, conditions, prefix = "service") => gmake(r, actions, conditions, prefix);
  L.bind("s1", "lease1", { routes: [{ route: "api.stripe.com", ref: "stripe_key", connector: "stripe", methods: ["GET"], paths: ["/v1/*"] }] });
  const req = { session: "s1", route: "api.stripe.com", method: "GET", path: "/v1/charges" };
  await grant(["service.read"], { rate: { n: 2, per_seconds: 3600 } });
  assert.equal((await L.forward(bob, req)).status, 200);
  assert.equal((await L.forward(bob, req)).status, 200);
  await assert.rejects(() => L.forward(bob, req), { code: "rate_limited" }, "the third call in the window is refused");
  assert.equal(forwarded.length, 2, "and the vault was not asked");
  // a request refused for a Drive file counts nothing on the service grant
  const r2 = await rig();
  const L2 = r2.k.gateway.leases;
  L2.bind("s1", "lease1", { routes: [{ route: "api.stripe.com", ref: "stripe_key", connector: "stripe", methods: ["GET"], paths: ["/v1/*"], drive: { read: ["clients/*"] } }] });
  await gmake(r2, ["service.read"], { once: true }, "service");
  await assert.rejects(() => L2.forward(r2.bob, { ...req, upload: { drive: { path: "clients/a.pdf" } } }), { code: "not_found" }, "no drive.read grant");
  assert.equal((await L2.forward(r2.bob, req)).status, 200, "the once grant was not spent by the refused request");
  await assert.rejects(() => L2.forward(r2.bob, req), { code: "used_up" });
});

test("LF-3: leases.bind keeps the route record whole (deny wins, size cap, content types, Drive lists, header names) and forward carries it to the vault, with the Drive as the caller's own door", async () => {
  const r = await rig();
  const { bob, owner, g, forwarded, drive } = r;
  const L = r.k.gateway.leases;
  const grant = (actions, prefix) => gmake(r, actions, {}, prefix);
  await grant(["service.read", "service.call"], "service");
  L.bind("s1", "lease1", { routes: [{ route: "api.drive.test", ref: "k", connector: "docs", allow: [{ method: "GET", path: "/files/*" }, { method: "POST", path: "/upload" }], deny: [{ path: "/files/secret/*" }], maxBytes: 1000, contentTypes: ["application/pdf"], drive: { read: ["clients/*"], write: ["inbox/*"] }, headers: ["X-Goog-Upload-Protocol"] }] });
  const req = { session: "s1", route: "api.drive.test", method: "GET", path: "/files/a" };
  await assert.rejects(() => L.forward(bob, { ...req, path: "/files/secret/b" }), { code: "not_found" }, "a deny entry wins over an allow");
  await L.forward(bob, req);
  assert.deepEqual(forwarded.at(-1).allow_headers, ["x-goog-upload-protocol"], "the route's header names go with the request");
  await grant(["drive.read"], "file/clients"); await grant(["drive.write"], "file/inbox");
  await L.forward(bob, { ...req, upload: { drive: { path: "clients/a.pdf", contentType: "application/pdf" } }, saveTo: "inbox/out.json" });
  const f = forwarded.at(-1);
  assert.equal(f.file, true);
  assert.deepEqual(f.limits, { maxBytes: 1000, contentTypes: ["application/pdf"] });
  assert.deepEqual(f.drive, { read: ["clients/*"], write: ["inbox/*"] });
  assert.equal(typeof f.files.read, "function", "the Drive door under the caller's chain");
  assert.equal((await f.files.read("clients/a.pdf")).size, 4);
  await assert.rejects(() => f.files.read("elsewhere/x"), { code: "not_found" }, "the caller's own grant decides outside the route lists too");
  await f.files.write("inbox/out.json", (async function* () { yield Buffer.from("xy"); })(), { maxBytes: 10 });
  assert.equal(drive.wrote[0][0], "inbox/out.json");
});
