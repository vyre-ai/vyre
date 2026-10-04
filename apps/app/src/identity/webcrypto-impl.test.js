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

test("Ed25519 verify is strict and gives node's answer, including a non-canonical S and a small-order key", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const msg = u("m");
  const sig = crypto.sign(null, msg, privateKey);
  const k = await methods.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  assert.equal(await methods.verify({ name: "Ed25519" }, k, sig, msg), true);
  const bad = Buffer.from(sig); bad[0] ^= 1;
  assert.equal(await methods.verify({ name: "Ed25519" }, k, bad, msg), false);
  // S + L (non-canonical): node refuses, so must we.
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const s = BigInt("0x" + Buffer.from(sig.subarray(32)).reverse().toString("hex"));
  const s2 = (s + L).toString(16).padStart(64, "0");
  const nonCanon = Buffer.concat([sig.subarray(0, 32), Buffer.from(s2, "hex").reverse()]);
  const nodeSays = (() => { try { return crypto.verify(null, msg, publicKey, nonCanon); } catch { return false; } })();
  assert.equal(await methods.verify({ name: "Ed25519" }, k, nonCanon, msg), nodeSays);
  assert.equal(nodeSays, false);
  // A small-order key (the identity point) with the identity signature: node refuses.
  const small = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000", "hex");
  const smallKey = await methods.importKey("raw", small, { name: "Ed25519" }, false, ["verify"]);
  const smallSig = Buffer.concat([small, Buffer.alloc(32)]);
  const nodeSmall = (() => { try { return crypto.verify(null, msg, crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), small]), format: "der", type: "spki" }), smallSig); } catch { return false; } })();
  assert.equal(await methods.verify({ name: "Ed25519" }, smallKey, smallSig, msg), nodeSmall);
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
