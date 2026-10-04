// @ts-check
// RC1, the invitee's first key: a person this sealing process has never met gets a presence key from an invite, on the evidence of their identity chain (verified here) and a listed, not-young device's
// signature over exactly this invite, this Space, this identity and this key. Every refusal leaves nothing enrolled.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { startSealer } from "./client.js";
import { joinBytes } from "./wire.js";
import { person, signer, tmp, SPACE } from "./testing.js";
import { makeGenesis, makeOp, verifyChain, eidOf, b64u } from "../identity/chain.js";

const code = p => p.then(() => null, e => e.code);
const edKey = async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32), eid = await eidOf(pub);
  return { eid, pub: b64u(pub), sign: m => crypto.sign(null, Buffer.from(m), privateKey), entry: kind => ({ eid, kind, pub: b64u(pub) }) };
};
/** A person's identity: first device D1 (the founder) and a recovery code key. Time runs from two days ago, so D1 is long past any newcomer window. */
async function identity() {
  const d1 = await edKey(), rc = await edKey(), t0 = Date.now() - 2 * 86_400_000;
  const ops = [await makeGenesis({ kind: "person", entry: d1.entry("device"), code: rc.entry("code"), nonce: "nonce-" + crypto.randomBytes(4).toString("hex"), ts: t0, sign: d1.sign })];
  const id = ops[0].id, add = async (by, body, ts) => { const st = await verifyChain(ops); ops.push(await makeOp(st, body, { by: by.eid, ts, sign: by.sign })); };
  return { id, ops, d1, rc, t0, add };
}
const INVITE = "inv_" + "a".repeat(32);
const bindFor = (who, id, sg, { invite = INVITE, space = SPACE } = {}) => ({ eid: who.eid, sig: b64u(who.sign(joinBytes(invite, space, id, sg.key_id, sg.enrolment.spki))) });
const args = (id, sg, ops, bind, extra = {}) => ({ chain: person(id), person: id, ops, bind, invite: INVITE, key_id: sg.key_id, spki: sg.enrolment.spki, signer: sg.enrolment.signer, ...extra });
async function start(t) {
  const dir = tmp("join"), s = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return s;
}
const reveal = async (s, id, sg) => {
  const ch = person(id), { ref } = await s.api.put({ chain: ch, record: "vyre://spc_testspace0001/contact/c_jane", field: "ssn", class: "us-ssn", value: "123-45-6789" });
  return s.api.reveal({ chain: ch, ref: ref.ref, purpose: "p", proof: sg.proof(ch, "seal.reveal", { ref: ref.ref, purpose: "p" }) });
};

test("join: a stranger's first key from their identity chain and a listed device's signature works at once, and is a newcomer for 24 hours", async t => {
  const s = await start(t), I = await identity(), sg = signer(I.id);
  const r = await s.join(args(I.id, sg, I.ops, bindFor(I.d1, I.id, sg)));
  assert.equal(r.joined, true);
  assert.equal(r.event.type, "presence.joined");
  assert.equal(r.event.newcomer_for_ms, 86_400_000);
  assert.equal((await reveal(s, I.id, sg)).value, "123-45-6789", "the key proves presence for this person");
});

test("join: each refusal names its reason and enrols nothing", async t => {
  const s = await start(t), I = await identity(), sg = signer(I.id);
  const stranger = await edKey(), other = await identity();
  const none = async why => { assert.equal(await code(reveal(s, I.id, sg)), "unknown_key", `${why}: nothing was enrolled`); };
  assert.equal(await code(s.join(args(I.id, sg, I.ops, bindFor(stranger, I.id, sg)))), "not_listed", "a device the list does not hold cannot vouch");
  await none("not_listed");
  const other_key = signer(I.id);
  assert.equal(await code(s.join(args(I.id, sg, I.ops, bindFor(I.d1, I.id, other_key)))), "bad_binding", "a signature is for exactly this key");
  assert.equal(await code(s.join(args(I.id, sg, I.ops, bindFor(I.d1, I.id, sg, { invite: "inv_" + "b".repeat(32) })))), "bad_binding", "a signature is for exactly this invite");
  assert.equal(await code(s.join(args(I.id, sg, I.ops, bindFor(I.d1, I.id, sg, { space: "spc_otherspace01" })))), "bad_binding", "a signature is for exactly this Space");
  assert.equal(await code(s.join(args(I.id, sg, I.ops, { eid: I.d1.eid }))), "bad_binding", "no signature");
  await none("bad_binding");
  // a device the list gained an hour ago is a newcomer: the founder's code adds it, and it cannot vouch
  const d2 = await edKey(); await I.add(I.rc, { type: "add", entry: d2.entry("device") }, Date.now() - 3600_000);
  assert.equal(await code(s.join(args(I.id, sg, I.ops, bindFor(d2, I.id, sg)))), "young_device");
  await none("young_device");
  // the chain of another person is no evidence for this one, and a caller who is not that person gets nothing
  assert.equal(await code(s.join(args(I.id, sg, other.ops, bindFor(I.d1, I.id, sg)))), "bad_chain");
  assert.equal(await code(s.join(args(I.id, sg, I.ops, bindFor(I.d1, I.id, sg), { chain: person(other.id) }))), "chain_not_person");
  await none("bad_chain");
  // after all of that, the right call still works: no refusal spent anything
  assert.equal((await s.join(args(I.id, sg, I.ops, bindFor(I.d1, I.id, sg)))).joined, true);
  // a second key for a person this process now knows is the ordinary enrolment (a proof from a key already enrolled), never a join
  const sg2 = signer(I.id);
  assert.equal(await code(s.join(args(I.id, sg2, I.ops, bindFor(I.d1, I.id, sg2)))), "known_person");
  assert.equal(await code(s.join(args(I.id, sg, I.ops, bindFor(I.d1, I.id, sg)))), "exists");
});

test("join: a software key is refused unless the process takes software keys, and an unknown signer name is not a signer", async t => {
  const s = await start(t), I = await identity(), sg = signer(I.id, undefined, "software");
  assert.equal(await code(s.join(args(I.id, sg, I.ops, bindFor(I.d1, I.id, sg)))), "software_refused");
  const bad = signer(I.id, undefined, "my_own_chip");
  assert.equal(await code(s.join(args(I.id, bad, I.ops, bindFor(I.d1, I.id, bad)))), "bad_signer");
});
