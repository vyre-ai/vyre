// @ts-check
// spaces: roles, memberships and invites as calls on a real Space kernel (in memory): the module only translates, the kernel decides.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../../kernel/index.js";
import { payloadHash } from "../../kernel/seal/wire.js";
import { proofRequest } from "../../kernel/remote/proof.js";
import { kernelMembers } from "./kernel-members.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_" + "o".repeat(26), KIT = "per_" + "k".repeat(26), JUNO = "per_" + "j".repeat(26);
let T = 1_800_000_000_000;
const clock = () => ++T;
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, chain.space, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "bad_proof") };
const sign = (call, ...a) => ({ presence: { payload_hash: proofRequest(SPACE, call, ...a).payload_hash, nonce: Math.random().toString(36) } });

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), clock, presence, hasPresenceSession: () => true });
  const handle = { space: SPACE, hosted: true, gateway: k.gateway };
  const m = kernelMembers({ handle, now: clock });
  const ownerChain = () => k.chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const personChain = (/** @type {string} */ who) => k.chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
  const inviteeChain = (/** @type {string} */ who) => k.chains.fromFacts({ kind: "invitee", person: who, vouched: true });
  return { k, m, ownerChain, personChain, inviteeChain };
}

test("kernel members: an owner sets roles with a fresh proof; the kernel's refusals come back in plain words", async () => {
  const { m, ownerChain, personChain } = await rig();
  const k0 = { chain: ownerChain(), proof: {} };
  await assert.rejects(m.setRole(k0, { person: KIT, role: "member" }), e => e.code === "presence_required" && /approval/.test(e.message));
  const set = await m.setRole({ chain: ownerChain(), proof: sign("setRole", { person: KIT, role: "member" }) }, { person: KIT, role: "member" });
  assert.deepEqual([set.person, set.role, set.scope], [KIT, "member", null]);
  // a member cannot make anyone anything; a temp needs scope and an end date
  await assert.rejects(m.setRole({ chain: personChain(KIT), proof: sign("setRole", { person: JUNO, role: "member" }) }, { person: JUNO, role: "member" }), e => e.code === "not_found", "a member cannot make anyone anything: the kernel does not even say the act exists");
  await assert.rejects(m.setRole({ chain: ownerChain(), proof: sign("setRole", { person: JUNO, role: "temp" }) }, { person: JUNO, role: "temp" }), e => e.code === "bad_input");
  const until = T + 3 * 86_400_000;
  const temp = await m.setRole({ chain: ownerChain(), proof: sign("setRole", { person: JUNO, role: "temp", scope: [`vyre://${SPACE}/project/bakery`], expires: until }) }, { person: JUNO, role: "temp", scope: [`vyre://${SPACE}/project/bakery`], expires: until });
  assert.equal(temp.expires, until);
  assert.deepEqual((await m.list({ chain: ownerChain() })).map(x => x.role).sort(), ["member", "owner", "temp"]);
  // a member sees only themselves
  assert.deepEqual((await m.list({ chain: personChain(KIT) })).map(x => x.person), [KIT]);
});

test("kernel members: extend a temp member, remove a member, the last owner stays, and the sweep needs no person", async () => {
  const { m, ownerChain, k } = await rig();
  const scope = [`vyre://${SPACE}/project/bakery`], soon = T + 1000, later = T + 10 * 86_400_000;
  await m.setRole({ chain: ownerChain(), proof: sign("setRole", { person: JUNO, role: "temp", scope, expires: soon }) }, { person: JUNO, role: "temp", scope, expires: soon });
  const ext = await m.extendTemp({ chain: ownerChain(), proof: sign("setRole", { person: JUNO, role: "temp", scope, expires: later }) }, { person: JUNO, expires: later });
  assert.equal(ext.expires, later);
  await m.setRole({ chain: ownerChain(), proof: sign("setRole", { person: KIT, role: "member" }) }, { person: KIT, role: "member" });
  await assert.rejects(m.extendTemp({ chain: ownerChain(), proof: {} }, { person: KIT, expires: later }), e => e.code === "bad_scope");
  await m.removeMember({ chain: ownerChain(), proof: sign("removeMember", { person: KIT }) }, KIT);
  await assert.rejects(m.get({ chain: ownerChain() }, KIT), e => e.code === "not_found");
  await assert.rejects(m.removeMember({ chain: ownerChain(), proof: sign("removeMember", { person: OWNER }) }, OWNER), e => e.code === "forbidden");
  // time passes: the kernel's own sweep removes the expired temp member
  for (let i = 0; i < 20; i++) clock();
  T += 11 * 86_400_000;
  await m.sweep();
  assert.ok(!(await m.list({ chain: ownerChain() })).some(x => x.person === JUNO));
  void k;
});

test("kernel members: an invite goes through the kernel: the admin creates it with a proof, the invitee accepts what they were shown with their own", async () => {
  const { m, ownerChain, inviteeChain } = await rig();
  const made = await m.invites.create({ chain: ownerChain(), proof: sign("inviteCreate", { role: "member", invitee: KIT }) }, { role: "member", invitee: KIT });
  assert.match(made.id, /^inv_[0-9a-f]{32}$/);
  assert.equal(made.needs_confirm, false);
  // the join card: from the kernel, for the person it is for
  const card = await m.invites.get({ chain: inviteeChain(KIT) }, made.id);
  assert.deepEqual([card.role, card.status, card.invitee], ["member", "pending", KIT]);
  await assert.rejects(m.invites.get({ chain: inviteeChain(JUNO) }, made.id), e => e.code === "not_found", "someone else cannot read it");
  // accept without the person's presence, with different contents, then properly
  await assert.rejects(m.invites.accept({ chain: inviteeChain(KIT), proof: {} }, made.id, { role: "member", scope: null, expires: null, invitee: KIT }), e => e.code === "presence_required");
  const proofReq = { presence: { payload_hash: payloadHash("grant.accept", SPACE, { invite: made.id, hash: made.hash, person: KIT }), nonce: "n-accept" } };
  await assert.rejects(m.invites.accept({ chain: inviteeChain(KIT), proof: proofReq }, made.id, { role: "admin", scope: null, expires: null, invitee: KIT }), e => e.code === "contents_differ");
  const joined = await m.invites.accept({ chain: inviteeChain(KIT), proof: proofReq }, made.id, { role: "member", scope: null, expires: null, invitee: KIT });
  assert.equal(joined.membership.role, "member");
  await assert.rejects(m.invites.accept({ chain: inviteeChain(KIT), proof: { presence: { ...proofReq.presence, nonce: "n2" } } }, made.id, { role: "member", scope: null, expires: null, invitee: KIT }), e => e.code === "not_found", "single use");
  // an admin invite waits for the inviter to confirm the invitee's words
  const admin = await m.invites.create({ chain: ownerChain(), proof: sign("inviteCreate", { role: "admin" }) }, { role: "admin" });
  assert.equal(admin.needs_confirm, true);
});

test("invites.revoke and invites.list go to the kernel when it offers them, and say plainly when it does not", async () => {
  const seen = [];
  const grants = { invites: { revoke: async (chain, id, proof) => { seen.push(["revoke", id]); return { id, status: "revoked" }; }, list: async chain => { seen.push(["list"]); return [{ id: "inv_a", role: "member" }]; } } };
  const m = kernelMembers({ handle: { space: "spc_x", hosted: true, gateway: { grants } } });
  const k = { chain: { hops: [{ actor: { kind: "person", id: "per_x" } }] }, proof: {} };
  assert.deepEqual(await m.invites.revoke(k, "inv_a"), { id: "inv_a", status: "revoked" });
  assert.deepEqual((await m.invites.list(k)).map(x => x.id), ["inv_a"]);
  const old = kernelMembers({ handle: { space: "spc_x", hosted: true, gateway: { grants: { invites: {} } } } });
  await assert.rejects(old.invites.revoke(k, "inv_a"), e => e.code === "unavailable" && /cannot cancel/.test(e.message));
  await assert.rejects(old.invites.list(k), e => e.code === "unavailable");
});
