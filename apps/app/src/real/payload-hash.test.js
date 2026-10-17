// @ts-check
// payload-hash.js has no node:crypto (the Android and web bundles cannot resolve it): its own sha-256 and base64url are held to node's, byte for byte, here.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { sha256, b64url, payloadHash } from "./payload-hash.js";

const hex = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("hex");

test("sha-256: the known answers, including the padding boundary", () => {
  assert.equal(hex(sha256(new TextEncoder().encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hex(sha256(new Uint8Array(0))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex(sha256(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("sha-256 and base64url agree with node:crypto for every length from 0 to 300 and for random bytes", () => {
  for (let n = 0; n <= 300; n++) {
    const data = randomBytes(n);
    assert.equal(hex(sha256(data)), createHash("sha256").update(data).digest("hex"), `length ${n}`);
    assert.equal(b64url(data), data.toString("base64url"), `base64url length ${n}`);
  }
});

test("payloadHash is node's sha-256 (base64url) over the canonical { op, space, fields }", () => {
  const fields = { b: 2, a: "é☃", n: [1, { z: 1, y: 2 }] };
  const want = createHash("sha256").update(JSON.stringify({ fields: { a: "é☃", b: 2, n: [1, { y: 2, z: 1 }] }, op: "x.y", space: "spc_1" })).digest("base64url");
  assert.equal(payloadHash("x.y", "spc_1", fields), want);
});
