// @ts-check
// A real Windows Hello capture (test/fixtures/windows-hello.json): the public key and one RS256
// signature from a KeyCredentialManager credential on Windows 11, made after a PIN prompt. Only
// public data is stored. The rsa.test.js cases build their own keys; this one proves the same
// code accepts what a real machine produced.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Presence } from "./index.js";
import { normalizePublicKey } from "./keys.js";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";

const fx = JSON.parse(fs.readFileSync(new URL("../../test/fixtures/windows-hello.json", import.meta.url), "utf8"));
const b = s => Buffer.from(s, "base64");

test("windows hello fixture: the captured signature verifies against the captured key", () => {
  assert.equal(fx.alg, -257);
  const key = crypto.createPublicKey({ key: b(fx.publicKeySpkiBase64), format: "der", type: "spki" });
  assert.equal(key.asymmetricKeyType, "rsa");
  assert.equal(key.asymmetricKeyDetails?.modulusLength, 2048);
  assert.ok(crypto.verify("sha256", b(fx.challengeBase64), key, b(fx.signatureBase64)));
  assert.ok(!crypto.verify("sha256", Buffer.concat([b(fx.challengeBase64), Buffer.from("x")]), key, b(fx.signatureBase64)));
});

test("windows hello fixture: both key exports are the same key once normalized", () => {
  const spki = normalizePublicKey(fx.publicKeySpkiBase64);
  const pkcs1 = crypto.createPublicKey({ key: b(fx.publicKeyPkcs1Base64), format: "der", type: "pkcs1" })
    .export({ format: "der", type: "spki" });
  assert.deepEqual(Buffer.from(spki, "base64url"), pkcs1);
});

test("windows hello fixture: the real key enrolls as an RS256 device key", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  const p = new Presence({ db, platform: "linux", touchid: null, webauthn: null, now: () => 1_000_000 });
  const k = p.enroll({ kind: "device", name: "windows-hello-capture", public_key: fx.publicKeySpkiBase64, alg: -257 });
  assert.deepEqual({ ...db.prepare("SELECT kind, alg FROM presence_keys WHERE id = ?").get(k.id) }, { kind: "device", alg: -257 });
});
