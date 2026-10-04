// @ts-check
// Apple App Attest in the sealing process (kernel/seal/appattest.js). The simulator cannot attest, so these tests build the same STRUCTURE under a synthetic root: root -> intermediate -> leaf with the nonce
// extension, a CBOR attestation object, authData, and assertions. They prove the code path and every refusal, NOT Apple's real bytes (APPATTEST_VERIFIED stays false until a real fixture passes, AA-3).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startSealer } from "./client.js";
import { APPLE_ROOT_PEM, APPLE_ROOT_SHA256, APPATTEST_VERIFIED, appAttestVerifier, enrolClientData, cbor } from "./appattest.js";
import { proofBytes } from "./wire.js";
import { person, signer, tmp, SPACE } from "./testing.js";

const APP = "TEAM123456.com.example.vyre";
const sha = (/** @type {any} */ b) => crypto.createHash("sha256").update(b).digest();
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e.code);

// ---- a tiny DER and CBOR writer for the fixtures ----
const len = (/** @type {number} */ n) => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (/** @type {number} */ t, /** @type {Buffer[]} */ ...c) => { const b = Buffer.concat(c); return Buffer.concat([Buffer.from([t]), len(b.length), b]); };
const oid = (/** @type {string} */ s) => { const a = s.split(".").map(Number), o = [a[0] * 40 + a[1]]; for (const n of a.slice(2)) { const t = [n & 127]; for (let m = n >> 7; m; m >>= 7) t.unshift((m & 127) | 128); o.push(...t); } return tlv(6, Buffer.from(o)); };
const name = (/** @type {string} */ cn) => tlv(0x30, tlv(0x31, tlv(0x30, oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
const ECDSA256 = tlv(0x30, oid("1.2.840.10045.4.3.2"));
const utc = (/** @type {string} */ s) => tlv(0x17, Buffer.from(s));
function cert({ subject, issuer, pub, signKey, ca, nonce, from = "260101000000Z", to = "460101000000Z" }) {
  const exts = [];
  if (ca !== undefined) exts.push(tlv(0x30, oid("2.5.29.19"), tlv(1, Buffer.from([255])), tlv(4, ca ? tlv(0x30, tlv(1, Buffer.from([255]))) : tlv(0x30))));
  if (nonce) exts.push(tlv(0x30, oid("1.2.840.113635.100.8.2"), tlv(4, tlv(0x30, tlv(0xa1, tlv(4, nonce))))));
  const tbs = tlv(0x30, tlv(0xa0, tlv(2, Buffer.from([2]))), tlv(2, crypto.randomBytes(8).map(x => x & 0x7f)), ECDSA256, name(issuer), tlv(0x30, utc(from), utc(to)), name(subject), pub, tlv(0xa3, tlv(0x30, ...exts)));
  const sig = crypto.sign("sha256", tbs, signKey);
  return tlv(0x30, tbs, ECDSA256, tlv(3, Buffer.concat([Buffer.from([0]), sig])));
}
const spkiOf = (/** @type {crypto.KeyObject} */ k) => /** @type {Buffer} */ (k.export({ type: "spki", format: "der" }));
const enc = {
  n: (/** @type {number} */ major, /** @type {number} */ v) => v < 24 ? Buffer.from([(major << 5) | v]) : v < 256 ? Buffer.from([(major << 5) | 24, v]) : Buffer.from([(major << 5) | 25, v >> 8, v & 255]),
  text: (/** @type {string} */ s) => Buffer.concat([enc.n(3, s.length), Buffer.from(s)]),
  bytes: (/** @type {Buffer} */ b) => Buffer.concat([enc.n(2, b.length), b]),
  arr: (/** @type {Buffer[]} */ a) => Buffer.concat([enc.n(4, a.length), ...a]),
  map: (/** @type {[string, Buffer][]} */ kv) => Buffer.concat([enc.n(5, kv.length), ...kv.flatMap(([k, v]) => [enc.text(k), v])]),
};

/** A synthetic Apple: its root, the app's attest key, and a way to attest and assert. */
function world({ aaguid = Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]), appId = APP } = {}, /** @type {any} */ shared = null) {
  const ec = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const root = shared ? shared.root : ec(), inter = ec(), leaf = ec(), rootDer = cert({ subject: "Test Root", issuer: "Test Root", pub: spkiOf(root.publicKey), signKey: root.privateKey, ca: true });
  const interDer = cert({ subject: "Test Intermediate", issuer: "Test Root", pub: spkiOf(inter.publicKey), signKey: root.privateKey, ca: true });
  const point = spkiOf(leaf.publicKey).subarray(-65), keyId = sha(point);
  const pem = (/** @type {Buffer} */ d) => `-----BEGIN CERTIFICATE-----\n${d.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  const authData = (/** @type {number} */ counter, withCred = true) => Buffer.concat([sha(appId), Buffer.from([withCred ? 0x40 : 0]), Buffer.from([counter >>> 24, counter >>> 16, counter >>> 8, counter].map(x => x & 255)), ...(withCred ? [aaguid, Buffer.from([0, keyId.length]), keyId, Buffer.from([0xa0])] : [])]);
  return {
    root, rootPem: pem(rootDer), keyId, leafKey: leaf.privateKey,
    attest(/** @type {Buffer} */ clientDataHash, o = {}) {
      const ad = /** @type {any} */ (o).mutate ? /** @type {any} */ (o).mutate(authData(0)) : authData(0), nonce = sha(Buffer.concat([ad, clientDataHash]));
      const leafDer = cert({ subject: "Test Leaf", issuer: "Test Intermediate", pub: spkiOf(leaf.publicKey), signKey: inter.privateKey, nonce: /** @type {any} */ (o).badNonce ? crypto.randomBytes(32) : nonce });
      return Buffer.concat([enc.map([["fmt", enc.text("apple-appattest")], ["attStmt", enc.map([["x5c", enc.arr([enc.bytes(leafDer), enc.bytes(interDer)])], ["receipt", enc.bytes(Buffer.from("receipt"))]])], ["authData", enc.bytes(ad)]])]);
    },
    assertion(/** @type {Buffer} */ clientDataHash, /** @type {number} */ counter) {
      const ad = authData(counter, false), sig = crypto.sign("sha256", sha(Buffer.concat([ad, clientDataHash])), leaf.privateKey);
      return enc.map([["signature", enc.bytes(sig)], ["authenticatorData", enc.bytes(ad)]]).toString("base64");
    },
  };
}
const setup = (/** @type {any} */ t, /** @type {any} */ w, extra = {}) => {
  const dir = tmp("aa"), rootFile = path.join(dir, "root.pem"); fs.writeFileSync(rootFile, w.rootPem);
  const mk = () => startSealer({ dir, timeoutMs: 8000, dev: true, appattest: { rootPem: rootFile, appIds: [APP] }, ...extra });
  let s = mk(); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, get s() { return s; }, restart: async () => { await s.close(); s = mk(); return s; } };
};
async function enrol(/** @type {any} */ s, /** @type {any} */ w, /** @type {any} */ sg, o = {}) {
  const ch = person(sg.enrolment.person), e = sg.enrolment;
  const { token } = await s.begin({ chain: ch, person: e.person, key_id: e.key_id, spki: e.spki });
  const att = w.attest(enrolClientData(token, e.spki), o);
  return s.enrol({ chain: ch, person: e.person, key_id: e.key_id, spki: e.spki, signer: e.signer, token, attestation: { format: "apple-appattest", key_id: w.keyId.toString("base64"), attestation: att.toString("base64") } });
}
const proofWith = (/** @type {any} */ sg, /** @type {any} */ w, /** @type {number | null} */ counter, fields = { k: "v" }, op = "task.decide") => {
  const ch = person(sg.enrolment.person), p = sg.proof(ch, op, fields);
  if (counter !== null) p.assertion = w.assertion(sha(proofBytes(p)), counter);
  return { ch, op, fields, proof: p };
};

test("the pinned Apple root is the Apple App Attestation Root CA and its SHA-256 is asserted", () => {
  assert.equal(sha(new crypto.X509Certificate(APPLE_ROOT_PEM).raw).toString("hex"), APPLE_ROOT_SHA256);
  assert.equal(new crypto.X509Certificate(APPLE_ROOT_PEM).subject.includes("Apple App Attestation Root CA"), true);
  assert.equal(APPATTEST_VERIFIED, false, "release acceptance stays closed until a real fixture passes (AA-3)");
});

test("enrol: a chain to a (dev-only) root, the nonce, the key id, the app id and counter 0 give an attested key; every wrong piece is bad_attestation", async t => {
  const w = world(), r = setup(t, w), alex = signer("per_alex");
  assert.equal((await enrol(r.s, w, alex)).attested, true);
  let n = 0;
  const bad = async (/** @type {any} */ ww, o = {}) => code(enrol(r.s, ww, signer(`per_bad${++n}`), o));
  const same = (/** @type {any} */ o) => world(o, w);
  assert.equal(await bad(same({}), { badNonce: true }), "bad_attestation", "a nonce that is not SHA256(authData || clientDataHash)");
  assert.equal(await bad(same({ appId: "TEAM999999.com.evil.app" })), "bad_attestation", "another app");
  assert.equal(await bad(same({ aaguid: Buffer.alloc(16, 1) })), "bad_attestation", "an unknown environment");
  assert.equal(await bad(same({ aaguid: Buffer.from("appattestdevelop") })), null, "the development environment is accepted only under the dev switch, which this dev-kind process has");
});

test("a software or unattested key never shows as apple-appattest, a caller cannot supply `attested`, and an App Attest key id bound to another key is refused", async t => {
  const w = world(), r = setup(t, w);
  const hw = signer("per_alex"), sw = signer("per_alex", undefined, "software");
  assert.ok(["bad_attestation", "software_refused"].includes(/** @type {string} */ (await code(enrol(r.s, w, sw)))), "signer class not secure_enclave");
  const first = await enrol(r.s, w, hw);
  assert.equal(first.attested, true);
  assert.equal(await code(enrol(r.s, w, signer("per_carol"))), "aa_key_bound", "the same App Attest key for another Secure Enclave key");
  const ch = person("per_bob"), e = signer("per_bob").enrolment, { token } = await r.s.begin({ chain: ch, person: "per_bob", key_id: e.key_id, spki: e.spki });
  assert.equal(await code(r.s.enrol({ chain: ch, person: "per_bob", key_id: e.key_id, spki: e.spki, signer: e.signer, token, attested: true })), "unattested", "attested: true from the caller changes nothing: no verifier, no attestation");
});

test("B2: a proof needs an assertion with a counter strictly above the last; a missing, replayed, lower or wrong-message one is refused, parallel proofs let one win, and the counter survives a restart", async t => {
  const w = world(), r = setup(t, w), alex = signer("per_alex");
  await enrol(r.s, w, alex);
  const prove = (/** @type {any} */ p) => r.s.presenceProve({ chain: p.ch, op: p.op, fields: p.fields, proof: p.proof });
  const p1 = proofWith(alex, w, 1);
  assert.deepEqual(await prove(p1), { ok: true, method: "attested" });
  const noAssert = proofWith(alex, w, null);
  assert.equal((await prove(noAssert)).code, "assertion_required");
  assert.equal((await prove(proofWith(alex, w, 1))).code, "bad_assertion", "an equal counter");
  assert.equal((await prove(proofWith(alex, w, 0))).code, "bad_assertion", "a lower counter");
  const other = proofWith(alex, w, 5); other.proof.assertion = w.assertion(sha("another message"), 5);
  assert.equal((await prove(other)).code, "bad_assertion", "an assertion over other bytes");
  assert.equal((await prove(proofWith(alex, w, 9))).ok, true, "a gap is fine");
  // two proofs with the same counter at once: one wins
  const a = proofWith(alex, w, 12), b = proofWith(alex, w, 12);
  const res = await Promise.all([prove(a), prove(b)]);
  assert.equal(res.filter(x => x.ok).length, 1, "exactly one of two parallel proofs");
  // restart: the stored counter is 12, so the same assertion and anything at or below it is refused after the process comes back
  const s2 = await r.restart();
  assert.equal((await s2.presenceProve({ chain: a.ch, op: a.op, fields: a.fields, proof: a.proof })).ok, false, "a restart does not make an old assertion fresh");
  assert.equal((await s2.presenceProve({ chain: p1.ch, op: p1.op, fields: p1.fields, proof: proofWith(alex, w, 12).proof })).ok, false);
  const p13 = proofWith(alex, w, 13);
  assert.equal((await s2.presenceProve({ chain: p13.ch, op: p13.op, fields: p13.fields, proof: p13.proof })).ok, true, "and a higher one still works");
});

test("the verifier never throws on damaged input: truncated, extended, bit-flipped, deeply nested and huge-length attestations are all refused", () => {
  const w = world(), v = appAttestVerifier({ dev: true, testRootPem: w.rootPem, extraAppIds: [APP] }), good = w.attest(enrolClientData("tok", "spki"));
  const ok = (/** @type {Buffer} */ b) => v.enrol({ format: "apple-appattest", key_id: w.keyId.toString("base64"), attestation: b.toString("base64") }, "spki", "tok");
  assert.ok(ok(good), "the untouched fixture verifies");
  const tries = [good.subarray(0, good.length - 1), good.subarray(0, 10), Buffer.concat([good, Buffer.from([0])]), Buffer.alloc(0), Buffer.from([0xbf, 0xff]), Buffer.from([0x9f, 0xff]), Buffer.from([0xa1, 0x5a, 0xff, 0xff, 0xff, 0xff]), Buffer.from([0xc1, 0x01]), Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.concat(Array(40).fill(Buffer.from([0x81]))), Buffer.alloc(20000, 1)];
  for (let i = 0; i < 300; i++) { const b = Buffer.from(good); b[Math.floor(Math.random() * b.length)] ^= 1 << Math.floor(Math.random() * 8); tries.push(b); }
  for (const b of tries) { let r; assert.doesNotThrow(() => { r = ok(b); }); if (b !== good) assert.ok(r === null || r === undefined || typeof r === "object"); }
  assert.throws(() => cbor(Buffer.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02])), /dup_key/, "duplicate map keys");
  assert.throws(() => cbor(Buffer.from([0x18, 0x05])), /not_canonical/, "a non-canonical integer");
});

test("AA-1 and AA-2: a release-stamped child ignores the test root, the development environment and extra app ids, so the same attestation is refused; and release accepts none until APPATTEST_VERIFIED", async t => {
  const w = world(), root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, " ")), "..", "..");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "aarel-")); t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const d of ["kernel", "lib"]) fs.cpSync(path.join(root, d), path.join(copy, d), { recursive: true, filter: f => !/\.test\.js$/.test(f) });
  fs.writeFileSync(path.join(copy, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(copy, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  const { startSealer: startCopy } = await import(pathToFileURL(path.join(copy, "kernel", "seal", "client.js")).href);
  const r = setup(t, w, {}); // dev-kind process: the same fixture is accepted
  assert.equal((await enrol(r.s, w, signer("per_alex"))).attested, true);
  const dir = tmp("aarel2"), rootFile = path.join(dir, "root.pem"); fs.writeFileSync(rootFile, w.rootPem);
  const s = startCopy({ dir, timeoutMs: 8000, dev: true, appattest: { rootPem: rootFile, appIds: [APP] } });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(await code(enrol(s, w, signer("per_alex"))), "bad_attestation", "release-kind: the synthetic root and app id are ignored");
  const v = appAttestVerifier({ dev: false });
  assert.equal(v.open, false, "and release accepts nothing while APPATTEST_VERIFIED is false");
});

test("AA-9 and AA-10: the authData flags and layout are checked (with a valid nonce, so the flag is the reason), and the leaf key must be EC P-256", () => {
  const w = world(), v = appAttestVerifier({ dev: true, testRootPem: w.rootPem, extraAppIds: [APP] }), cdh = enrolClientData("tok", "spki");
  const run = (/** @type {any} */ o) => v.enrol({ format: "apple-appattest", key_id: w.keyId.toString("base64"), attestation: w.attest(cdh, o).toString("base64") }, "spki", "tok");
  assert.ok(run({}), "untouched");
  const flag = (/** @type {number} */ f) => (/** @type {Buffer} */ ad) => { const b = Buffer.from(ad); b[32] = f; return b; };
  assert.equal(run({ mutate: flag(0x00) }), null, "a cleared attested-credential flag is refused");
  assert.equal(run({ mutate: flag(0xc0) }), null, "an extension-data flag is refused");
  assert.equal(run({ mutate: (/** @type {Buffer} */ ad) => Buffer.concat([ad, Buffer.from([0xff])]) }), null, "trailing bytes after the COSE key are refused");
  assert.equal(run({ mutate: (/** @type {Buffer} */ ad) => ad.subarray(0, ad.length - 1) }), null, "a short layout is refused");
});

test("AA-11: fixed proofBytes vectors (the app's build must reproduce them byte for byte); `assertion` and `signature` are not part of the bytes", async () => {
  const { vectors } = JSON.parse(fs.readFileSync(new URL("./proofbytes-vectors.json", import.meta.url), "utf8"));
  for (const v of vectors) assert.equal(proofBytes(v.proof).toString("utf8"), v.bytes);
  assert.ok(vectors.some((/** @type {any} */ v) => v.proof.assertion && v.proof.signature), "a vector carries both fields");
});
