// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyAssertion } from "./webauthn.js";

const u = (/** @type {Buffer} */ b) => b.toString("base64url");
const RP = "vyre.example.com";
const ORIGIN = "https://vyre.example.com";
const CHALLENGE = u(crypto.randomBytes(32));

const KEYS = {
  [-7]: crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }),
  [-8]: crypto.generateKeyPairSync("ed25519"),
  [-257]: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }),
};

/** Build a real assertion, with overrides for the parts a test wants to break. */
function make(alg = -7, { flags = 0x05, rpId = RP, type = "webauthn.get", challenge = CHALLENGE, origin = ORIGIN, count = 7 } = {}) {
  const { publicKey, privateKey } = KEYS[alg];
  const ad = Buffer.alloc(37);
  crypto.createHash("sha256").update(rpId).digest().copy(ad, 0);
  ad[32] = flags;
  ad.writeUInt32BE(count, 33);
  const cd = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const signed = Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]);
  const signature = alg === -7 ? crypto.sign("sha256", signed, { key: privateKey, dsaEncoding: "der" })
    : alg === -8 ? crypto.sign(null, signed, privateKey) : crypto.sign("sha256", signed, privateKey);
  return {
    publicKey: u(publicKey.export({ format: "der", type: "spki" })), alg, rpId: RP, challenge: CHALLENGE,
    authenticatorData: u(ad), clientDataJSON: u(cd), signature: u(signature), origins: [ORIGIN],
  };
}

for (const alg of [-7, -8, -257]) {
  test(`accepts a real assertion, alg ${alg}`, () => {
    assert.deepEqual(verifyAssertion(make(alg)), { ok: true, signCount: 7 });
  });
  test(`refuses a bad signature, alg ${alg}`, () => {
    const a = make(alg);
    const s = Buffer.from(a.signature, "base64url"); s[s.length - 1] ^= 1;
    const r = verifyAssertion({ ...a, signature: u(s) });
    assert.equal(r.ok, false);
  });
}

test("tolerates padding on the challenge", () => {
  const a = make(-7, { challenge: "abc" });
  assert.equal(verifyAssertion({ ...a, challenge: "abc=" }).ok, true);
});

const refusals = /** @type {[string, () => any, RegExp][]} */ ([
  ["wrong challenge", () => ({ ...make(), challenge: u(crypto.randomBytes(32)) }), /challenge/],
  ["wrong type", () => make(-7, { type: "webauthn.create" }), /type/],
  ["wrong rpId", () => make(-7, { rpId: "evil.example.com" }), /rpId/],
  ["missing UV", () => make(-7, { flags: 0x01 }), /verified/],
  ["missing UP", () => make(-7, { flags: 0x04 }), /present/],
  ["origin not allowed", () => make(-7, { origin: "https://evil.example.com" }), /origin/],
  ["unsupported alg", () => ({ ...make(), alg: -35 }), /unsupported alg/],
  ["tampered authData", () => {
    const a = make(); const ad = Buffer.from(a.authenticatorData, "base64url"); ad[36] ^= 1;
    return { ...a, authenticatorData: u(ad) };
  }, /signature/],
  ["tampered clientData", () => {
    const a = make(); const cd = JSON.parse(Buffer.from(a.clientDataJSON, "base64url").toString());
    cd.crossOrigin = true;
    return { ...a, clientDataJSON: u(Buffer.from(JSON.stringify(cd))) };
  }, /signature/],
  ["key from another pair", () => {
    const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
    return { ...make(), publicKey: u(other.export({ format: "der", type: "spki" })) };
  }, /signature/],
]);
for (const [name, build, reason] of refusals) {
  test(`refuses ${name}`, () => {
    const r = verifyAssertion(build());
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).reason, reason);
  });
}

test("garbage never throws", () => {
  const good = make();
  const inputs = [
    undefined, null, {}, { ...good, publicKey: "!!!" }, { ...good, publicKey: u(Buffer.from("nope")) },
    { ...good, authenticatorData: "" }, { ...good, clientDataJSON: u(Buffer.from("not json")) },
    { ...good, clientDataJSON: u(Buffer.from("null")) }, { ...good, signature: 42 },
    { ...good, rpId: undefined }, { ...good, challenge: undefined }, { ...good, alg: "-7" },
    { ...good, authenticatorData: { length: 99 } },
  ];
  for (const i of inputs) {
    const r = verifyAssertion(/** @type {any} */ (i));
    assert.equal(r.ok, false, JSON.stringify(i));
  }
});
