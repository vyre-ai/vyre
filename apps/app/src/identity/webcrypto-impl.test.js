import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { methods, install, btoaImpl, atobImpl } from "./webcrypto-impl.js";

const u = (s) => new TextEncoder().encode(s);

test("digest, HKDF into AES-GCM and AES-GCM equal node:crypto", async () => {
  assert.equal(Buffer.from(await methods.digest("SHA-256", u("abc"))).toString("hex"), crypto.createHash("sha256").update("abc").digest("hex"));
  const base = await methods.importKey("raw", u("name"), "HKDF", false, ["deriveKey"]);
  const key = await methods.deriveKey({ name: "HKDF", hash: "SHA-256", salt: u("salt"), info: u("record") }, base, { name: "AES-GCM", length: 256 });
  const iv = crypto.randomBytes(12);
  const ct = Buffer.from(await methods.encrypt({ name: "AES-GCM", iv, additionalData: u("name"), tagLength: 128 }, key, u("hello")));
  const nodeKey = Buffer.from(crypto.hkdfSync("sha256", u("name"), u("salt"), u("record"), 32));
  const d = crypto.createDecipheriv("aes-256-gcm", nodeKey, iv); d.setAAD(u("name")); d.setAuthTag(ct.subarray(ct.length - 16));
  assert.equal(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString(), "hello");
  assert.equal(Buffer.from(await methods.decrypt({ name: "AES-GCM", iv, additionalData: u("name"), tagLength: 128 }, key, ct)).toString(), "hello");
  await assert.rejects(methods.decrypt({ name: "AES-GCM", iv, additionalData: u("other"), tagLength: 128 }, key, ct));
});

// Fixed expectations, not whatever node returns: node 22 and node 24 (OpenSSL) differ on the small-order and non-canonical cases, and RFC 8032 strict (what the chain
// needs: one signature, one meaning) refuses all of them on every platform.
test("Ed25519 verify is strict: it accepts a good signature and refuses a flipped bit, a non-canonical S, a small-order key and a non-canonical point", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const msg = u("m");
  const sig = crypto.sign(null, msg, privateKey);
  const verify = async (pubBytes, sigBytes) => methods.verify({ name: "Ed25519" }, await methods.importKey("raw", pubBytes, { name: "Ed25519" }, false, ["verify"]), sigBytes, msg);
  assert.equal(await verify(pub, sig), true);
  const bad = Buffer.from(sig); bad[0] ^= 1;
  assert.equal(await verify(pub, bad), false);
  // S + L is the same signature with a non-canonical S (RFC 8032 section 5.1.7 requires S < L).
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const s = BigInt("0x" + Buffer.from(sig.subarray(32)).reverse().toString("hex"));
  const nonCanon = Buffer.concat([sig.subarray(0, 32), Buffer.from((s + L).toString(16).padStart(64, "0"), "hex").reverse()]);
  assert.equal(await verify(pub, nonCanon), false);
  // The identity point as the key, with the identity signature (R = identity, S = 0): valid under the cofactored equation, small order, so refused.
  const identity = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000", "hex");
  assert.equal(await verify(identity, Buffer.concat([identity, Buffer.alloc(32)])), false);
  // A small-order point of order 2 (0, -1) as the key and as R.
  const order2 = Buffer.from("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex");
  assert.equal(await verify(order2, Buffer.concat([order2, Buffer.alloc(32)])), false);
  // The identity point written non-canonically (y = p + 1, the same point as y = 1): a key and an R that a strict verifier refuses.
  const nonCanonPoint = Buffer.from("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex");
  assert.equal(await verify(nonCanonPoint, Buffer.concat([nonCanonPoint, Buffer.alloc(32)])), false);
  assert.equal(await verify(pub, Buffer.concat([nonCanonPoint, sig.subarray(32)])), false);
});

test("ECDSA P-256 verify takes r||s and equals node", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const msg = u("signed");
  const sig = crypto.sign("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" });
  const k = await methods.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await methods.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, msg), true);
  assert.equal(await methods.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, u("other")), false);
});

test("install fills only what is missing, always uses the native random, and fails closed on a constant source", () => {
  const partial = { digest: async () => "kept" };
  const g = { crypto: { subtle: partial, getRandomValues: () => { throw new Error("an earlier polyfill must not win"); } } };
  install(g, (n) => crypto.randomBytes(n));
  assert.equal(g.crypto.subtle.digest, partial.digest);
  assert.equal(typeof g.crypto.subtle.importKey, "function");
  assert.equal(g.crypto.getRandomValues(new Uint8Array(2000)).length, 2000);
  assert.equal(btoaImpl("hello!?"), Buffer.from("hello!?").toString("base64"));
  assert.equal(atobImpl(Buffer.from("hello!?x").toString("base64")), "hello!?x");
  assert.throws(() => install({}, (n) => new Uint8Array(n)), /constant/);
});
