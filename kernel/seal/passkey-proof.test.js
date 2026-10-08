// A passkey says yes (the one yes for a browser-only person): its proof is a WebAuthn assertion over the same proofBytes a phone's chip key signs, checked by the identity chain's own verifier
// (kernel/identity/chain.js verifyWebAuthn) and admitted on a release build, where a software key is not.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Presence } from "./proof.js";
import { chainCtx, payloadHash, proofBytes } from "./wire.js";
import { person } from "./testing.js";
import { authenticator } from "../../apps/app/src/identity/soft-authenticator.js";
import { lowSDer } from "../../apps/app/src/identity/passkey.js";

const b64u = b => Buffer.from(b).toString("base64url");

/** A proof for `op` signed by the software passkey: the assertion's challenge is SHA-256 of the proof's own bytes. */
async function passkeyProof(auth, key_id, ch, op, fields, { issued, life = 60_000, nonce = crypto.randomBytes(8).toString("base64url") } = {}) {
  const p = { signer: "webauthn_platform", key_id, payload_hash: payloadHash(op, ch.space, fields), decision: op, chain_hash: chainCtx(ch).chain_hash, issued_at: issued, expires_at: issued + life, nonce };
  const got = await auth.get({ publicKey: { challenge: new Uint8Array(crypto.createHash("sha256").update(proofBytes(p)).digest()), rpId: auth.rp, allowCredentials: [{ type: "public-key", id: auth.credentialId }], userVerification: "required" } });
  const env = Buffer.from(JSON.stringify({ ad: b64u(got.response.authenticatorData), cd: b64u(got.response.clientDataJSON), s: b64u(lowSDer(new Uint8Array(got.response.signature))) }));
  return { ...p, signature: b64u(env) };
}

async function enrolled(rp = "app.vyre.run") {
  let now = 2_000_000;
  const p = new Presence(() => now, { allowUnattested: false, allowSoftware: false }); // a release build: no software key, no unattested chip key
  const auth = authenticator({ rp }), key_id = "pk_" + crypto.randomBytes(4).toString("hex"), ch = person("per_alex");
  const { token } = p.begin({ person: "per_alex", key_id, spki: auth.spki });
  const r = p.enrol({ person: "per_alex", key_id, spki: auth.spki, signer: "webauthn_platform", rp, token, ctx: chainCtx(ch) });
  return { p, auth, key_id, ch, r, now: () => now, tick: ms => { now += ms; } };
}
const ask = (p, proof, ch, op, fields) => p.refuse(proof, { op, space: ch.space, fields, ctx: chainCtx(ch) });

test("a passkey is enrolled on a release build and its assertion is a yes, once, for exactly the act it was asked for", async () => {
  const { p, auth, key_id, ch, r, now } = await enrolled();
  assert.deepEqual(r, { attested: false }, "admitted on release: a software key would be refused, a passkey is a platform authenticator");
  const fields = { ref: "seal_x", purpose: "p" };
  const proof = await passkeyProof(auth, key_id, ch, "seal.reveal", fields, { issued: now() });
  assert.equal(ask(p, proof, ch, "seal.reveal", fields), "bad_signature", "an assertion nobody checked first is no proof");
  await p.preverify({ proof });
  assert.equal(ask(p, proof, ch, "seal.reveal", fields), null, "the passkey's assertion says yes");
  assert.equal(ask(p, proof, ch, "seal.reveal", fields), "replayed", "once");
  assert.equal(p.lastStrength, "unattested", "marked as the kind of key it is, never hardware or attested");
});

test("a passkey's yes is refused for another act, another person's chain, a changed proof, another site, a clone of the checked object, and a missing user verification", async () => {
  const { p, auth, key_id, ch, now } = await enrolled();
  const fields = { ref: "seal_x", purpose: "p" };
  const proof = await passkeyProof(auth, key_id, ch, "seal.reveal", fields, { issued: now() });
  await p.preverify({ proof });
  assert.equal(ask(p, proof, ch, "vault.reveal", fields), "wrong_decision", "another act");
  assert.equal(ask(p, proof, ch, "seal.reveal", { ref: "seal_y", purpose: "p" }), "wrong_payload", "other fields");
  assert.equal(ask(p, { ...proof }, ch, "seal.reveal", fields), "bad_signature", "a copy of a checked proof is not the checked proof (identity, not content)");
  const bob = person("per_bob");
  assert.equal(ask(p, proof, bob, "seal.reveal", fields), "unknown_key", "another person");
  // a tampered envelope, a signature for other bytes, and a passkey made for another site never pass the verifier
  const other = await passkeyProof(auth, key_id, ch, "seal.reveal", fields, { issued: now() });
  const tampered = { ...other, nonce: "different" }; // the assertion's challenge covered the other bytes
  await p.preverify({ tampered });
  assert.equal(ask(p, tampered, ch, "seal.reveal", fields), "bad_signature");
  // a key enrolled for app.vyre.run whose authenticator answers for another site: the rp hash and the origin do not match what the box holds
  const evil = authenticator({ rp: "evil.example" }), kE = "pk_evil", pE = new Presence(() => 4_000_000, {});
  const tk = pE.begin({ person: "per_alex", key_id: kE, spki: evil.spki });
  assert.deepEqual(pE.enrol({ person: "per_alex", key_id: kE, spki: evil.spki, signer: "webauthn_platform", rp: "app.vyre.run", token: tk.token, ctx: chainCtx(ch) }), { attested: false });
  const lie = await passkeyProof(evil, kE, ch, "seal.reveal", fields, { issued: 4_000_000 });
  await pE.preverify({ lie });
  assert.equal(ask(pE, lie, ch, "seal.reveal", fields), "bad_signature", "an assertion for another site");
  // user not verified: the authenticator's flags without UV
  const noUv = authenticator({});
  const k3 = "pk_nouv", p3 = new Presence(() => 3_000_000, {});
  const { token } = p3.begin({ person: "per_alex", key_id: k3, spki: noUv.spki });
  assert.deepEqual(p3.enrol({ person: "per_alex", key_id: k3, spki: noUv.spki, signer: "webauthn_platform", rp: "app.vyre.run", token, ctx: chainCtx(ch) }), { attested: false });
  const orig = noUv.get.bind(noUv);
  noUv.get = async o => { const r = await orig(o); const ad = Buffer.from(r.response.authenticatorData); ad[32] = 0x01; return { response: { ...r.response, authenticatorData: new Uint8Array(ad) } }; };
  const nv = await passkeyProof(noUv, k3, ch, "seal.reveal", fields, { issued: 3_000_000 });
  await p3.preverify({ nv });
  assert.equal(ask(p3, nv, ch, "seal.reveal", fields), "bad_signature", "no user verification, no yes");
});

test("a passkey needs its site name to enrol", async () => {
  const p = new Presence(() => 1, {}), auth = authenticator({}), ch = person("per_alex");
  const { token } = p.begin({ person: "per_alex", key_id: "pk_x", spki: auth.spki });
  assert.deepEqual(p.enrol({ person: "per_alex", key_id: "pk_x", spki: auth.spki, signer: "webauthn_platform", token, ctx: chainCtx(ch) }), { refused: "bad_rp" });
});
