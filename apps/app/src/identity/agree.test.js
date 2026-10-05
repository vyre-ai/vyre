import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { agree, agreePublic, validPoint } from "./agree.ts";

const b64u = (b) => Buffer.from(b).toString("base64url");

/** A stand-in for the shell's agreement key: node's ECDH P-256 in place of the OS keystore or hardware. */
function installShell() {
  const mine = createECDH("prime256v1"); mine.generateKeys();
  const calls = [];
  globalThis.window = { __vyreShell: { kind: "windows", identity: {
    agreePublic: async (create) => { calls.push(["public", !!create]); return b64u(mine.getPublicKey()); },
    agree: async (epk) => { calls.push(["agree"]); return b64u(mine.computeSecret(Buffer.from(epk, "base64url"))); },
  } } };
  return { mine, calls };
}

test("a peer's point must be a raw uncompressed P-256 point before any key is asked", () => {
  const peer = createECDH("prime256v1"); peer.generateKeys();
  assert.equal(validPoint(b64u(peer.getPublicKey())).length, 65);
  for (const bad of ["", "AAAA", b64u(Buffer.alloc(65)), b64u(peer.getPublicKey("hex", "compressed") && Buffer.from(peer.getPublicKey("hex", "compressed"), "hex")), "not base64 !!"]) assert.throws(() => validPoint(bad), (e) => e.code === "bad_epk", String(bad).slice(0, 12));
});

test("the shell's agreement key gives its public point and the same shared secret node's ECDH computes, which is what memory's unwrap expects", async (t) => {
  const { mine, calls } = installShell(); t.after(() => delete globalThis.window);
  const pt = await agreePublic(true);
  assert.deepEqual(Buffer.from(pt, "base64url"), mine.getPublicKey());
  const other = createECDH("prime256v1"); other.generateKeys();
  const secret = await agree(b64u(other.getPublicKey()));
  assert.equal(secret.length, 32);
  assert.deepEqual(Buffer.from(secret), other.computeSecret(mine.getPublicKey()));
  assert.deepEqual(calls, [["public", true], ["agree"]]);
});

test("without a shell or a key: no public point, and agree rejects in plain words, before asking when the peer point is bad", async (t) => {
  delete globalThis.window; t.after(() => delete globalThis.window);
  assert.equal(await agreePublic(true), null);
  const other = createECDH("prime256v1"); other.generateKeys();
  await assert.rejects(agree(b64u(other.getPublicKey())), (e) => e.code === "no_agree_key");
  const { calls } = installShell();
  await assert.rejects(agree("AAAA"), (e) => e.code === "bad_epk");
  assert.deepEqual(calls, [], "the key was never asked");
});

import { readFileSync } from "node:fs";

test("memory's fixed vector: a key loaded with the vector's private key agrees on the wrap's epk to the vector's shared secret, through the page adapter", async (t) => {
  const v = JSON.parse(readFileSync(new URL("../../../../lib/vectors/keywrap.json", import.meta.url), "utf8"));
  const key = createECDH("prime256v1");
  key.setPrivateKey(Buffer.from(v.agree_private_jwk.d, "base64url"));
  globalThis.window = { __vyreShell: { kind: "mac", identity: {
    agreePublic: async () => b64u(key.getPublicKey()),
    agree: async (epk) => b64u(key.computeSecret(Buffer.from(epk, "base64url"))),
  } } };
  t.after(() => delete globalThis.window);
  const pt = await agreePublic(true);
  const pub = Buffer.from(pt, "base64url");
  assert.equal(b64u(pub.subarray(1, 33)), v.agree_public_jwk.x);
  assert.equal(b64u(pub.subarray(33, 65)), v.agree_public_jwk.y);
  const secret = await agree(v.wrap.epk);
  assert.equal(b64u(secret), v.shared);
});
