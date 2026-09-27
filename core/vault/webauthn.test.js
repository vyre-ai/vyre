// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AAGUID, createCredential, getAssertion, rpIdAllowed } from "./webauthn.js";

const b64u = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64url");
const unb64u = (/** @type {string} */ s) => Buffer.from(s, "base64url");
const sha256 = (/** @type {Uint8Array | string} */ d) => crypto.createHash("sha256").update(d).digest();

/** A small CBOR decoder written apart from the encoder: ints, bytes, text, arrays, maps (as Map). */
function cborDecode(/** @type {Buffer} */ buf) {
  let i = 0;
  const arg = (/** @type {number} */ info) => {
    if (info < 24) return info;
    if (info === 24) return buf[i++];
    if (info === 25) { const v = buf.readUInt16BE(i); i += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(i); i += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(i)); i += 8; return v; }
    throw new Error(`indefinite or reserved length ${info}`);
  };
  /** @returns {any} */
  const item = () => {
    const b = buf[i++], major = b >> 5, n = arg(b & 31);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2) { const v = buf.subarray(i, i + n); i += n; return Buffer.from(v); }
    if (major === 3) { const v = buf.toString("utf8", i, i + n); i += n; return v; }
    if (major === 4) return Array.from({ length: n }, item);
    if (major === 5) { const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
    throw new Error(`major type ${major}`);
  };
  const v = item();
  return { value: v, used: i };
}

/** Split authenticatorData the way a server does. */
function parseAuthData(/** @type {Buffer} */ ad) {
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33), aaguid: /** @type {Buffer|null} */ (null), credId: /** @type {Buffer|null} */ (null), cose: /** @type {Map<number, any>|null} */ (null), rest: 0 };
  if (ad[32] & 0x40) {
    out.aaguid = ad.subarray(37, 53);
    const len = ad.readUInt16BE(53);
    out.credId = ad.subarray(55, 55 + len);
    const { value, used } = cborDecode(ad.subarray(55 + len));
    out.cose = value;
    out.rest = ad.length - (55 + len + used);
  } else out.rest = ad.length - 37;
  return out;
}

const UP = 0x01, UV = 0x04, BE = 0x08, BS = 0x10, AT = 0x40;
const challenge = () => b64u(crypto.randomBytes(32));
const juno = { id: b64u(Buffer.from("user-juno-0001")), name: "juno@harlow.test", displayName: "Juno" };
const make = (/** @type {Partial<Parameters<typeof createCredential>[0]>} */ over = {}) =>
  createCredential({ rpId: "harlow.test", origin: "https://login.harlow.test", challenge: challenge(), user: juno, algs: [-8, -7, -257], ...over });

test("rpIdAllowed: exact host, parent, sibling, public suffix, http, localhost, IP literals", () => {
  /** @type {[string, string, boolean][]} */
  const table = [
    ["harlow.test", "https://harlow.test", true],
    ["harlow.test", "https://login.harlow.test", true],
    ["harlow.test", "https://a.b.harlow.test:8443", true],
    ["login.harlow.test", "https://login.harlow.test", true],
    ["login.harlow.test", "https://harlow.test", false],
    ["login.harlow.test", "https://mail.harlow.test", false],
    ["harlow.test", "https://northwind.test", false],
    ["harlow.test", "https://evilharlow.test", false],
    ["test", "https://harlow.test", false],
    ["com", "https://harlow.com", false],
    ["co.uk", "https://harlow.co.uk", false],
    ["harlow.co.uk", "https://kit.harlow.co.uk", true],
    ["github.io", "https://alex.github.io", false],
    ["alex.github.io", "https://alex.github.io", true],
    ["harlow.test", "http://harlow.test", false],
    ["localhost", "http://localhost:5173", true],
    ["localhost", "https://localhost", true],
    ["harlow.test", "http://localhost:5173", false],
    ["127.0.0.1", "https://127.0.0.1", false],
    ["0.0.1", "https://127.0.0.1", false],
    ["127.0.0.1", "http://127.0.0.1", false],
    ["[::1]", "https://[::1]", false],
    ["Harlow.test", "https://harlow.test", false],
    ["harlow.test", "https://harlow.test/path", false],
    ["harlow.test", "https://harlow.test:443", false],
    ["harlow.test", "ftp://harlow.test", false],
    ["harlow.test", "not a url", false],
  ];
  for (const [rpId, origin, want] of table) assert.equal(rpIdAllowed(rpId, origin), want, `${rpId} at ${origin}`);
});

test("create: attestationObject, authData layout, COSE key matches SPKI", () => {
  const { credential, response } = make();
  const r = response.response;
  assert.equal(response.type, "public-key");
  assert.equal(response.id, credential.id);
  assert.equal(response.rawId, credential.id);
  assert.equal(unb64u(credential.id).length, 16);
  assert.deepEqual(response.clientExtensionResults, { credProps: { rk: true } });
  assert.deepEqual(r.transports, ["internal", "hybrid"]);
  assert.equal(r.publicKeyAlgorithm, -7);
  assert.equal(credential.signCount, 0);
  assert.equal(credential.userHandle, juno.id);
  assert.ok(credential.privateKey.startsWith(["-----BEGIN", "PRIVATE KEY-----"].join(" ")));

  const att = unb64u(r.attestationObject);
  const { value: obj, used } = cborDecode(att);
  assert.equal(used, att.length);
  assert.deepEqual([...obj.keys()], ["fmt", "attStmt", "authData"]);
  assert.equal(obj.get("fmt"), "none");
  assert.equal(obj.get("attStmt").size, 0);
  assert.deepEqual(obj.get("authData"), unb64u(r.authenticatorData));

  const ad = parseAuthData(obj.get("authData"));
  assert.deepEqual(ad.rpIdHash, sha256("harlow.test"));
  assert.equal(ad.flags, UP | UV | BE | BS | AT);
  assert.equal(ad.signCount, 0);
  assert.equal(b64u(/** @type {Buffer} */ (ad.aaguid)), b64u(Buffer.from(AAGUID.replace(/-/g, ""), "hex")));
  assert.equal(b64u(/** @type {Buffer} */ (ad.credId)), credential.id);
  assert.equal(ad.rest, 0);

  const cose = /** @type {Map<number, any>} */ (ad.cose);
  assert.deepEqual([...cose.keys()], [1, 3, -1, -2, -3]);
  assert.equal(cose.get(1), 2);
  assert.equal(cose.get(3), -7);
  assert.equal(cose.get(-1), 1);
  assert.equal(cose.get(-2).length, 32);
  assert.equal(cose.get(-3).length, 32);
  assert.deepEqual(cborDecode(unb64u(credential.publicKey)).value, cose, "the stored COSE key is the attested one");

  const jwk = crypto.createPublicKey({ key: unb64u(r.publicKey), format: "der", type: "spki" }).export({ format: "jwk" });
  assert.equal(jwk.crv, "P-256");
  assert.equal(jwk.x, b64u(cose.get(-2)));
  assert.equal(jwk.y, b64u(cose.get(-3)));
  assert.match(AAGUID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("get: signature verifies over authData || sha256(clientData), flags and rpIdHash", () => {
  const { credential, response } = make();
  const c = challenge();
  const { response: a, signCount } = getAssertion({ credential, origin: "https://harlow.test", challenge: c });
  assert.equal(signCount, 0);
  assert.equal(a.id, credential.id);
  assert.deepEqual(a.clientExtensionResults, {});
  assert.equal(a.response.userHandle, juno.id);
  const ad = unb64u(a.response.authenticatorData);
  assert.equal(ad.length, 37);
  const parsed = parseAuthData(ad);
  assert.equal(parsed.flags, UP | UV | BE | BS);
  assert.deepEqual(parsed.rpIdHash, sha256("harlow.test"));
  assert.equal(parsed.signCount, 0);
  const spki = crypto.createPublicKey({ key: unb64u(response.response.publicKey), format: "der", type: "spki" });
  const signed = Buffer.concat([ad, sha256(unb64u(a.response.clientDataJSON))]);
  const sig = unb64u(a.response.signature);
  assert.equal(sig[0], 0x30, "DER SEQUENCE");
  assert.ok(crypto.verify("sha256", signed, { key: spki, dsaEncoding: "der" }, sig));
  signed[0] ^= 1;
  assert.ok(!crypto.verify("sha256", signed, { key: spki, dsaEncoding: "der" }, sig));
});

test("clientDataJSON is exact bytes, topOrigin only when cross-origin", () => {
  const c = challenge();
  const { credential, response } = make({ challenge: c });
  assert.equal(unb64u(response.response.clientDataJSON).toString("utf8"),
    `{"type":"webauthn.create","challenge":"${c}","origin":"https://login.harlow.test","crossOrigin":false}`);
  const g = getAssertion({ credential, origin: "https://login.harlow.test", challenge: c });
  assert.equal(unb64u(g.response.response.clientDataJSON).toString("utf8"),
    `{"type":"webauthn.get","challenge":"${c}","origin":"https://login.harlow.test","crossOrigin":false}`);
  const x = getAssertion({ credential, origin: "https://login.harlow.test", challenge: c, crossOrigin: true, topOrigin: "https://northwind.test" });
  assert.equal(unb64u(x.response.response.clientDataJSON).toString("utf8"),
    `{"type":"webauthn.get","challenge":"${c}","origin":"https://login.harlow.test","crossOrigin":true,"topOrigin":"https://northwind.test"}`);
  assert.throws(() => getAssertion({ credential, origin: "https://login.harlow.test", challenge: c, crossOrigin: true }), { name: "SecurityError" });
});

test("errors: RS256 only is NotSupportedError, wrong origin is SecurityError, bad inputs refused", () => {
  assert.throws(() => make({ algs: [-257] }), { name: "NotSupportedError" });
  assert.doesNotThrow(() => make({ algs: [] }), "empty params mean the ES256 and RS256 defaults");
  assert.throws(() => make({ origin: "https://northwind.test" }), { name: "SecurityError" });
  assert.throws(() => make({ rpId: "test", origin: "https://harlow.test" }), { name: "SecurityError" });
  assert.throws(() => make({ challenge: b64u(crypto.randomBytes(15)) }), /16 to 1024/);
  assert.throws(() => make({ challenge: b64u(crypto.randomBytes(1025)) }), /16 to 1024/);
  assert.throws(() => make({ challenge: "abc+/def==abcdefghijklmnop" }), /base64url/);
  assert.throws(() => make({ user: { ...juno, id: "" } }), /1 to 64/);
  assert.throws(() => make({ user: { ...juno, id: b64u(crypto.randomBytes(65)) } }), /1 to 64/);
  const { credential } = make();
  assert.throws(() => getAssertion({ credential, origin: "https://northwind.test", challenge: challenge() }), { name: "SecurityError" });
  assert.throws(() => getAssertion({ credential, origin: "http://harlow.test", challenge: challenge() }), { name: "SecurityError" });
});

// ---- An independent relying party, as a server library would verify. ----

/** COSE EC2 key to a node public key, without looking at the SPKI the authenticator also sent. */
function coseToKey(/** @type {Map<number, any>} */ cose) {
  assert.equal(cose.get(1), 2, "kty EC2");
  assert.equal(cose.get(3), -7, "alg ES256");
  assert.equal(cose.get(-1), 1, "crv P-256");
  return crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) }, format: "jwk" });
}

function rpClientData(/** @type {string} */ b64, /** @type {string} */ type, /** @type {string} */ expChallenge, /** @type {string} */ expOrigin) {
  const cd = JSON.parse(unb64u(b64).toString("utf8"));
  assert.equal(cd.type, type);
  assert.equal(cd.challenge, expChallenge);
  assert.equal(cd.origin, expOrigin);
  assert.equal(cd.crossOrigin, false);
}

function rpVerifyRegistration(/** @type {any} */ cred, /** @type {{ challenge: string, origin: string, rpId: string }} */ exp) {
  assert.equal(cred.type, "public-key");
  rpClientData(cred.response.clientDataJSON, "webauthn.create", exp.challenge, exp.origin);
  const att = cborDecode(unb64u(cred.response.attestationObject)).value;
  assert.equal(att.get("fmt"), "none");
  const ad = parseAuthData(att.get("authData"));
  assert.ok(ad.rpIdHash.equals(sha256(exp.rpId)), "rpIdHash");
  assert.ok(ad.flags & UP, "user present");
  assert.ok(ad.flags & UV, "user verified");
  assert.ok(ad.flags & AT, "attested data");
  assert.equal(b64u(/** @type {Buffer} */ (ad.credId)), cred.rawId);
  return { id: cred.rawId, key: coseToKey(/** @type {Map<number, any>} */ (ad.cose)), counter: ad.signCount, backedUp: !!(ad.flags & BS) };
}

function rpVerifyAssertion(/** @type {any} */ a, /** @type {{ id: string, key: crypto.KeyObject, counter: number }} */ stored, /** @type {{ challenge: string, origin: string, rpId: string }} */ exp) {
  assert.equal(a.rawId, stored.id);
  rpClientData(a.response.clientDataJSON, "webauthn.get", exp.challenge, exp.origin);
  const ad = unb64u(a.response.authenticatorData);
  const p = parseAuthData(ad);
  assert.ok(p.rpIdHash.equals(sha256(exp.rpId)), "rpIdHash");
  assert.ok(p.flags & UP, "user present");
  assert.ok(p.flags & UV, "user verified");
  // Counter rule: both zero means the authenticator does not count, which is allowed.
  assert.ok(p.signCount === 0 && stored.counter === 0 || p.signCount > stored.counter, "counter");
  const data = Buffer.concat([ad, sha256(unb64u(a.response.clientDataJSON))]);
  return crypto.verify("sha256", data, { key: stored.key, dsaEncoding: "der" }, unb64u(a.response.signature));
}

test("end to end against an independent relying party", () => {
  const exp = { rpId: "northwind.test", origin: "https://app.northwind.test" };
  const regChallenge = challenge();
  const kit = { id: b64u(crypto.randomBytes(32)), name: "kit@northwind.test", displayName: "Kit" };
  const { credential, response } = createCredential({ ...exp, challenge: regChallenge, user: kit, algs: [-7] });
  const stored = rpVerifyRegistration(response, { ...exp, challenge: regChallenge });
  assert.equal(stored.backedUp, true);

  for (let n = 0; n < 3; n++) {
    const c = challenge();
    const { response: a } = getAssertion({ credential, origin: exp.origin, challenge: c });
    assert.ok(rpVerifyAssertion(a, stored, { ...exp, challenge: c }), `sign-in ${n + 1}`);
    assert.equal(a.response.userHandle, kit.id);
  }

  // A replay against a fresh challenge fails, and another passkey's key does not verify.
  const c1 = challenge();
  const { response: a1 } = getAssertion({ credential, origin: exp.origin, challenge: c1 });
  assert.throws(() => rpVerifyAssertion(a1, stored, { ...exp, challenge: challenge() }));
  const other = createCredential({ ...exp, challenge: challenge(), user: kit, algs: [-7] });
  const otherStored = rpVerifyRegistration(other.response, { ...exp, challenge: JSON.parse(unb64u(other.response.response.clientDataJSON).toString()).challenge });
  assert.equal(rpVerifyAssertion(a1, { ...otherStored, id: stored.id }, { ...exp, challenge: c1 }), false);
});
