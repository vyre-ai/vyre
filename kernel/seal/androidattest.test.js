// @ts-check
// Android key attestation (kernel/seal/androidattest.js) and the entry proof built on it and on App Attest (kernel/seal/entry-proof.js). The tests build the documented STRUCTURE under a synthetic root
// (root -> intermediate -> leaf with the key description extension); they prove the code path and every refusal, NOT Google's or Apple's real bytes: both verifiers stay closed until a real fixture passes.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { GOOGLE_ROOTS_PEM, GOOGLE_ROOT_SHA256, ANDROID_ATTEST_VERIFIED, ANDROID_APP_IDS, androidAttestVerifier } from "./androidattest.js";
import { appAttestVerifier, APPATTEST_VERIFIED } from "./appattest.js";
import { entryProof, entryClientData, entryToken, spkiB64 } from "./entry-proof.js";

const sha = (/** @type {any} */ b) => crypto.createHash("sha256").update(b).digest();
const len = (/** @type {number} */ n) => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (/** @type {number} */ t, /** @type {Buffer[]} */ ...c) => { const b = Buffer.concat(c); return Buffer.concat([Buffer.from([t]), len(b.length), b]); };
const oid = (/** @type {string} */ s) => { const a = s.split(".").map(Number), o = [a[0] * 40 + a[1]]; for (const n of a.slice(2)) { const t = [n & 127]; for (let m = n >> 7; m; m >>= 7) t.unshift((m & 127) | 128); o.push(...t); } return tlv(6, Buffer.from(o)); };
const name = (/** @type {string} */ cn) => tlv(0x30, tlv(0x31, tlv(0x30, oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
const ECDSA256 = tlv(0x30, oid("1.2.840.10045.4.3.2"));
const utc = (/** @type {string} */ s) => tlv(0x17, Buffer.from(s));
const int = (/** @type {number} */ n) => tlv(2, Buffer.from([n]));
const enumerated = (/** @type {number} */ n) => tlv(10, Buffer.from([n]));
const spkiOf = (/** @type {crypto.KeyObject} */ k) => /** @type {Buffer} */ (k.export({ type: "spki", format: "der" }));
const pemOf = (/** @type {Buffer} */ d) => `-----BEGIN CERTIFICATE-----\n${d.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
/** A context-specific constructed tag with a number (long form above 30). */
const ctx = (/** @type {number} */ num, /** @type {Buffer} */ body) => num < 31 ? tlv(0xa0 | num, body) : Buffer.concat([Buffer.from([0xbf]), num < 16384 ? Buffer.from([0x80 | (num >> 7), num & 127]) : Buffer.alloc(0), len(body.length), body]);

function cert({ subject, issuer, pub, signKey, ca, ext, from = "260101000000Z", to = "460101000000Z" }) {
  const exts = [];
  if (ca !== undefined) exts.push(tlv(0x30, oid("2.5.29.19"), tlv(1, Buffer.from([255])), tlv(4, ca ? tlv(0x30, tlv(1, Buffer.from([255]))) : tlv(0x30))));
  if (ext) exts.push(tlv(0x30, oid("1.3.6.1.4.1.11129.2.1.17"), tlv(4, ext)));
  const tbs = tlv(0x30, tlv(0xa0, tlv(2, Buffer.from([2]))), tlv(2, crypto.randomBytes(8).map(x => x & 0x7f)), ECDSA256, name(issuer), tlv(0x30, utc(from), utc(to)), name(subject), pub, tlv(0xa3, tlv(0x30, ...exts)));
  const sig = crypto.sign("sha256", tbs, signKey);
  return tlv(0x30, tbs, ECDSA256, tlv(3, Buffer.concat([Buffer.from([0]), sig])));
}

const PKG = "com.example.vyre", APP_CERT = sha("signing cert").toString("hex");
const APPS = [{ pkg: PKG, cert: APP_CERT }];

/** A synthetic Google: a root, an intermediate, and a way to attest a key. */
function world() {
  const ec = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const root = ec(), inter = ec();
  const rootDer = cert({ subject: "Test Root", issuer: "Test Root", pub: spkiOf(root.publicKey), signKey: root.privateKey, ca: true });
  const interDer = cert({ subject: "Test Intermediate", issuer: "Test Root", pub: spkiOf(inter.publicKey), signKey: root.privateKey, ca: true });
  return {
    rootPem: pemOf(rootDer), rootDer, interDer,
    /** The Keystore key and its chain; `o` bends one piece. */
    attest(/** @type {Buffer} */ challenge, /** @type {any} */ o = {}) {
      const key = o.key || ec();
      const appId = tlv(0x30, tlv(0x31, tlv(0x30, tlv(4, Buffer.from(o.pkg || PKG)), int(1))), tlv(0x31, tlv(4, o.certDigest || Buffer.from(APP_CERT, "hex"))));
      const software = tlv(0x30, ...(o.noApp ? [] : [ctx(709, tlv(4, appId))]), ...(o.softwareOrigin ? [ctx(702, int(0))] : []));
      const rot = tlv(0x30, tlv(4, Buffer.alloc(32, 1)), tlv(1, Buffer.from([o.unlocked ? 0 : 255])), enumerated(o.bootState ?? 0), tlv(4, Buffer.alloc(32, 2)));
      const tee = tlv(0x30, ctx(2, int(o.algorithm ?? 3)), ...(o.noOrigin ? [] : [ctx(702, int(o.origin ?? 0))]), ctx(704, rot));
      const level = o.level ?? 2;
      const kd = tlv(0x30, int(o.version ?? 4), enumerated(level), int(4), enumerated(o.kmLevel ?? level), tlv(4, o.challenge || challenge), tlv(4, Buffer.alloc(0)), software, tee);
      const leafDer = cert({ subject: "Test Leaf", issuer: "Test Intermediate", pub: spkiOf(key.publicKey), signKey: o.leafSigner || inter.privateKey, ext: kd, ...(o.dates || {}) });
      const chain = o.reversed ? [this.interDer, leafDer] : [leafDer, this.interDer, this.rootDer];
      return { key, point: spkiOf(key.publicKey).subarray(-65), chain: chain.map(d => d.toString("base64")) };
    },
  };
}
const verifier = (/** @type {any} */ w, extra = {}) => androidAttestVerifier({ dev: true, testRootsPem: [w.rootPem], extraAppIds: APPS, ...extra });

test("the pinned Google roots are the ones published, each asserted by its SHA-256, and release acceptance stays closed", () => {
  assert.equal(GOOGLE_ROOTS_PEM.length, GOOGLE_ROOT_SHA256.length);
  GOOGLE_ROOTS_PEM.forEach((p, i) => assert.equal(sha(new crypto.X509Certificate(p).raw).toString("hex"), GOOGLE_ROOT_SHA256[i]));
  for (const p of GOOGLE_ROOTS_PEM) assert.ok(new Date(new crypto.X509Certificate(p).validTo) > new Date("2027-01-01"), "an expired root is not pinned");
  assert.equal(ANDROID_ATTEST_VERIFIED, false);
  assert.deepEqual(ANDROID_APP_IDS, [], "no app id is pinned until native-core gives the real one");
  assert.equal(androidAttestVerifier().open, false, "a release verifier is closed");
});

test("android key attestation: a chain to a pinned root, this key, this challenge, hardware level, verified boot and a pinned app give an answer; every wrong piece gives null", () => {
  const w = world(), hash = sha("this enrolment"), v = verifier(w);
  const ok = w.attest(hash);
  assert.deepEqual(v.check({ chain: ok.chain }, ok.point, hash), { level: "strongbox" });
  assert.deepEqual(v.check({ chain: w.attest(hash, { level: 1 }).chain }, w.attest(hash, { level: 1 }).point, hash) === null, true, "a different key's point does not match (made twice, two keys)");
  const tee = w.attest(hash, { level: 1 });
  assert.deepEqual(v.check({ chain: tee.chain }, tee.point, hash), { level: "tee" });
  const bad = (/** @type {any} */ o, /** @type {Buffer} */ point = undefined) => { const a = w.attest(hash, o); return v.check({ chain: a.chain }, point || a.point, hash); };
  assert.equal(bad({ challenge: sha("another enrolment") }), null, "the challenge names another enrolment");
  assert.equal(bad({}, w.attest(hash).point), null, "the leaf's key is not the key being enrolled");
  assert.equal(bad({ level: 0 }), null, "software level");
  assert.equal(bad({ kmLevel: 0 }), null, "keymaster in software");
  assert.equal(bad({ bootState: 2 }), null, "unverified boot");
  assert.equal(bad({ unlocked: true }), null, "unlocked device");
  assert.equal(bad({ origin: 1 }), null, "key not generated on the device");
  assert.equal(bad({ noOrigin: true }), null);
  assert.equal(bad({ softwareOrigin: true }), null, "an origin claimed by the software list");
  assert.equal(bad({ algorithm: 1 }), null, "not an EC key");
  assert.equal(bad({ version: 2 }), null, "too old a key description");
  assert.equal(bad({ pkg: "com.evil.app" }), null, "another app");
  assert.equal(bad({ certDigest: sha("another signing cert") }), null, "another signing certificate");
  assert.equal(bad({ noApp: true }), null, "no application id");
  assert.equal(bad({ dates: { to: "250101000000Z" } }), null, "an expired leaf");
  assert.equal(bad({ reversed: true }), null, "a chain that ends at the intermediate, not a root");
  assert.equal(bad({ leafSigner: crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey }), null, "a leaf not signed by the intermediate");
  // a chain to a root nobody pinned
  const other = world(), a = other.attest(hash);
  assert.equal(v.check({ chain: a.chain }, a.point, hash), null, "an untrusted root");
  assert.equal(v.check({ chain: [] }, ok.point, hash), null);
  assert.equal(v.check(null, ok.point, hash), null);
  assert.equal(v.check({ chain: ["not base64 der"] }, ok.point, hash), null);
});

test("android: a verifier that is not in development mode refuses a perfect chain (the release flag is off), and an app that is not pinned is refused", () => {
  const w = world(), hash = sha("h"), a = w.attest(hash);
  assert.equal(androidAttestVerifier({ testRootsPem: [w.rootPem], extraAppIds: APPS }).check({ chain: a.chain }, a.point, hash), null, "extra roots and app ids are honoured only in dev; release is closed");
  assert.equal(androidAttestVerifier({ dev: true, testRootsPem: [w.rootPem] }).check({ chain: a.chain }, a.point, hash), null, "no app id pinned: nothing passes");
});

// ---- the entry proof ----
const offered = (/** @type {any} */ w, /** @type {string} */ publicKey, /** @type {any} */ o = {}) => {
  const point = o.point || crypto.createECDH("prime256v1").generateKeys() && undefined;
  void point;
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const p = spkiOf(key.publicKey).subarray(-65);
  const a = w.attest(entryClientData(o.boundTo || publicKey, p), { key });
  return { publicKey, enclave: p.toString("base64url"), agree: "A", attest: Buffer.from(JSON.stringify({ format: "android-key", chain: a.chain })).toString("base64url") };
};

test("entry proof (android): the attestation names this entry's key and chip key; one made for another entry proves nothing, and nothing is proven while the verifier is closed", async () => {
  const w = world(), pub = Buffer.alloc(32, 5).toString("base64url"), other = Buffer.alloc(32, 6).toString("base64url");
  const proof = entryProof({ android: verifier(w), apple: appAttestVerifier() });
  assert.equal(await proof(offered(w, pub)), true);
  assert.equal(await proof(offered(w, pub, { boundTo: other })), false, "made for another entry's key");
  const e = offered(w, pub);
  assert.equal(await proof({ ...e, publicKey: other }), false, "the same attestation offered for another entry");
  assert.equal(await proof({ ...e, enclave: crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).subarray(-65).toString("base64url") }), false, "another chip key");
  assert.equal(await proof({ publicKey: pub, enclave: e.enclave }), false, "no attestation");
  assert.equal(await proof({ publicKey: pub, attest: e.attest }), false, "no chip key");
  assert.equal(await proof({ ...e, attest: "x".repeat(20000) }), false);
  assert.equal(await proof({ ...e, attest: Buffer.from(JSON.stringify({ format: "unknown" })).toString("base64url") }), false);
  assert.equal(await proof({ ...e, attest: "%%%" }), false);
  assert.equal(await proof(/** @type {any} */ (null)), false);
  // the default verifiers are closed: nothing is proven, so every paired entry stays web
  assert.equal(await entryProof()(e), false);
  assert.equal(APPATTEST_VERIFIED, false);
});

test("entry proof: the hash is the sealing enrol's own (vyre-enrol, a token that is the entry key, the chip key's SPKI)", () => {
  const pub = Buffer.alloc(32, 5).toString("base64url"), point = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]);
  assert.equal(entryToken(pub), `entry:${pub}`);
  assert.equal(entryClientData(pub, point).toString("hex"), sha(`vyre-enrol\nentry:${pub}\n${spkiB64(point)}`).toString("hex"));
  assert.equal(Buffer.from(spkiB64(point), "base64").length, 26 + 65);
});
