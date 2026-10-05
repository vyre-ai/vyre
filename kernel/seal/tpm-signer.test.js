// A PC's TPM key (Windows Hello, P-256, signer `tpm`) is a known class, verified as P-256, but NOT admitted unattested on a release build until a prompt on every signature is shown on a real TPM computer
// (reviewer-3: a page script that can reach the key could mint a yes silently). A development build takes it like any unattested key.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Presence } from "./proof.js";
import { chainCtx } from "./wire.js";
import { person, signer } from "./testing.js";

const enrol = (p, k, ch) => { const e = k.enrolment; const { token } = p.begin({ person: e.person, key_id: e.key_id, spki: e.spki }); return p.enrol({ person: e.person, key_id: e.key_id, spki: e.spki, signer: e.signer, token, ctx: chainCtx(ch) }); };

test("release: a tpm key is refused as unattested, so a Windows PC is not the yes yet", () => {
  const p = new Presence(() => 5_000_000, { allowUnattested: false, allowSoftware: false }), ch = person("per_alex");
  assert.deepEqual(enrol(p, signer("per_alex", "tpm_k0", "tpm"), ch), { refused: "unattested" });
});

test("development: a tpm key enrols where unattested keys are taken, and its P-256 proof is a yes, once", () => {
  let now = 5_000_000;
  const p = new Presence(() => now, { allowUnattested: true }), ch = person("per_alex"), k = signer("per_alex", "tpm_k1", "tpm");
  assert.deepEqual(enrol(p, k, ch), { attested: false });
  const fields = { ref: "seal_x", purpose: "p" };
  const proof = k.proof(ch, "seal.reveal", fields, { issued: now });
  assert.equal(p.refuse(proof, { op: "seal.reveal", space: ch.space, fields, ctx: chainCtx(ch) }), null);
  assert.equal(p.refuse(proof, { op: "seal.reveal", space: ch.space, fields, ctx: chainCtx(ch) }), "replayed");
  const bad = k.proof(ch, "seal.reveal", fields, { issued: now, tamper: true });
  assert.equal(p.refuse(bad, { op: "seal.reveal", space: ch.space, fields, ctx: chainCtx(ch) }), "bad_signature");
});
