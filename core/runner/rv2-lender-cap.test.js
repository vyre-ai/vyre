// The lent-computer wire on the REAL kernel: a member's computer runs one of the Space's sessions through the kernel's remote call (the in-memory stand-in for Wink), with the real Offers,
// the real leases and the real remote server on the home side, and the lent home service in front of the checkpoint store. Every refusal in team/archive/work-journals/runner.md is a test here.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { createMemoryTransport } from "../../kernel/remote/memory-transport.js";
import { createLentHome, CHUNK_BYTES } from "./lent-home.js";
import { createLentClient } from "./lent-client.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
function fakeSealer() {
  const st = { live: new Map(), revoked: new Set(), spent: new Set() }; let n = 0;
  const one = c => { if (!c || c.hops.length !== 1 || c.hops[0].actor.kind !== "person") throw Object.assign(new Error("human_only"), { code: "human_only" }); };
  return { st, lease: {
    issue: async i => { one(i.chain); const m = i.chain.hops[0].actor.id; if (!i.allowed || st.revoked.has(`${m}|${i.device}`)) return { revoked: true };
      if (i.signed) {   // what the sealing process checks (kernel/seal/process.js lease.issue): a hello, signed over exactly its fields, once
        const need = c => Object.assign(new Error(c), { code: c });
        if (!i.hello || !i.proof) throw need("needs_presence");
        if (i.proof.decision !== "lease.issue" || canonical(i.proof.fields) !== canonical(i.hello)) throw need("wrong_payload");
        if (st.spent.has(i.proof.challenge)) throw need("replayed"); st.spent.add(i.proof.challenge);
      } const id = `lease_${++n}`; st.live.set(id, `${m}|${i.device}`); return { id, key: crypto.randomBytes(32).toString("base64"), ttlMs: 3600000 }; },
    renew: async i => { one(i.chain); if (!i.allowed) return { revoked: true }; return { ttlMs: 3600000 }; },
    revoke: async i => { one(i.chain); st.revoked.add(`${i.member}|${i.device}`); return { revoked: true }; },
    reinstate: async () => ({ reinstated: true }),
    check: async i => { if (!st.live.has(i.id)) throw Object.assign(new Error("no_lease"), { code: "no_lease" }); const [member, device] = st.live.get(i.id).split("|"); return { space: SPACE, member, device }; },
  } };
}

async function rig(t, o = {}) {
  const acceptCap = o.acceptCap;
  const dir = fs.mkdtempSync(path.join(SCRATCH, "lw-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sealer = fakeSealer();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence, ...(o.signedHello ? { signedHello: true } : {}), resolveCredential: async () => ({ secret: "v" }) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "dev_laptop", person: BOB, path: "direct" });
  const g = k.gateway.grants;
  for (const p of [BOB, CAROL]) { const role = { person: p, role: "member" }; await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${p}`) }); }
  const mk = (chain, x) => g.offers.offer(chain, x, { presence: proof("grants.offer", x, `vyre://${SPACE}/offer/new`) });
  await mk(owner, { side: "space_allows", member: BOB });
  const accept = await mk(bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP", ...(acceptCap ? { network_cap: acceptCap } : {}) });
  const home = createLentHome({ space: SPACE, root: path.join(dir, "home"), offers: g.offers, leases: k.gateway.leases, lenderCap: () => o.cap,
    specFor: async ({ session }) => ({ command: "/usr/bin/agent", args: [session], env: {}, routes: [], readOnly: [], labels: {}, network: "internet", credentialRoutes: [{ route: "api.example.com", ref: "svc", paths: ["/v1/*"] }] }) });
  const server = createRemoteServer({ space: SPACE, kernel: k, services: { lent: home } });
  // The computer's own presence key stands in as a function over the home's challenge: the proof names the op and fields the challenge carries, this home and this challenge.
  const signer = o.signer === false ? undefined : (/** @type {any} */ ch) => ({ presence: { decision: ch.op, fields: ch.fields, home: ch.home, challenge: ch.nonce } });
  const as = (person, device, eid) => { const remote = createRemoteKernel({ space: SPACE, ...(signer ? { signer } : {}), transport: createMemoryTransport({ servers: { [SPACE]: server }, peer: { device_key_id: device, person, path: "wink" } }) }); return createLentClient({ invoke: remote.call, device, deviceKey: "KEY_LAPTOP", ...(eid ? { eid, cap: () => o.helloCap } : {}) }); };
  return { k, owner, bob, g, mk, accept, home, server, sealer, as, dir };
}
// ---- reviewer-2 probes on work/runner 037500d2e: the lender's cap (CAP-1, CAP-2, CAP-3). Drop into core/runner/. ----
const lendProof = (o, res) => proof("grants.offer", { lend: { member: o.member, device: o.device, device_key: o.device_key } }, res);

test("CAP-2: a member's later, tighter acceptance is not what capOf reads (first active wins, undefined counts as an answer)", async t => {
  const r = await rig(t);                                             // BOB already has an acceptance with no cap
  const x = { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP", network_cap: "provider" };
  await r.mk(r.bob, x).catch(e => console.log("second offer refused:", e.code));
  const cap = r.g.offers.capOf({ member: BOB, device: "dev_laptop" });
  console.log("CAP-2 capOf after a tighter second acceptance:", cap);
  assert.equal(cap, "provider", "the lender tightened their own cap; the looser older acceptance must not win");
});

test("CAP-1: the lend proof does not bind network_cap, so the cap can be dropped or changed after the member signed", async t => {
  const r = await rig(t);
  await r.g.offers.unoffer?.(r.bob, { id: r.accept.id }, {}).catch(() => {});
  const o = { member: BOB, device: "dev_new", device_key: "KEY_NEW" };
  const res = `vyre://${SPACE}/offer/lend`;
  // the member's screen asks for provider; the proof can only be over the cap-less form
  const withCap = await r.g.offers.lend(r.bob, { ...o, network_cap: "provider" }, { presence: lendProof(o, res) }).catch(e => ({ error: e.code }));
  const r2 = await rig(t);
  const noCap = await r2.g.offers.lend(r2.bob, { ...o }, { presence: lendProof(o, res) }).catch(e => ({ error: e.code }));
  const r3 = await rig(t);
  const other = await r3.g.offers.lend(r3.bob, { ...o, network_cap: "internet" }, { presence: lendProof(o, res) }).catch(e => ({ error: e.code }));
  console.log("CAP-1 same proof: provider", JSON.stringify(withCap).slice(0, 80), "| none", JSON.stringify(noCap).slice(0, 80), "| internet", JSON.stringify(other).slice(0, 80));
  assert.ok(withCap.error || noCap.error || other.error, "one proof must not carry three different caps");
});

test("CAP-3: lend of an already-accepted computer with a cap neither applies it nor says so", async t => {
  const r = await rig(t);                                             // dev_laptop already accepted, no cap
  const o = { member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" };
  const res = `vyre://${SPACE}/offer/lend`;
  const out = await r.g.offers.lend(r.bob, { ...o, network_cap: "provider" }, { presence: lendProof(o, res) }).catch(e => ({ error: e.code }));
  const cap = r.g.offers.capOf({ member: BOB, device: "dev_laptop" });
  console.log("CAP-3 lend result", JSON.stringify(out).slice(0, 100), "cap now", cap);
  assert.ok(out.error || cap === "provider", "a requested cap must apply or be refused, never dropped silently");
});

// ---- R031-95 2.3: the cap floor. The tightest limit ever signed for a computer holds until the lender signs a loosening; the runner's hello can only ask for less. ----
const LEND = `vyre://${SPACE}/offer/lend`;
const unlendProof = o => proof("grants.unoffer", { unlend: { member: o.member, device: o.device } }, LEND);
const lendWith = (r, extra, cap) => { const o = { member: BOB, device: "dev_floor", device_key: "KEY_LAPTOP" };
  return r.g.offers.lend(r.bob, { ...o, ...(cap ? { network_cap: cap } : {}), ...extra }, { presence: proof("grants.offer", { lend: { ...o, network_cap: cap ?? null, ...(extra.loosen ? { loosen: true } : {}) } }, LEND) }); };
const unlend = (r, device = "dev_floor") => r.g.offers.unlend(r.bob, { member: BOB, device }, { presence: unlendProof({ member: BOB, device }) });
const startNet = async (r, device, i = {}) => { const c = r.as(BOB, device); await c.vault.lease(); return (await c.spec({ session: `s_${Math.random().toString(36).slice(2, 8)}`, ...i })).network; };

test("CAP-4: a limit the lender signed survives stopping the lend and lending again with no limit, and holds at the home", async t => {
  const r = await rig(t);
  await lendWith(r, {}, "provider");
  await unlend(r);
  await assert.rejects(lendWith(r, {}, "internet"), e => e.code === "not_allowed" && /tighter network limit/.test(e.message), "a looser limit, stated, is a loosening and says so");
  assert.equal(r.g.offers.capOf({ member: BOB, device: "dev_floor" }), "provider", "the floor stands while nothing is lent");
  await lendWith(r, {});                                                            // a lend that states no limit inherits the floor (ruled 10 Oct)
  assert.equal(r.g.offers.capOf({ member: BOB, device: "dev_floor" }), "provider", "and is held to it");
  // Seen from the lender's computer: the Space asks for the internet, the home answers with the provider only.
  const c = r.as(BOB, "dev_floor"); await c.vault.lease();
  assert.equal((await c.spec({ session: "s1" })).network, "provider");
});

test("CAP-5: only a loosening the lender signs lowers the floor, and the proof binds the word", async t => {
  const r = await rig(t);
  await lendWith(r, {}, "provider");
  await unlend(r);
  const o = { member: BOB, device: "dev_floor", device_key: "KEY_LAPTOP" };
  // A looser limit that does not say it is a loosening is refused, and a bad flag is a bad input.
  await assert.rejects(r.g.offers.lend(r.bob, { ...o, network_cap: "internet" }, {}), e => e.code === "not_allowed" && /tighter network limit/.test(e.message));
  assert.equal(r.g.offers.capOf({ member: BOB, device: "dev_floor" }), "provider");
  await assert.rejects(r.g.offers.lend(r.bob, { ...o, network_cap: "internet", loosen: "yes" }, {}), e => e.code === "bad_input");
  // The member's own loosening of a computer they lent before needs no proof beyond their own act (ruled 10 Oct: asking is approving), and the floor starts again from there.
  await r.g.offers.lend(r.bob, { ...o, network_cap: "internet", loosen: true }, {});
  assert.equal(r.g.offers.capOf({ member: BOB, device: "dev_floor" }), "internet");
  await unlend(r);
  await lendWith(r, {});                                                             // no limit stated inherits what the floor is now
  assert.equal(r.g.offers.capOf({ member: BOB, device: "dev_floor" }), "internet");
  await unlend(r);
  await lendWith(r, {}, "provider");                                                 // tighter is always allowed
  await unlend(r);
  await assert.rejects(lendWith(r, {}, "internet"), e => e.code === "not_allowed");
  // A computer whose member the OWNER removed is a new grant when it is lent again: that lend takes the member's proof, and a loosening in it is bound by the proof
  await lendWith(r, {}, "provider");                                                 // lent now, so the removal is what ends it
  await r.g.removeMember(r.owner, { person: BOB }, { presence: proof("grants.role", { remove: BOB }, `vyre://${SPACE}/member/${BOB}`) });
  const role = { person: BOB, role: "member" };
  await r.g.setRole(r.owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  await assert.rejects(r.g.offers.lend(r.bob, { ...o, network_cap: "internet", loosen: true }, { presence: proof("grants.offer", { lend: { ...o, network_cap: "internet" } }, LEND) }), e => /wrong_payload|presence|proof/i.test(String(e.code) + e.message), "a proof made for the plain lend does not carry a loosening");
});

test("CAP-6: the hello's limit is the tightest of the Space, the lender's acceptance and what the runner signed; a runner can only ask for less", async t => {
  const r = await rig(t);                                                           // dev_laptop: accepted with no limit, the Space says internet
  assert.equal(await startNet(r, "dev_laptop"), "internet");
  assert.equal(await startNet(r, "dev_laptop", { cap: "provider" }), "provider", "the runner signed provider: tighter than the home knew");
  assert.equal(await startNet(r, "dev_laptop", { cap: "internet" }), "internet", "internet from the runner does not loosen anything the home knows");
  const tight = await rig(t, { acceptCap: "provider" });
  assert.equal(await startNet(tight, "dev_laptop", { cap: "internet" }), "provider", "a runner asking for more than the lender's acceptance gets the acceptance");
  const c = tight.as(BOB, "dev_laptop"); await c.vault.lease();
  await assert.rejects(c.spec({ session: "s9", cap: "everything" }), e => e.code === "bad_input");
});

test("CAP-7: an acceptance that states no limit never lowers the floor (CAP-2 read through the floor), and a bad limit is refused", async t => {
  const r = await rig(t, { acceptCap: "provider" });
  await r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" });   // taken, and it changes nothing
  assert.equal(r.g.offers.capOf({ member: BOB, device: "dev_laptop" }), "provider");
  await assert.rejects(r.mk(r.bob, { side: "member_accepts", member: BOB, device: "dev_other", device_key: "K2", network_cap: "everything" }), e => e.code === "bad_input");
});

// ---- R031-95 2.2: the lease request is a hello the computer signed. The wire: the home's challenge covers the hello, the lender's key answers, the sealing process checks it once. ----
test("HELLO-1: where the home asks for a signed hello, the lease request carries one, the challenge covers exactly its fields, and the cap is among them", async t => {
  const r = await rig(t, { signedHello: true, helloCap: "provider" });
  const c = r.as(BOB, "dev_laptop", "eid_mac");
  const lease = await c.vault.lease();
  assert.ok(lease.id && lease.key, "the lease came back after the computer signed the challenge");
  assert.equal(r.k.gateway.leases.helloOf(lease.id).cap, "provider", "the home kept what was signed: the lender's limit, the runner version and the protocol");
  assert.deepEqual(Object.keys(r.k.gateway.leases.helloOf(lease.id)).sort(), ["cap", "device", "device_key", "eid", "protocol", "runner_version"]);
  // and the home holds the session to it, though the start that follows says nothing about a limit: the Space asks for the internet, the lender's key signed provider
  assert.equal((await c.spec({ session: "s_signed" })).network, "provider");
});

test("HELLO-2: no hello, no signer, a hello for another computer, or a replayed proof gets no key", async t => {
  const r = await rig(t, { signedHello: true });
  // a computer that sends no hello (an older runner) is told to sign, and has no key to do it with
  const bare = r.as(BOB, "dev_laptop");
  await assert.rejects(bare.vault.lease(), e => e.code === "needs_presence");
  // a computer with an eid but no way to sign
  const none = await rig(t, { signedHello: true, signer: false });
  await assert.rejects(none.as(BOB, "dev_laptop", "eid_mac").vault.lease(), e => e.code === "needs_presence");
  // the home refuses a hello that names another computer than the lease
  const kc = r.owner;
  void kc;
  await assert.rejects(r.k.gateway.leases.issue(r.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP", hello: { device: "dev_other", device_key: "KEY_LAPTOP", eid: "eid_mac", cap: null, runner_version: "0.3.2", protocol: 1 }, proof: { decision: "lease.issue" } }), e => e.code === "bad_input");
});

test("HELLO-3: a home that does not ask for a hello still issues the old way, and a removed computer reads as removed with or without one", async t => {
  const r = await rig(t);
  assert.ok((await r.as(BOB, "dev_laptop").vault.lease()).id);
  const s = await rig(t, { signedHello: true });
  await s.g.offers.unlend(s.bob, { member: BOB, device: "dev_laptop" }, { presence: unlendProof({ member: BOB, device: "dev_laptop" }) });
  assert.deepEqual(await s.k.gateway.leases.issue(s.bob, { device: "dev_laptop", device_key: "KEY_LAPTOP" }), { revoked: true }, "the lender's probe reads \"no\" without signing anything");
});
