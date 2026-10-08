// @ts-check
// The app's half of a Mac server's later keys: the enrolment of its presence key, signed by the setup key, in the form vyre-core checks (core/vyre-core/server.js presence.enroll). The proof is
// built here with WebCrypto and checked by the real presence verifier core uses, so the header, the key id, the DER signature and the input hash cannot drift apart.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { coreEnrolProof, withCoreProof, p1363ToDer, presenceKeyId } from "./core-proof.js";
import { startCore, openStore } from "../../../../core/vyre-core/server.js";
import { armFirstKey, fingerprintOf } from "../../../../core/vyre-core/firstkey.js";
import { coreTool } from "../../../../lib/vyre-core-client.js";
import { fingerprint } from "../../../../core/presence/index.js";
import { SCRATCH } from "../../../../test/scratch.mjs";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const pageKey = async () => {
  const kp = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]));
  return { privateKey: kp.privateKey, spki: new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)) };
};

test("the DER of a P1363 signature is what node verifies, for a short r or a high bit too", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  for (let i = 0; i < 60; i++) {
    const msg = Buffer.from(`m${i}`);
    const p1363 = crypto.sign("sha256", msg, { key: privateKey, dsaEncoding: "ieee-p1363" });
    assert.ok(crypto.verify("sha256", msg, { key: publicKey, dsaEncoding: "der" }, Buffer.from(p1363ToDer(new Uint8Array(p1363)))), `signature ${i}`);
  }
  assert.throws(() => p1363ToDer(new Uint8Array(10)), /not a P-256/);
});

test("the key id is the one core gives a key", async () => {
  const k = await pageKey();
  assert.equal(presenceKeyId(k.spki), fingerprint(Buffer.from(k.spki).toString("base64url")));
});

test("a real core, a server's: the setup key is its first key, and the app's own key is then enrolled by this proof (and by no other)", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "cp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const page = await pageKey(), mine = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pageB64 = Buffer.from(page.spki).toString("base64url");
  const myPub = mine.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const opened = openStore(path.join(dir, "data")); armFirstKey(opened.db, /** @type {string} */ (fingerprintOf(pageB64))); opened.db.close();
  const socket = path.join(dir, "c.sock");
  const c = await startCore({ socket, dataDir: path.join(dir, "data"), ownerUid: uid, dev: true, server: true, notModel: () => true });
  t.after(() => c.close());
  c.presence.softwareOk = () => true;
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ header) => coreTool(tool, input, { socket, coreUid: uid, ...(header ? { presence: header } : {}) });
  assert.ok((await call("presence.enroll.first", { kind: "device", name: "setup page", public_key: pageB64, alg: -7 })).data);

  const hello = await withCoreProof({ public_key: myPub, alg: -7, storage: "software" }, { pageKey: page, name: "the test Mac" });
  assert.equal(hello.core_name, "the test Mac");
  const body = { kind: "device", name: hello.core_name, public_key: myPub, alg: -7 };
  const ok = await call("presence.enroll", body, hello.core_proof);
  assert.ok(ok.data && ok.data.id, JSON.stringify(ok));
  assert.equal(c.presence.keys().length, 2);

  // not the key, the name or the tool that was signed
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const h2 = await withCoreProof({ public_key: other, alg: -7 }, { pageKey: page, name: "x" });
  assert.ok((await call("presence.enroll", { ...body, public_key: other }, hello.core_proof)).error, "a proof for another key does not carry");
  assert.ok((await call("presence.enroll", { kind: "device", name: "y", public_key: other, alg: -7 }, h2.core_proof)).error, "nor for another name");
  assert.ok((await call("presence.enroll", { kind: "device", name: "x", public_key: other, alg: -7 }, h2.core_proof)).data, "the right one does");
});

test("with no setup key, or no key to offer, the hello is left as it was", async () => {
  const pk = { public_key: "abc", alg: -7 };
  assert.deepEqual(await withCoreProof(pk, { name: "n" }), pk);
  assert.equal(await withCoreProof(undefined, { pageKey: await pageKey(), name: "n" }), undefined);
});
