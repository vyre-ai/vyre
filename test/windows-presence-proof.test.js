// The Windows app signs the proof that lets the box accept its local core as a companion (local/capsule/native-win/src/presence_proof.rs).
// The Rust tests reproduce tests/presence-vector.json; this checks the same vector the way the box does: core/presence's own input hash
// and message, the key id as a fingerprint of the enrolled SPKI, and a DER ES256 signature.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { inputHash, fingerprint } from "../core/presence/index.js";

const v = JSON.parse(fs.readFileSync(new URL("../local/capsule/native-win/tests/presence-vector.json", import.meta.url), "utf8"));

test("windows presence proof: the header is one the box's device check accepts", () => {
  const m = /^device key=(\S+) ts=(\d{1,16}) nonce=([A-Za-z0-9_-]{8,128}) sig=([A-Za-z0-9_-]+)$/.exec(v.header);
  assert.ok(m, v.header);
  assert.equal(m[1], v.key_id);
  assert.equal(m[1], fingerprint(v.spki), "the key id is the fingerprint of the enrolled key");
  assert.equal(m[2], String(v.ts));
  assert.equal(m[3], v.nonce);
  const pub = crypto.createPublicKey({ key: Buffer.from(v.spki, "base64url"), format: "der", type: "spki" });
  assert.equal(pub.asymmetricKeyType, "ec");
  assert.equal(pub.asymmetricKeyDetails.namedCurve, "prime256v1");
  const msg = Buffer.from(`vyre-presence-v1\nlink.companion.pair\n${inputHash(v.input)}\n${m[2]}\n${m[3]}`);
  assert.equal(crypto.verify("sha256", msg, { key: pub, dsaEncoding: "der" }, Buffer.from(m[4], "base64url")), true);
  const other = Buffer.from(`vyre-presence-v1\nvault.reveal\n${inputHash(v.input)}\n${m[2]}\n${m[3]}`);
  assert.equal(crypto.verify("sha256", other, { key: pub, dsaEncoding: "der" }, Buffer.from(m[4], "base64url")), false, "bound to the tool");
});

test("windows presence proof: the input the app builds is the shape link.companion.pair takes", () => {
  assert.deepEqual(Object.keys(v.input).sort(), ["core", "name", "nonce", "ts"]);
  assert.match(v.input.core, /^[A-Za-z0-9_-]{60,200}$/);
  assert.match(v.input.nonce, /^[A-Za-z0-9_-]{16,64}$/);
});
