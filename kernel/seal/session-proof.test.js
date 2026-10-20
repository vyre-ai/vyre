// The `session` signer class (v0.6.5, password only): a proof signed by the person's own identity key from their opened master record, checked like every other proof, taken only while the server's
// `presence` setting is silent. No enrolment: the list pinned by the last sync is the evidence.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Presence } from "./proof.js";
import { chainCtx, payloadHash, proofBytes } from "./wire.js";
import { person } from "./testing.js";
import { makeGenesis, eidOf, b64u } from "../identity/chain.js";

const edKey = async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32), eid = await eidOf(pub);
  return { eid, sign: m => crypto.sign(null, Buffer.from(m), privateKey), entry: kind => ({ eid, kind, pub: b64u(pub) }) };
};
async function world({ sessionOk = true } = {}) {
  const d1 = await edKey(), rc = await edKey(), t0 = Date.now() - 2 * 86_400_000;
  const ops = [await makeGenesis({ kind: "person", entry: d1.entry("device"), code: rc.entry("code"), nonce: "nonce-" + crypto.randomBytes(4).toString("hex"), ts: t0, sign: d1.sign })];
  const id = ops[0].id, ch = person(id);
  const now = Date.now();
  const p = new Presence(() => now, { allowUnattested: false, allowSoftware: false, sessionOk });
  assert.equal((await p.sync({ person: id, ops, ctx: chainCtx(ch) })).pinned, 0);
  const proof = (key, op, fields, o = {}) => {
    const body = { signer: "session", key_id: key.eid, payload_hash: payloadHash(op, ch.space, fields), decision: op, chain_hash: chainCtx(ch).chain_hash, issued_at: now, expires_at: now + 60_000, nonce: crypto.randomBytes(8).toString("base64url"), ...o };
    return { ...body, signature: b64u(key.sign(proofBytes(body))) };
  };
  const ask = (pr, op, fields, c = ch) => p.refuse(pr, { op, space: c.space, fields, ctx: chainCtx(c) });
  return { p, d1, id, ch, proof, ask };
}

test("a session proof from the person's listed device key is a yes, once, for exactly the act it names, and is marked session", async () => {
  const { p, d1, proof, ask } = await world();
  const fields = { ref: "seal_x", purpose: "p" };
  const pr = proof(d1, "seal.reveal", fields);
  assert.equal(ask(pr, "seal.reveal", fields), null);
  assert.equal([p.lastMethod, p.lastStrength].join(), "session,session");
  assert.equal(ask(pr, "seal.reveal", fields), "replayed", "once");
  assert.equal(ask(proof(d1, "seal.reveal", fields), "vault.reveal", fields), "wrong_decision", "another act");
  assert.equal(ask(proof(d1, "seal.reveal", fields), "seal.reveal", { ref: "seal_y", purpose: "p" }), "wrong_payload", "other fields");
  assert.equal(ask(proof(d1, "seal.reveal", fields, { issued_at: Date.now() - 600_000, expires_at: Date.now() - 500_000 }), "seal.reveal", fields), "expired");
});

test("a session proof is refused for a key that is not the person's listed device, another person's chain, a bad signature, and while presence is prompt", async () => {
  const { d1, proof, ask, ch } = await world();
  const fields = { ref: "seal_x", purpose: "p" };
  const stranger = await edKey();
  assert.equal(ask(proof(stranger, "seal.reveal", fields), "seal.reveal", fields), "unknown_key", "a key the list does not hold");
  assert.equal(ask(proof(d1, "seal.reveal", fields), "seal.reveal", fields, person("per_bob")), "unknown_key", "another person's chain");
  const forged = { ...proof(d1, "seal.reveal", fields) }; forged.signature = b64u(stranger.sign(proofBytes(forged)));
  assert.equal(ask(forged, "seal.reveal", fields), "bad_signature", "signed by another key");
  const off = await world({ sessionOk: false });
  assert.equal(off.ask(off.proof(off.d1, "seal.reveal", fields), "seal.reveal", fields), "session_refused", "presence is prompt: hardware only");
  void ch;
});
