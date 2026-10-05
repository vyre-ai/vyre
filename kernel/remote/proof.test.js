import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { proofRequest, proofFrom, PROOF_CALLS } from "./proof.js";
import { createKernel } from "../index.js";
import { payloadHash } from "../seal/wire.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
let T = 1_800_000_000_000;
const clock = () => ++T;

/** A verifier with the sealing process's contract: the proof must be over exactly the payload hash of (op, space, fields), once. */
async function rig() {
  const used = new Set();
  const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, SPACE, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "bad_proof") };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), clock, presence });
  const owner = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  /** What a surface does: build the request, sign it, send it beside the request. */
  const signed = (call, ...args) => ({ kernel_proof: { payload_hash: proofRequest(SPACE, call, ...args).payload_hash, nonce: Math.random().toString(36) } });
  return { k, owner, signed, g: k.gateway.grants };
}

test("proof pass-through: a proof a surface signed from proofRequest is the one the kernel accepts, for every grants call", async () => {
  const { owner, signed, g } = await rig();
  const m = { person: BOB, role: "member" };
  await g.setRole(owner, m, proofFrom(signed("setRole", m)));
  const i = { subject: { kind: "actor", actor: { kind: "person", id: BOB, space: SPACE } }, actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/contact/*` }, conditions: {}, source: "t" };
  const made = await g.create(owner, i, proofFrom(signed("create", i)));
  const patch = { actions: ["records.read"] };
  await g.narrow(owner, made.id, patch, proofFrom(signed("narrow", made.id, patch)));
  await g.revoke(owner, made.id, "done", proofFrom(signed("revoke", made.id, "done")));
  const a = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, a, proofFrom(signed("addActor", a)));
  const inv = { role: "member" };
  const card = await g.invites.create(owner, inv, proofFrom(signed("inviteCreate", inv)));
  assert.ok(card.id);
  const o = { side: "space_allows", member: BOB };
  const off = await g.offers.offer(owner, o, proofFrom(signed("offer", o)));
  await g.offers.unoffer(owner, off.id, proofFrom(signed("unoffer", off.id)));
  const l = { member: OWNER, device: "dev_x", device_key: "KEY_X" }, u = { member: OWNER, device: "dev_x" };
  await g.offers.lend(owner, l, proofFrom(signed("lend", l)));
  await g.offers.unlend(owner, u, proofFrom(signed("unlend", u)));
  await g.removeMember(owner, { person: BOB }, proofFrom(signed("removeMember", { person: BOB })));
  const rr = { kind: "never", binds: ["assistants"], covers: { actions: ["records.remove"] }, label: "No deletes" };
  const rule = await g.rules.set(owner, rr, proofFrom(signed("ruleSet", rr)));
  assert.equal((await g.rules.disable(owner, rule.id, proofFrom(signed("ruleDisable", rule.id)))).status, "disabled");
  assert.equal((await g.rules.enable(owner, rule.id, proofFrom(signed("ruleEnable", rule.id)))).status, "active");
  assert.deepEqual([...PROOF_CALLS].sort(), ["addActor", "create", "inviteConfirm", "inviteCreate", "lend", "moveOut", "narrow", "offer", "removeActor", "removeMember", "revoke", "ruleAccept", "ruleDisable", "ruleDismiss", "ruleEnable", "ruleRemove", "ruleSet", "setRole", "transferOwner", "unlend", "unoffer"]);
});

test("proof pass-through: a proof for other input, a used proof, and a legacy or malformed one are refused by the kernel's verifier", async () => {
  const { owner, signed, g } = await rig();
  const m = { person: BOB, role: "owner" }; // a role below owner needs no proof now; making an owner still does
  const p = signed("setRole", m);
  await assert.rejects(() => g.setRole(owner, { person: "per_carol", role: "owner" }, proofFrom(p)), { code: "needs_presence" }, "bound to the exact input");
  await g.setRole(owner, m, proofFrom(p));
  await assert.rejects(() => g.setRole(owner, m, proofFrom(p)), { code: "needs_presence" }, "once");
  await assert.rejects(() => g.setRole(owner, m, proofFrom({ proof: p.kernel_proof })), { code: "needs_presence" }, "the legacy meta.proof is not a kernel proof");
  assert.deepEqual(proofFrom({ kernel_proof: "x" }), {});
  assert.deepEqual(proofFrom({ kernel_proof: [1] }), {});
  assert.deepEqual(proofFrom({ kernel_proof: { blob: "x".repeat(5000) } }), {});
  assert.deepEqual(proofFrom(null), {});
  assert.throws(() => proofRequest(SPACE, "records.read"), { code: "bad_input" });
  assert.throws(() => proofRequest(SPACE, "constructor"), { code: "bad_input" });
});

test("join card: the Space's name and fingerprint words come from the module that holds the Space's identity, set after the kernel starts", async () => {
  const { k, owner, signed, g } = await rig();
  const inv = { role: "member" };
  const card = await g.invites.create(owner, inv, (({ kernel_proof }) => ({ presence: kernel_proof }))(signed("inviteCreate", inv)));
  const stranger = await k.chains.fromFacts({ kind: "invitee", person: "per_stranger", vouched: true });
  assert.deepEqual((await g.invites.get(stranger, card.id)).space, { id: SPACE });
  k.setLabel(() => ({ name: "Harlow Legal", words: "amber river stone lamp" }));
  assert.deepEqual((await g.invites.get(stranger, card.id)).space, { id: SPACE, name: "Harlow Legal", words: "amber river stone lamp" });
});
