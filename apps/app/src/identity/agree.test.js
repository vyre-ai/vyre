import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { agree, agreePublic, validPoint } from "./agree.ts";
import { useRecordAgreeKey, makeRecordAgreeKey, _forgetAgreeKey } from "../crypto/agree-key.ts";

const b64u = (b) => Buffer.from(b).toString("base64url");

test("a peer's point must be a raw uncompressed P-256 point before any key is asked", () => {
  const peer = createECDH("prime256v1"); peer.generateKeys();
  assert.equal(validPoint(b64u(peer.getPublicKey())).length, 65);
  for (const bad of ["", "AAAA", b64u(Buffer.alloc(65)), b64u(peer.getPublicKey("hex", "compressed") && Buffer.from(peer.getPublicKey("hex", "compressed"), "hex")), "not base64 !!"]) assert.throws(() => validPoint(bad), (e) => e.code === "bad_epk", String(bad).slice(0, 12));
});

test("the record's chat key gives its public point and the same shared secret node's ECDH computes", async (t) => {
  delete globalThis.window; t.after(() => { delete globalThis.window; _forgetAgreeKey(); });
  const made = await makeRecordAgreeKey();
  assert.equal(await useRecordAgreeKey(made.priv), made.point);
  assert.equal(await agreePublic(true), made.point);
  const other = createECDH("prime256v1"); other.generateKeys();
  const secret = await agree(b64u(other.getPublicKey()));
  assert.equal(secret.length, 32);
  assert.deepEqual(Buffer.from(secret), other.computeSecret(Buffer.from(made.point, "base64url")));
});

test("locked, or in a shell that holds a key of its own: no device makes a chat key, so there is no point and agree rejects in plain words, before any key work when the peer point is bad", async (t) => {
  // a shell with its own agreement key is never asked (no Keychain, no Secure Enclave): only the record's key counts
  const calls = [];
  globalThis.window = { __vyreShell: { kind: "mac", identity: { agreePublic: async () => { calls.push("public"); return "x"; }, agree: async () => { calls.push("agree"); return "x"; } } } };
  t.after(() => { delete globalThis.window; _forgetAgreeKey(); });
  _forgetAgreeKey();
  assert.equal(await agreePublic(true), null);
  const other = createECDH("prime256v1"); other.generateKeys();
  await assert.rejects(agree(b64u(other.getPublicKey())), (e) => e.code === "no_agree_key" && /unlock/.test(e.message));
  await assert.rejects(agree("AAAA"), (e) => e.code === "bad_epk");
  assert.deepEqual(calls, [], "the shell's key was never asked");
});

test("a record's key refuses what is not a P-256 private key, and locking drops it", async () => {
  await assert.rejects(() => useRecordAgreeKey("not json"), /not readable/);
  await assert.rejects(() => useRecordAgreeKey(JSON.stringify({ kty: "EC", crv: "P-256", x: "a", y: "b" })), /not a P-256 key/);
  const made = await makeRecordAgreeKey();
  await useRecordAgreeKey(made.priv);
  assert.equal(await agreePublic(true), made.point);
  assert.equal(await useRecordAgreeKey(null), null);
  assert.equal(await agreePublic(true), null);
});

test("memory's fixed vector: the record's key loaded with the vector's private key agrees on the wrap's epk to the vector's shared secret", async (t) => {
  const v = JSON.parse(readFileSync(new URL("../../../../lib/vectors/keywrap.json", import.meta.url), "utf8"));
  t.after(() => _forgetAgreeKey());
  await useRecordAgreeKey(JSON.stringify({ kty: "EC", crv: "P-256", x: v.agree_public_jwk.x, y: v.agree_public_jwk.y, d: v.agree_private_jwk.d }));
  const pub = Buffer.from(await agreePublic(true), "base64url");
  assert.equal(b64u(pub.subarray(1, 33)), v.agree_public_jwk.x);
  assert.equal(b64u(pub.subarray(33, 65)), v.agree_public_jwk.y);
  assert.equal(b64u(await agree(v.wrap.epk)), v.shared);
});
