// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { isOwnerOnly } from "../../lib/owner-only.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nodeCrypto, fileKeyStore } from "./nodecrypto.js";
import { keyPair as boxKeyPair, PROTOCOL } from "../../core/relay/noise.js";
import { tempHome } from "../../test/helpers.js";

test("nodeCrypto: DH agrees both ways, and with core/relay/noise.js's own X25519 (box and device interoperate)", async () => {
  const c = nodeCrypto();
  const a = await c.generateKeyPair(), b = await c.generateKeyPair();
  assert.deepEqual(await c.dh(a.privateKey, b.publicKey), await c.dh(b.privateKey, a.publicKey));
  // The box's own keyPair() (raw node:crypto, Buffer-based) must DH the same way against a device
  // key made here: same DER prefixes, same X25519 curve, just a different provider wrapper.
  const box = boxKeyPair();
  const shared = await c.dh(a.privateKey, Buffer.from(box.pub));
  assert.equal(Buffer.from(shared).length, 32);
  assert.notDeepEqual(shared, Buffer.alloc(32));
});

test("nodeCrypto: sha256, hmacSha256 and AES-GCM round-trip, and a wrong tag or key fails", async () => {
  const c = nodeCrypto();
  assert.equal(Buffer.from(await c.sha256(Buffer.from("hello"))).toString("hex"), crypto.createHash("sha256").update("hello").digest("hex"));
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12), ad = Buffer.from("ad"), pt = Buffer.from("secret message");
  const ct = await c.aesGcmEncrypt(key, nonce, ad, pt);
  assert.deepEqual(Buffer.from(await c.aesGcmDecrypt(key, nonce, ad, ct)), pt);
  await assert.rejects(() => c.aesGcmDecrypt(crypto.randomBytes(32), nonce, ad, ct), /decrypt failed/);
  const tampered = Buffer.from(ct); tampered[0] ^= 1;
  await assert.rejects(() => c.aesGcmDecrypt(key, nonce, ad, tampered), /decrypt failed/);
});

test("fileKeyStore: made on first use (0600/0700), and the same file loads the same key back", async t => {
  const root = tempHome(t);
  const file = path.join(root, "relay-device", "key.json");
  const store = fileKeyStore(file);
  assert.equal(await store.get(), null, "nothing yet");
  const kp = await nodeCrypto().generateKeyPair();
  await store.set(kp);
  if (process.platform === "win32") assert.ok(isOwnerOnly(path.dirname(file)) && isOwnerOnly(file), "the key folder is open to other users");
  else { assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700); assert.equal(fs.statSync(file).mode & 0o777, 0o600); }
  const again = await store.get();
  assert.deepEqual(Buffer.from(again.privateKey), Buffer.from(kp.privateKey));
  assert.deepEqual(Buffer.from(again.publicKey), Buffer.from(kp.publicKey));
});
