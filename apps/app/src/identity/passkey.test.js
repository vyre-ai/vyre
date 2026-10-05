// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as C from "../../../../kernel/identity/chain.js";
import { idDirectory, memorySeen } from "../../../../lib/identity/directory.js";
import { createPasskeyKey, readAttestation, cbor, lowSDer, restorePasskeyKey, passkeyRp, PASSKEY_ORIGIN, WRONG_ORIGIN_SAY } from "./passkey.js";
import { claimIdentityWithPasskey } from "./claim.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FAST = { memoryKiB: 64, passes: 1 };
const NHALF = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n;
const NORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

// ---- a software authenticator: what navigator.credentials.create and .get give back, with the P-256 key in this process ----
const cborBytes = (/** @type {Uint8Array} */ b) => Buffer.concat([head(2, b.length), Buffer.from(b)]);
const cborText = (/** @type {string} */ s) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]);
function head(/** @type {number} */ major, /** @type {number} */ n) { return n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]); }
const cborInt = (/** @type {number} */ n) => (n >= 0 ? head(0, n) : head(1, -1 - n));
const cborMap = (/** @type {Buffer[][]} */ pairs) => Buffer.concat([head(5, pairs.length), ...pairs.flat()]);

/** @param {{ rp?: string, flags?: number, highS?: boolean, refuse?: boolean, createRp?: string }} [o] */
function authenticator(o = {}) {
  const rp = o.rp ?? "app.vyre.run";
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(/** @type {string} */ (jwk.x), "base64url"), y = Buffer.from(/** @type {string} */ (jwk.y), "base64url");
  const credentialId = crypto.randomBytes(16);
  const rpHash = (/** @type {string} */ r) => crypto.createHash("sha256").update(r).digest();
  const seen = { creates: 0, gets: 0 };
  return {
    seen, credentialId,
    async create(/** @type {any} */ opts) {
      seen.creates++;
      if (o.refuse) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      assert.equal(opts.publicKey.rp.id, rp);
      assert.equal(opts.publicKey.authenticatorSelection.userVerification, "required", "the passkey is made with user verification");
      assert.deepEqual(opts.publicKey.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);
      const cose = cborMap([[cborInt(1), cborInt(2)], [cborInt(3), cborInt(-7)], [cborInt(-1), cborInt(1)], [cborInt(-2), cborBytes(x)], [cborInt(-3), cborBytes(y)]]);
      const authData = Buffer.concat([rpHash(o.createRp ?? rp), Buffer.from([o.flags ?? 0x45]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, credentialId.length]), credentialId, cose]);
      const attestationObject = cborMap([[cborText("fmt"), cborText("none")], [cborText("attStmt"), cborMap([])], [cborText("authData"), cborBytes(authData)]]);
      return { response: { attestationObject: new Uint8Array(attestationObject) } };
    },
    async get(/** @type {any} */ opts) {
      seen.gets++;
      if (o.refuse) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      assert.equal(opts.publicKey.rpId, rp);
      assert.equal(opts.publicKey.userVerification, "required");
      assert.deepEqual(Buffer.from(opts.publicKey.allowCredentials[0].id), credentialId);
      const authenticatorData = Buffer.concat([rpHash(rp), Buffer.from([0x05]), Buffer.from([0, 0, 0, seen.gets])]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(opts.publicKey.challenge).toString("base64url"), origin: `https://${rp}`, crossOrigin: false }));
      let signature = crypto.sign("sha256", Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]), privateKey);
      if (o.highS) signature = flipS(signature);
      return { response: { authenticatorData: new Uint8Array(authenticatorData), clientDataJSON: new Uint8Array(clientDataJSON), signature: new Uint8Array(signature) } };
    },
  };
}
/** The high-s twin of a DER ECDSA signature (an authenticator may return either). @param {Buffer} der */
function flipS(der) {
  const rl = der[3], r = der.subarray(4, 4 + rl), sl = der[5 + rl], s = der.subarray(6 + rl, 6 + rl + sl);
  let v = 0n; for (const b of s) v = (v << 8n) | BigInt(b);
  let t = NORDER - v; const out = []; while (t > 0n) { out.unshift(Number(t & 255n)); t >>= 8n; }
  if (out[0] & 0x80) out.unshift(0);
  const body = [0x02, rl, ...r, 0x02, out.length, ...out];
  return Buffer.from([0x30, body.length, ...body]);
}

test("a passkey is a device key: the entry the chain verifies, and each signature is an assertion with user presence and verification", async () => {
  const auth = authenticator();
  const key = await createPasskeyKey({ rp: "app.vyre.run", webauthn: auth });
  assert.equal(key.alg, "webauthn-es256");
  assert.equal(Buffer.from(/** @type {Uint8Array} */ (C.unb64(key.publicKey))).length, 65);
  assert.equal(key.eid, await C.eidOf(key.publicKey));
  const g = await C.makeGenesis({ kind: "person", entry: { eid: key.eid, kind: "device", pub: key.publicKey, alg: key.alg, rp: key.rp }, nonce: "passkey-nonce-1", ts: 1_800_000_000_000, sign: m => key.sign(m) });
  const state = await C.verifyChain([g], { now: 1_800_000_000_001, live: true });
  assert.deepEqual(state.entries.map(e => [e.kind, e.alg, e.rp]), [["device", "webauthn-es256", "app.vyre.run"]]);
  assert.equal(auth.seen.gets, 1, "one assertion for the genesis");
  // a passkey is a FULL device: unlike a key a web page holds, it may change who speaks for the identity
  const other = await (async () => { const k = crypto.generateKeyPairSync("ed25519"); const pub = k.publicKey.export({ format: "der", type: "spki" }).subarray(-32); return { pub: Buffer.from(pub).toString("base64url"), eid: await C.eidOf(pub) }; })();
  const op = await C.makeOp(state, { type: "add", entry: { eid: other.eid, kind: "device", pub: other.pub } }, { by: key.eid, ts: 1_800_000_000_000 + 3_600_000, sign: m => key.sign(m) });
  const next = await C.applyOp(state, op, { now: 1_800_000_000_000 + 3_600_000 });
  assert.equal(next.entries.length, 2, "the passkey added a device");
});

test("an authenticator that returns the high-s twin still verifies (low-s is normalised), and a restored passkey signs the same way", async () => {
  assert.ok(true);
  const auth = authenticator({ highS: true });
  const key = await createPasskeyKey({ rp: "app.vyre.run", webauthn: auth });
  const g = await C.makeGenesis({ kind: "person", entry: { eid: key.eid, kind: "device", pub: key.publicKey, alg: key.alg, rp: key.rp }, nonce: "passkey-nonce-2", ts: 1_800_000_000_000, sign: m => key.sign(m) });
  await C.verifyChain([g], { now: 1_800_000_000_001 });
  const kept = key.keep();
  assert.deepEqual(Object.keys(kept).sort(), ["credentialId", "kind", "publicKey", "rp"], "only what names the credential is kept: no secret");
  const again = await restorePasskeyKey(kept, { webauthn: auth });
  assert.equal(again.eid, key.eid);
  const g2 = await C.makeGenesis({ kind: "person", entry: { eid: again.eid, kind: "device", pub: again.publicKey, alg: again.alg, rp: again.rp }, nonce: "passkey-nonce-3", ts: 1_800_000_000_000, sign: m => again.sign(m) });
  await C.verifyChain([g2], { now: 1_800_000_000_001 });
  // lowSDer on a low-s signature is the identity
  const low = crypto.sign("sha256", Buffer.from("x"), crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
  let v = 0n; for (const b of low.subarray(6 + low[3], 6 + low[3] + low[5 + low[3]])) v = (v << 8n) | BigInt(b);
  if (v <= NHALF) assert.deepEqual(Buffer.from(lowSDer(new Uint8Array(low))), low);
});

test("a passkey made for another site, without user verification, of the wrong kind, or cancelled is refused in plain words", async () => {
  await assert.rejects(createPasskeyKey({ rp: "app.vyre.run", webauthn: authenticator({ createRp: "evil.example" }) }), e => e.code === "wrong_rp");
  await assert.rejects(createPasskeyKey({ rp: "app.vyre.run", webauthn: authenticator({ flags: 0x41 }) }), e => e.code === "no_user_verification", "user verification is required");
  await assert.rejects(createPasskeyKey({ rp: "app.vyre.run", webauthn: authenticator({ refuse: true }) }), e => e.code === "passkey_refused");
  await assert.rejects(createPasskeyKey({ rp: "not a site", webauthn: authenticator() }), e => e.code === "bad_rp");
  await assert.rejects(createPasskeyKey({ rp: "app.vyre.run", webauthn: /** @type {any} */ (null) }).then(() => null, e => { throw e; }), e => ["no_webauthn", "passkey_refused"].includes(e.code) || /credentials/.test(String(e.message)));
  // the reader itself: a cut-short answer is refused, not guessed at
  assert.throws(() => cbor(new Uint8Array([0xa1, 0x61])), e => /** @type {any} */ (e).code === "bad_attestation");
  await assert.rejects(readAttestation(new Uint8Array(cborMap([[cborText("authData"), cborBytes(Buffer.alloc(10))]])), "app.vyre.run"), e => e.code === "bad_attestation");
});

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });
async function standIn(/** @type {any} */ t) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(REPO, "scripts/standin-directory.mjs"), "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  return `http://127.0.0.1:${port}`;
}

test("a name is claimed from a browser with a passkey: the directory takes the passkey genesis and the record it signed, and anyone reads the chain back", { timeout: 60_000 }, async t => {
  const base = await standIn(t);
  const auth = authenticator({ highS: true });
  const made = await claimIdentityWithPasskey({ name: "passalex", password: "four words in a row", base, params: FAST, webauthn: auth });
  assert.match(made.id, /^per_[a-z2-7]{26}$/);
  assert.equal(auth.seen.creates, 1);
  assert.equal(auth.seen.gets, 2, "one assertion for the genesis, one for the claim's record");
  const dir = idDirectory({ base, seen: memorySeen() });
  const r = await dir.resolve("passalex");
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.id, made.id);
  const device = r.state.entries.find((/** @type {any} */ e) => e.kind === "device");
  assert.equal(device.alg, "webauthn-es256");
  assert.equal(device.rp, "app.vyre.run");
  assert.equal(device.held, undefined, "a passkey is not a web-held key");
  assert.ok(!JSON.stringify(r).includes("label"), "and no device name rides the list");
});

import { restoreDeviceKey } from "./keys.js";
test("a kept passkey comes back as a passkey device key, not a seed key", async () => {
  const kept = { kind: "passkey", rp: "app.vyre.run", credentialId: "AQID", publicKey: "BAUG" };
  const key = await restoreDeviceKey(kept);
  assert.deepEqual(key.keep(), kept);
});

test("a passkey is made only on app.vyre.run in a release build, and also on http://localhost in a development one", () => {
  assert.equal(passkeyRp(PASSKEY_ORIGIN), "app.vyre.run");
  assert.equal(passkeyRp("http://localhost:19006"), null, "a release build refuses localhost");
  assert.equal(passkeyRp("http://localhost:19006", { dev: true }), "localhost");
  assert.equal(passkeyRp("http://localhost", { dev: true }), "localhost");
  for (const o of ["https://harlow.vyre.run", "https://app.vyre.run.evil.example", "http://app.vyre.run", "https://app.vyre.run:8443", "https://example.com", "http://localhost.evil.example", "http://127.0.0.1:3000", undefined, ""]) {
    assert.equal(passkeyRp(o, { dev: true }), null, String(o));
    assert.equal(passkeyRp(o), null, String(o));
  }
});

test("on another origin the claim says where to go, before the browser is asked or any key is made", async (t) => {
  const auth = authenticator();
  const prior = Object.getOwnPropertyDescriptor(globalThis, "location");
  t.after(() => { if (prior) Object.defineProperty(globalThis, "location", prior); else delete globalThis.location; });
  for (const origin of ["https://harlow.vyre.run", "https://firm.example.com", "http://localhost:3000"]) {
    Object.defineProperty(globalThis, "location", { value: { origin }, configurable: true, writable: true });
    const prod = process.env.NODE_ENV; process.env.NODE_ENV = "production"; t.after(() => { if (prod === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prod; });
    await assert.rejects(claimIdentityWithPasskey({ name: "wrongorigin", base: "http://127.0.0.1:1", params: FAST, webauthn: auth }), (/** @type {any} */ e) => e.code === "wrong_origin" && e.message === "Open app.vyre.run to create your name.", origin);
  }
  assert.equal(auth.seen.creates, 0, "the browser was never asked");
  assert.equal(WRONG_ORIGIN_SAY, "Open app.vyre.run to create your name.");
});

test("a browser that refuses the passkey for this origin (SecurityError) gets the same words, not 'could not make a passkey'", async () => {
  const wa = { create: async () => { throw Object.assign(new Error("The relying party ID is not a registrable domain suffix"), { name: "SecurityError" }); }, get: async () => { throw new Error("no"); } };
  await assert.rejects(createPasskeyKey({ rp: "app.vyre.run", webauthn: wa }), (/** @type {any} */ e) => e.code === "wrong_origin" && e.message === WRONG_ORIGIN_SAY);
});
