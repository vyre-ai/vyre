import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as N from "../../../../kernel/identity/master.js";
import { createMasterRecord, openMasterRecord, MASTER_KDF } from "./master-web.js";

const FAST = { memoryKiB: 64, passes: 2 };
const PASSWORD = "correct horse battery";
const RECOVERY = "abcd-efgh-ijkl-mnop-qrst-uvwx-yz";
const seed = () => crypto.randomBytes(32).toString("base64url");

test("the work factor is the Node file's", () => {
  assert.deepEqual({ ...MASTER_KDF }, { ...N.MASTER_KDF });
});

test("a record made here opens with kernel/identity/master.js, by password and by recovery key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mw-"));
  const privateKey = seed(), agreePrivate = seed();
  const rec = await createMasterRecord({ username: "alex", id: "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", password: PASSWORD, recoveryCode: RECOVERY, privateKey, agreePrivate, kdf: FAST });
  fs.mkdirSync(path.join(root, "identity"), { recursive: true });
  fs.writeFileSync(N.masterPath(root), JSON.stringify(rec));
  const file = path.join(root, "spaces", "identity.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: rec.id, sealed: true }));
  assert.deepEqual(N.unlockMaster({ root, password: PASSWORD, identityFile: file }), { unlocked: true, username: "alex", id: rec.id });
  N.lockMaster(file);
  assert.equal(N.unlockMaster({ root, recoveryCode: RECOVERY, identityFile: file }).unlocked, true);
  N.lockMaster(file);
});

test("a record made by kernel/identity/master.js opens here, and a wrong secret is refused with the codes the screens word", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mw-"));
  const privateKey = seed();
  const file = path.join(root, "spaces", "identity.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", name: "blair", privateKey }));
  N.createMaster({ root, username: "blair", id: "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", password: PASSWORD, recoveryCode: RECOVERY, privateKeyB64: privateKey, agreePrivateB64: null, kdf: { ...FAST, pure: true }, identityFile: file });
  const rec = JSON.parse(fs.readFileSync(N.masterPath(root), "utf8"));
  assert.equal((await openMasterRecord(rec, { password: PASSWORD })).privateKey, privateKey);
  assert.equal((await openMasterRecord(rec, { recovery: RECOVERY.toUpperCase() })).privateKey, privateKey);
  await assert.rejects(() => openMasterRecord(rec, { password: "zebra quartz mango pillow" }), (e) => e.code === "bad_password");
  await assert.rejects(() => openMasterRecord(rec, { recovery: "zzzz-zzzz-zzzz-zzzz-zzzz-zzzz-zz" }), (e) => e.code === "bad_recovery");
  await assert.rejects(() => openMasterRecord(rec, { password: "short" }), (e) => e.code === "weak_password");
  await assert.rejects(() => openMasterRecord(null, { password: PASSWORD }), (e) => e.code === "no_identity");
});
