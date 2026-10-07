// @ts-check
// spaces: the createMembers-shaped face of the kernel, against a real kernel. Legacy codes, the one-proof ownership transfer that is safe to kill half way, and no stored copy.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../../kernel/index.js";
import { createEventLog } from "../../kernel/core/events.js";
import { payloadHash } from "../../kernel/seal/wire.js";
import { proofRequest } from "../../kernel/remote/proof.js";
import { createKernelMembers } from "./kernel-members-compat.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_" + "o".repeat(26), ALICE = "per_" + "a".repeat(26), BOB = "per_" + "b".repeat(26), CAT = "per_" + "c".repeat(26);
let T = 1_800_000_000_000;
const clock = () => ++T;
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, chain.space, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "bad_proof") };
const sign = (call, ...a) => ({ presence: { payload_hash: proofRequest(SPACE, call, ...a).payload_hash, nonce: Math.random().toString(36) } });

async function rig() {
  let killNext = false, sets = 0;
  const log = createEventLog({ space: SPACE, clock });
  const kernel = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), clock, presence, hasPresenceSession: () => true,
    log: { ...log, append: (/** @type {any} */ c, /** @type {any} */ e, /** @type {any[]} */ ...r) => { if (killNext && e.type === "member.set" && ++sets === 2) throw new Error("killed"); return log.append(c, e, ...r); } } });
  const m = createKernelMembers({ space: SPACE, handle: { space: SPACE, hosted: true, gateway: kernel.gateway }, now: clock });
  const chain = (/** @type {string} */ who) => (who === OWNER ? kernel.chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true }) : kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" }));
  const as = (/** @type {string} */ who, /** @type {string} */ call, /** @type {any[]} */ ...a) => ({ kernel: { chain: chain(who), proof: call ? sign(call, ...a) : {} } });
  return { m, as, chain, kill: () => { killNext = true; sets = 0; }, unkill: () => { killNext = false; } };
}
const code = (/** @type {Promise<any>} */ p) => p.then(() => "ok", e => e.code);

test("compat: the legacy call shape and the legacy codes, over the kernel's rules", async () => {
  const { m, as } = await rig();
  const mk = (/** @type {string} */ who, /** @type {string} */ role) => ({ person: who, role });
  const r = await m.addMember({ ...as(OWNER, "setRole", mk(ALICE, "admin")), person: ALICE, role: "admin" });
  assert.equal(r.membership.role, "admin");
  assert.equal(r.warnings[0].code, "single_owner");
  await m.addMember({ ...as(OWNER, "setRole", mk(BOB, "member")), person: BOB, role: "member" });
  assert.equal(await code(m.addMember({ ...as(OWNER, "setRole", mk(BOB, "member")), person: BOB, role: "member" })), "duplicate");
  assert.equal(await code(m.addMember({ kernel: as(OWNER, "setRole", mk(CAT, "member")).kernel, actor: { system: true, by: OWNER }, person: CAT, role: "member" })), "forbidden");
  assert.equal(await code(m.setRole({ ...as(ALICE, "setRole", mk(BOB, "owner")), person: BOB, role: "owner" })), "exceeds_role", "an admin cannot make an owner");
  assert.equal(await code(m.setRole({ ...as(BOB, "setRole", mk(ALICE, "member")), person: ALICE, role: "member" })), "not_a_member", "a member cannot see to change a person above them");
  assert.equal(await code(m.setRole({ ...as(OWNER, "setRole", mk(OWNER, "admin")), person: OWNER, role: "admin" })), "last_owner");
  assert.equal(await code(m.setRole({ kernel: { chain: as(OWNER).kernel.chain }, person: BOB, role: "owner" })), "needs_presence", "making an owner still asks for presence; a role below owner does not (user ruling 5 Oct)");
  assert.equal(await code(m.setRole({ ...as(OWNER, "setRole", { person: CAT, role: "temp" }), person: CAT, role: "temp" })), "bad_scope");
  // reads: a manager and above counts owners; a member gets null and no false warning
  assert.equal(await m.ownerCount({ chain: as(OWNER).kernel.chain }), 1);
  assert.equal(await m.ownerCount({ chain: as(BOB).kernel.chain }), null);
  assert.deepEqual(await m.warnings({ chain: as(BOB).kernel.chain }), []);
  assert.equal((await m.get(BOB, { chain: as(OWNER).kernel.chain })).role, "member");
  assert.equal(await m.get("per_nobody", { chain: as(OWNER).kernel.chain }), undefined);
  assert.ok((await m.abilitiesFor(BOB, { chain: as(OWNER).kernel.chain })).length > 0);
  const gone = await m.removeMember({ ...as(OWNER, "removeMember", { person: BOB }), person: BOB });
  assert.equal(gone.removed.person, BOB);
  assert.equal(await code(m.removeMember({ ...as(OWNER, "removeMember", { person: OWNER }), person: OWNER })), "last_owner");
  assert.equal(m.roleLabel("admin"), "Admin");
  assert.equal(m.setDisplayName({ role: "admin", name: "Partner" }).name, "Partner");
  assert.equal(await code(m.bootstrapOwner(OWNER)), "duplicate");
});

test("compat: transferOwnership is one proof, and a kill between its two steps leaves two owners and a retry finishes it", async () => {
  const { m, as, kill, unkill } = await rig();
  await m.addMember({ ...as(OWNER, "setRole", { person: ALICE, role: "member" }), person: ALICE, role: "member" });
  const call = () => ({ ...as(OWNER, "transferOwner", { to: ALICE }), to: ALICE });
  assert.equal(await code(m.transferOwnership({ kernel: { chain: as(OWNER).kernel.chain }, to: ALICE })), "needs_presence");
  kill();
  await assert.rejects(() => m.transferOwnership(call()), /killed/);
  unkill();
  const ownersNow = await m.list({ chain: as(ALICE).kernel.chain });
  assert.deepEqual(ownersNow.filter((/** @type {any} */ x) => x.role === "owner").map((/** @type {any} */ x) => x.person).sort(), [ALICE, OWNER].sort(), "two owners, never none");
  const done = await m.transferOwnership(call());
  assert.deepEqual([done.owner, done.previous, done.previous_role], [ALICE, OWNER, "admin"]);
  assert.equal((await m.ownerCount({ chain: as(ALICE).kernel.chain })), 1);
});
