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
import { createPasskeyKey, readAttestation, cbor, lowSDer, restorePasskeyKey } from "./passkey.js";
import { claimIdentityWithPasskey } from "./claim.js";
import { authenticator, cborBytes, cborText, cborInt, cborMap } from "./soft-authenticator.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FAST = { memoryKiB: 64, passes: 1 };
const NHALF = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n;
const NORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

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
