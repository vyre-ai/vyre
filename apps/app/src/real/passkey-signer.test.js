import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { authenticator } from "../identity/soft-authenticator.js";
import { createPasskeyKey } from "../identity/passkey.js";
import { signPresenceWithPasskey, presenceKeyId } from "./passkey-signer.js";
import { passkeyPresenceKey } from "../identity/passkey.js";
import { payloadHash, proofBytes, chainHash } from "../../modules/vyre-signer/presence-proof.js";
import { presenceKeyId as boxKeyId } from "../../../../lib/presence-key-id.js";

test("a passkey's yes is the kernel's proof shape: the assertion's challenge is SHA-256 of the proof's bytes, and it verifies under the passkey's own key", async () => {
  const auth = authenticator({ rp: "app.vyre.run" });
  const key = await createPasskeyKey({ rp: "app.vyre.run", webauthn: auth, random: (n) => crypto.randomBytes(n) });
  const fields = { ref: "seal_x", purpose: "p" };
  const card = { op: "seal.reveal", space: "spc_1", fields, payload_hash: payloadHash("seal.reveal", "spc_1", fields), person: "per_alex" };
  const proof = await signPresenceWithPasskey(card, { key, now: () => 2_000_000, nonce: () => "n0nce" });
  // the fields the sealing process checks
  assert.equal(proof.signer, "webauthn_platform");
  assert.equal(proof.decision, "seal.reveal");
  assert.equal(proof.payload_hash, card.payload_hash);
  assert.equal(proof.chain_hash, chainHash("per_alex", "spc_1"));
  assert.equal(proof.expires_at - proof.issued_at, 60_000);
  // the key id is the one the box derives from the SPKI the hello offered
  const spki = Buffer.from(passkeyPresenceKey(key.keep()).key, "base64url");
  assert.equal(proof.key_id, boxKeyId(spki));
  assert.equal(presenceKeyId(new Uint8Array(spki)), boxKeyId(spki));
  // the envelope: { ad, cd, s }; the challenge in clientDataJSON is SHA-256 of the proof's bytes, and the signature verifies over ad || SHA-256(cd)
  const env = JSON.parse(Buffer.from(proof.signature, "base64url").toString());
  const cd = Buffer.from(env.cd, "base64url"), ad = Buffer.from(env.ad, "base64url");
  assert.equal(JSON.parse(cd.toString()).challenge, crypto.createHash("sha256").update(proofBytes(proof)).digest("base64url"));
  const ok = crypto.verify("sha256", Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]), { key: crypto.createPublicKey({ key: spki, format: "der", type: "spki" }) }, Buffer.from(env.s, "base64url"));
  assert.equal(ok, true, "the assertion verifies under the passkey's public key");
});

test("a hash that does not match what the card shows is never signed, and a device with no passkey says so", async () => {
  const auth = authenticator({});
  const key = await createPasskeyKey({ rp: "app.vyre.run", webauthn: auth, random: (n) => crypto.randomBytes(n) });
  await assert.rejects(() => signPresenceWithPasskey({ op: "seal.reveal", space: "s", fields: { a: 1 }, payload_hash: "wrong", person: "per_a" }, { key }), (e) => e.code === "hash_mismatch");
  await assert.rejects(() => signPresenceWithPasskey({ op: "x", space: "s", fields: {}, payload_hash: payloadHash("x", "s", {}), person: "p" }, { key: { sign: async () => new Uint8Array(), keep: () => ({ kind: "seed" }) } }), (e) => e.code === "no_signer");
});
