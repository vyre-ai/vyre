// A PC's TPM key (Windows Hello, P-256, signer `tpm`) says yes the way a phone's chip key does: enrolled on a release build with no attestation to check, marked unattested, and its ECDSA proof (raw or DER) is verified
// with the same P-256 check; a software key stays refused there.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Presence } from "./proof.js";
import { chainCtx } from "./wire.js";
import { person, signer } from "./testing.js";

function release() {
  let now = 5_000_000;
  const p = new Presence(() => now, { allowUnattested: false, allowSoftware: false }); // a release build
  return { p, now: () => now };
}
const enrol = (p, k, ch) => { const e = k.enrolment; const { token } = p.begin({ person: e.person, key_id: e.key_id, spki: e.spki }); return p.enrol({ person: e.person, key_id: e.key_id, spki: e.spki, signer: e.signer, token, ctx: chainCtx(ch) }); };

test("a tpm key is enrolled on a release build and its P-256 proof is a yes, once, marked unattested", () => {
  const { p, now } = release(), ch = person("per_alex"), k = signer("per_alex", "tpm_k1", "tpm");
  assert.deepEqual(enrol(p, k, ch), { attested: false });
  const fields = { ref: "seal_x", purpose: "p" };
  const proof = k.proof(ch, "seal.reveal", fields, { issued: now() });
  assert.equal(p.refuse(proof, { op: "seal.reveal", space: ch.space, fields, ctx: chainCtx(ch) }), null);
  assert.equal(p.lastStrength, "unattested");
  assert.equal(p.refuse(proof, { op: "seal.reveal", space: ch.space, fields, ctx: chainCtx(ch) }), "replayed", "once");
});

test("a tpm proof for another act, a tampered signature and another person's chain are refused; a software key is still refused on release", () => {
  const { p, now } = release(), ch = person("per_alex"), k = signer("per_alex", "tpm_k2", "tpm");
  enrol(p, k, ch);
  const fields = { ref: "seal_x", purpose: "p" };
  const ok = (proof, op = "seal.reveal", chain = ch, f = fields) => p.refuse(proof, { op, space: chain.space, fields: f, ctx: chainCtx(chain) });
  assert.equal(ok(k.proof(ch, "seal.reveal", fields, { issued: now() }), "vault.reveal"), "wrong_decision");
  assert.equal(ok(k.proof(ch, "seal.reveal", fields, { issued: now(), tamper: true })), "bad_signature");
  assert.equal(ok(k.proof(ch, "seal.reveal", fields, { issued: now() }), "seal.reveal", person("per_bob")), "unknown_key");
  const soft = signer("per_alex", "sw_k1", "software");
  const { token } = p.begin({ person: "per_alex", key_id: soft.key_id, spki: soft.enrolment.spki });
  assert.deepEqual(p.enrol({ person: "per_alex", key_id: soft.key_id, spki: soft.enrolment.spki, signer: "software", token, ctx: chainCtx(ch) }), { refused: "software_refused" });
});
