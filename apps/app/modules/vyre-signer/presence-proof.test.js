import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonical as kc, payloadHash as kp, proofBytes as kb } from "../../../../kernel/seal/wire.js";
import { canonical, payloadHash, chainHash, proofBytes, spkiFromXY, p1363FromDer, proofBody, keyIdOf, b64, b64url, fromB64url } from "./presence-proof.js";

test("canonical, the payload hash and the proof bytes equal the kernel's own", () => {
  const fields = { b: 2, a: { z: [1, "x"], y: null }, skip: undefined };
  assert.equal(canonical(fields), kc(fields));
  assert.equal(payloadHash("grant.invite", "spc_1", fields), kp("grant.invite", "spc_1", fields));
  const proof = { signer: "secure_enclave", key_id: "k", payload_hash: "h", decision: "x", chain_hash: "c", issued_at: 1, expires_at: 2, nonce: "n", signature: "s", assertion: "a" };
  assert.deepEqual(Buffer.from(proofBytes(proof)), kb({ ...proof, assertion: undefined }));
});

test("the chain hash is the sha-256 of the one-person chain", () => {
  const want = crypto.createHash("sha256").update(kc([["person", "per_1", "spc_1"]])).digest("base64url");
  assert.equal(chainHash("per_1", "spc_1"), want);
});

test("a DER signature becomes r||s and verifies as P1363 against the SPKI built from x and y", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const spki = spkiFromXY(fromB64url(jwk.x), fromB64url(jwk.y));
  assert.deepEqual(Buffer.from(spki), publicKey.export({ format: "der", type: "spki" }));
  for (let i = 0; i < 40; i++) {
    const msg = Buffer.from("m" + i);
    const der = crypto.sign("sha256", msg, privateKey);
    const sig = p1363FromDer(new Uint8Array(der));
    assert.equal(sig.length, 64);
    assert.ok(crypto.verify("sha256", msg, { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig)));
  }
  assert.match(keyIdOf(spki), /^se-[0-9a-f]{16}$/);
  assert.equal(b64(new Uint8Array([1, 2, 3, 4])), Buffer.from([1, 2, 3, 4]).toString("base64"));
  assert.equal(b64url(new Uint8Array([251, 255])), Buffer.from([251, 255]).toString("base64url"));
});

test("proofBody refuses a card whose fields do not hash to its payload_hash, and builds a body of at most 120 s", () => {
  const fields = { device: "alex-mac" };
  const req = { op: "grant.signin", space: "spc_1", fields, payload_hash: kp("grant.signin", "spc_1", fields), person: "per_1" };
  const body = proofBody(req, { keyId: "se-1", now: 1000, nonce: "n1" });
  assert.equal(body.decision, "grant.signin"); assert.equal(body.signer, "secure_enclave");
  assert.ok(body.expires_at - body.issued_at <= 120000);
  assert.throws(() => proofBody({ ...req, fields: { device: "other" } }, { keyId: "k", now: 1, nonce: "n" }), { code: "ERR_PAYLOAD_MISMATCH" });
  assert.throws(() => proofBody({ ...req, person: "" }, { keyId: "k", now: 1, nonce: "n" }), { code: "ERR_NO_PERSON" });
});
