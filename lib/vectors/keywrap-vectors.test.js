// The fixed wrap vector: lib/keywrap.js (WebCrypto) opens it, and every intermediate value matches, so a native `agree` plus portable code can be checked against the same numbers.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { unwrapWithDevice, fingerprint, ecdhFrom, b64, unb64 } from "../keywrap.js";

const v = JSON.parse(fs.readFileSync(new URL("./keywrap.json", import.meta.url), "utf8"));
const hex = (b) => Buffer.from(b).toString("hex");

test("keywrap vector: the library opens the fixed wrap, the holder id and every step match", async () => {
  assert.equal(await fingerprint(v.agree_public_jwk), v.holder);
  assert.equal(hex(await unwrapWithDevice(v.wrap, v.agree_private_jwk, v.aad)), hex(unb64(v.plaintext_key)));
  const shared = await ecdhFrom(v.agree_private_jwk)(unb64(v.wrap.epk));
  assert.equal(b64(shared), v.shared);
  assert.equal(hex(crypto.hkdfSync("sha256", Buffer.from(shared), Buffer.from(unb64(v.wrap.epk)), Buffer.from("vyre-identity-wrap-v1"), 32)), hex(unb64(v.kek)));
  await assert.rejects(() => unwrapWithDevice(v.wrap, v.agree_private_jwk, "ring:chat_other:1"), /cannot open/);
});
