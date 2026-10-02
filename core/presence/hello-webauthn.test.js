// @ts-check
// A real Windows Hello WebAuthn capture, taken in the app's WebView2 on a Windows 11 vTPM VM (core/presence/testing/windows-hello.json):
// the registration's attestationObject gives the credential id and the RSA public key (COSE), and the assertion's RS256 signature must
// verify through verifyAssertion with the rpId, origin and challenge the capture names. The capture is real data or this test skips and says
// so; it is never faked. A second test builds the same shapes in-process (an RSA key, a "none" attestation) and runs them through the same
// parser, so a parser fault cannot hide behind a skipped capture.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { verifyAssertion } from "./webauthn.js";

const FILE = new URL("./testing/windows-hello.json", import.meta.url);
const b64 = (/** @type {string} */ s) => Buffer.from(String(s), "base64url");
const u = (/** @type {Buffer} */ b) => b.toString("base64url");

/** A small CBOR reader: unsigned and negative ints, byte and text strings, arrays and maps (all a COSE key and an attestation object use). */
function cbor(/** @type {Buffer} */ buf, at = { i: 0 }) {
  const first = buf[at.i++], major = first >> 5, info = first & 31;
  let n = info;
  if (info === 24) n = buf[at.i++];
  else if (info === 25) { n = buf.readUInt16BE(at.i); at.i += 2; }
  else if (info === 26) { n = buf.readUInt32BE(at.i); at.i += 4; }
  else if (info > 26) throw new Error("cbor: unsupported length");
  if (major === 0) return n;
  if (major === 1) return -1 - n;
  if (major === 2) { const v = buf.subarray(at.i, at.i + n); at.i += n; return v; }
  if (major === 3) { const v = buf.subarray(at.i, at.i + n).toString("utf8"); at.i += n; return v; }
  if (major === 4) return Array.from({ length: n }, () => cbor(buf, at));
  if (major === 5) { const m = new Map(); for (let k = 0; k < n; k++) { const key = cbor(buf, at); m.set(key, cbor(buf, at)); } return m; }
  throw new Error(`cbor: unsupported major type ${major}`);
}

/** credentialId, rpIdHash, flags and the RSA public key (SPKI, base64url) out of a registration's attestationObject. */
function registered(/** @type {string} */ attestationObject) {
  const att = /** @type {Map<string, any>} */ (cbor(b64(attestationObject)));
  const ad = /** @type {Buffer} */ (att.get("authData"));
  assert.ok(ad.length > 55 && (ad[32] & 0x40), "authData carries attested credential data");
  const idLen = ad.readUInt16BE(53);
  const credentialId = ad.subarray(55, 55 + idLen);
  const at = { i: 55 + idLen };
  const cose = /** @type {Map<number, any>} */ (cbor(ad, at));
  assert.equal(cose.get(1), 3, "COSE kty RSA"); assert.equal(cose.get(3), -257, "COSE alg RS256");
  const jwk = { kty: "RSA", n: u(cose.get(-1)), e: u(cose.get(-2)) };
  const publicKey = u(/** @type {Buffer} */ (crypto.createPublicKey({ key: jwk, format: "jwk" }).export({ format: "der", type: "spki" })));
  return { fmt: att.get("fmt"), credentialId, rpIdHash: ad.subarray(0, 32), flags: ad[32], publicKey };
}

test("a real Windows Hello registration and assertion verify through verifyAssertion", t => {
  if (!fs.existsSync(FILE)) return t.skip("core/presence/testing/windows-hello.json is not captured yet (windows: WebAuthn capture on the vTPM VM); this test never passes without the real data");
  const fx = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const reg = registered(fx.registration.attestationObject);
  assert.ok(["tpm", "none", "packed"].includes(reg.fmt), `attestation fmt ${reg.fmt}`);
  assert.equal(u(reg.credentialId), fx.registration.credentialId, "the attested credential is the one named");
  assert.ok(reg.rpIdHash.equals(crypto.createHash("sha256").update(fx.rpId).digest()), "the registration is for this rpId");
  const created = JSON.parse(b64(fx.registration.clientDataJSON).toString("utf8"));
  assert.deepEqual([created.type, created.origin], ["webauthn.create", fx.origin]);
  const a = { publicKey: reg.publicKey, alg: -257, rpId: fx.rpId, challenge: fx.challenge, origins: [fx.origin],
    authenticatorData: fx.assertion.authenticatorData, clientDataJSON: fx.assertion.clientDataJSON, signature: fx.assertion.signature };
  const ok = verifyAssertion(a);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // The same capture, broken three ways, must each be refused.
  assert.notEqual(verifyAssertion({ ...a, challenge: u(crypto.randomBytes(32)) }).ok, true, "another challenge");
  assert.notEqual(verifyAssertion({ ...a, origins: ["https://evil.example"] }).ok, true, "another origin");
  const sig = Buffer.from(b64(a.signature)); sig[sig.length - 1] ^= 1;
  assert.notEqual(verifyAssertion({ ...a, signature: u(sig) }).ok, true, "a flipped signature bit");
});

test("the capture reader: an RSA registration (none attestation) and assertion built here go through the same parser and verifier", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = /** @type {any} */ (publicKey.export({ format: "jwk" }));
  const rp = "vyre.example.com", origin = "https://vyre.example.com", challenge = u(crypto.randomBytes(32));
  const credId = crypto.randomBytes(32);
  const head = (/** @type {number} */ major, /** @type {number} */ n) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const bytes = (/** @type {Buffer} */ x) => Buffer.concat([head(2, x.length), x]);
  const text = (/** @type {string} */ s) => Buffer.concat([head(3, s.length), Buffer.from(s)]);
  const int = (/** @type {number} */ n) => n >= 0 ? head(0, n) : head(1, -1 - n);
  const cose = Buffer.concat([head(5, 4), int(1), int(3), int(3), int(-257), int(-1), bytes(b64(jwk.n)), int(-2), bytes(b64(jwk.e))]);
  const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
  const authData = Buffer.concat([crypto.createHash("sha256").update(rp).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, credId, cose]);
  const attestationObject = u(Buffer.concat([head(5, 3), text("fmt"), text("none"), text("attStmt"), head(5, 0), text("authData"), bytes(authData)]));
  const reg = registered(attestationObject);
  assert.deepEqual([reg.fmt, u(reg.credentialId)], ["none", u(credId)]);
  const ad = Buffer.alloc(37); crypto.createHash("sha256").update(rp).digest().copy(ad, 0); ad[32] = 0x05; ad.writeUInt32BE(1, 33);
  const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
  const signature = crypto.sign("sha256", Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]), privateKey);
  const a = { publicKey: reg.publicKey, alg: -257, rpId: rp, challenge, origins: [origin], authenticatorData: u(ad), clientDataJSON: u(cd), signature: u(signature) };
  assert.equal(verifyAssertion(a).ok, true);
  assert.notEqual(verifyAssertion({ ...a, challenge: u(crypto.randomBytes(32)) }).ok, true);
});
