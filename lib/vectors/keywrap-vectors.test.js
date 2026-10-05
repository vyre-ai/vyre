// The fixed wrap vector: lib/keywrap.js opens it, and every intermediate value matches, so a native `agree` plus portable code can be checked against the same numbers.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { unwrapWithDevice, fingerprint } from "../keywrap.js";

const v = JSON.parse(fs.readFileSync(new URL("./keywrap.json", import.meta.url), "utf8"));
const unb64 = s => Buffer.from(s, "base64url");

test("keywrap vector: the library opens the fixed wrap, the holder id and every step match", () => {
  assert.equal(fingerprint(v.agree_public_jwk), v.holder);
  assert.deepEqual(unwrapWithDevice(v.wrap, v.agree_private_jwk, v.aad), unb64(v.plaintext_key));
  const e = crypto.createECDH("prime256v1");
  e.setPrivateKey(unb64(v.agree_private_jwk.d));
  const shared = e.computeSecret(unb64(v.wrap.epk));
  assert.deepEqual(shared, unb64(v.shared));
  assert.deepEqual(Buffer.from(crypto.hkdfSync("sha256", shared, unb64(v.wrap.epk), Buffer.from("vyre-identity-wrap-v1"), 32)), unb64(v.kek));
  assert.throws(() => unwrapWithDevice(v.wrap, v.agree_private_jwk, "ring:chat_other:1"), /cannot open/);
});
