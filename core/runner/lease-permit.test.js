// @ts-check
// R031-95 2.2 (ruled 10 Oct): the member's lend is the permit for a computer's lease. No card, no prompt, no key on the computer: the home checks that both Offers stand for exactly this computer, takes the tightest of
// what the computer says and what the lender allowed, and writes every request on the log. This drives the PRODUCTION path: a real vyred on the lender's computer (its remote kernel to the Space's home), a real home with a
// real sealing process, the kernel's own Offers; nothing signs and nothing is stubbed on the way.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { createKernel } from "../../kernel/index.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { startSealer } from "../../kernel/seal/client.js";
import { tmp } from "../../kernel/seal/testing.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { createLentClient } from "./lent-client.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", DEVICE = "dev_mac";
const grantProof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const stubPresence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };

/** The Space's home: a real sealing process, the member Bob, and the lend of his Mac (the Space allows it, Bob accepts it, with the limit he chose). */
async function home(/** @type {any} */ t, /** @type {{ cap?: "provider" | "internet" }} */ o = {}) {
  const dir = tmp("lease-permit"), sealer = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await sealer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence: stubPresence, resolveCredential: async () => ({ secret: "v" }) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants, role = { person: BOB, role: "member" };
  await g.setRole(owner, role, { presence: grantProof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  const offer = (/** @type {any} */ c, /** @type {any} */ x) => g.offers.offer(c, x, { presence: grantProof("grants.offer", x, `vyre://${SPACE}/offer/new`) });
  await offer(owner, { side: "space_allows", member: BOB });
  const bobMac = k.chains.fromFacts({ kind: "device", device_key_id: DEVICE, person: BOB, path: "direct" });
  const accepted = await offer(bobMac, { side: "member_accepts", member: BOB, device: DEVICE, device_key: DEVICE, ...(o.cap ? { network_cap: o.cap } : {}) });
  const server = createRemoteServer({ space: SPACE, kernel: k, services: {} });
  /** The wire from a computer the transport has proved as `device`. */
  const sessionAs = (/** @type {string} */ device) => async () => ({ call: async (/** @type {string} */ _tool, /** @type {any} */ input) => JSON.parse(JSON.stringify(await server.serve(JSON.parse(JSON.stringify(input)), { device_key_id: device, person: BOB, path: "wink" }))) });
  const unlend = () => g.offers.unoffer(bobMac, accepted.id, { presence: grantProof("grants.unoffer", { revoke: accepted.id }, `vyre://${SPACE}/offer/${accepted.id}`) });
  const removeBob = () => g.removeMember(owner, { person: BOB }, { presence: grantProof("grants.role", { remove: BOB }, `vyre://${SPACE}/member/${BOB}`) });
  return { k, g, owner, sessionAs, unlend, removeBob, events: (/** @type {string} */ type) => k.log.read({ type }).map((/** @type {any} */ e) => e.data) };
}

/** A vyred on a computer whose home for the Space is that server, and a lent client on it that says it is `device` and claims `cap`. */
async function lender(/** @type {any} */ t, /** @type {any} */ h, /** @type {{ device?: string, cap?: "provider" | "internet" }} */ o = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "mac", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const device = o.device || DEVICE;
  const d = await start({ root, kernel: true, sessionFor: h.sessionAs(device), log: () => {} });
  t.after(() => d.stop());
  d.registry.deps.db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`server-hosted/${SPACE}`, JSON.stringify({ device: "srv_home0000000001" }));
  const remote = d.kernel.spaces.for(SPACE);
  return { d, remote, client: createLentClient({ invoke: remote.call, device: o.device ? DEVICE : DEVICE, deviceKey: DEVICE, cap: () => o.cap }) };
}

/** A renewal that gives nothing: the home says the lease is revoked, has forgotten it, or no longer knows the member. */
const refusedRenewal = async (/** @type {any} */ client, /** @type {string} */ id) => { const r = await client.vault.renew({ id }).catch((/** @type {any} */ e) => ({ error: e.code })); return !(r.ttlMs > 0); };

test("the lend is the permit: a computer gets its lease with no card, no prompt and no key of its own, and the request is on the home's log", { timeout: 180_000 }, async t => {
  const h = await home(t), { d, client } = await lender(t, h);
  const leased = await client.vault.lease();
  assert.equal(Buffer.from(leased.key, "base64").length, 32);
  assert.deepEqual((await d.registry.call("approvals.pending", {}, "deck")).data.approvals, [], "nothing waits on this computer for a yes");
  assert.equal((await d.registry.call("approvals.lease-ask", {}, "module:runner")).error.code, "no_such_tool", "the lease card is gone");
  const [ev] = h.events("lease.issued");
  assert.deepEqual([ev.member, ev.device, ev.limit], [BOB, DEVICE, null], "the owner can see each borrow: who, which computer, what limit");
  assert.equal((await client.vault.renew({ id: leased.id })).ttlMs > 0, true);
});

test("a computer asks for its own lease: another computer of the member naming it gets nothing, and one that was never lent is told no", { timeout: 180_000 }, async t => {
  const h = await home(t);
  // the member's other computer (or their phone) claims the lent Mac's id
  const imposter = await lender(t, h, { device: "dev_other" });
  await assert.rejects(imposter.client.vault.lease(), (/** @type {any} */ e) => e.code === "not_allowed");
  assert.equal(h.events("lease.issued").length, 0, "no key was handed out");
  assert.deepEqual(h.events("lease.refused").map((/** @type {any} */ x) => x.why), ["another_computer"]);
  // a computer nobody lent asks in its own name: no Offer, no key
  const stranger = await lender(t, h, { device: "dev_other" });
  const own = createLentClient({ invoke: stranger.remote.call, device: "dev_other", deviceKey: "dev_other" });
  assert.deepEqual(await own.vault.lease().catch((/** @type {any} */ e) => ({ error: e.code })), { revoked: true });
});

test("after unlend, a revoke or a removal the next request gets no key, and a lease already held is not renewed", { timeout: 180_000 }, async t => {
  for (const how of ["unlend", "removeBob"]) {
    const h = await home(t), { client } = await lender(t, h);
    const leased = await client.vault.lease();
    assert.ok((await client.vault.renew({ id: leased.id })).ttlMs > 0);
    await h[how]();
    assert.ok(await refusedRenewal(client, leased.id), `${how}: the lease is not renewed`);
    const again = await client.vault.lease().catch((/** @type {any} */ e) => ({ error: e.code }));
    assert.ok(!again.key, `${how}: and a new one is refused (${JSON.stringify(again)})`);
  }
  // the member (or an owner) revoking the computer's lease ends it the same way
  const h = await home(t), { client } = await lender(t, h);
  const leased = await client.vault.lease();
  await h.k.gateway.leases.revoke(h.k.chains.fromFacts({ kind: "device", device_key_id: DEVICE, person: BOB, path: "direct" }), { member: BOB, device: DEVICE });
  assert.ok(await refusedRenewal(client, leased.id));
});

test("what the computer says about itself can only tighten: a looser claim is clamped, the floor stands, and the log says the limit that holds", { timeout: 180_000 }, async t => {
  // the member accepted `provider`; the computer claims `internet`
  const h = await home(t, { cap: "provider" }), { client } = await lender(t, h, { cap: "internet" });
  const leased = await client.vault.lease();
  assert.equal(h.events("lease.issued")[0].limit, "provider", "the looser claim is not honoured");
  assert.equal(h.k.gateway.leases.helloOf(leased.id).cap, "internet", "what it claimed is kept as a claim");
  // a tighter claim wins over a looser acceptance
  const g2 = await home(t, { cap: "internet" }), c2 = await lender(t, g2, { cap: "provider" });
  await c2.client.vault.lease();
  assert.equal(g2.events("lease.issued")[0].limit, "provider");
  // no limit stated anywhere: none, and still on the log
  const g3 = await home(t), c3 = await lender(t, g3);
  await c3.client.vault.lease();
  assert.equal(g3.events("lease.issued")[0].limit, null);
});
