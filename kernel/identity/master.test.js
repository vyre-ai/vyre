// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { argon2id } from "./stretch.js";
import { MASTER_KDF, TEST_KDF, createMaster, unlockMaster, lockMaster, migrateLegacy, linkGithub, masterStatus, signinCarry, readMaster } from "./master.js";
import { forgetAll, identityHeld } from "./holder.js";
import { fileIdentityStore } from "../../core/spaces/identity.js";
import { newRecoveryCode } from "./code.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "vyre-master-"));

test("master password: the production Argon2id parameters, and a pinned cheap vector", () => {
  assert.deepEqual({ ...MASTER_KDF }, { memoryKiB: 65536, passes: 3, lanes: 1, tagLength: 32 });
  const tag = argon2id("correct horse battery", Buffer.from("vyre-master-vector"), { memoryKiB: 32, passes: 1, lanes: 1, tagLength: 32, pure: true });
  assert.equal(tag.toString("hex"), "e22200e34a784a950825cd1d8b7ff881fcc3dc6209bddec4d38c51c055db1998");
});

test("master password: the password unwraps, a wrong one does not, and the recovery key does", async () => {
  const root = scratch();
  const dir = path.join(root, "spaces");
  const store = fileIdentityStore(dir);
  const made = await store.generate({ label: "desk" });
  const code = newRecoveryCode();
  const file = path.join(dir, "identity.json");
  const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
  createMaster({
    root, username: "alex", id: made.id, password: "correct horse battery", recoveryCode: code,
    privateKeyB64: legacy.privateKey, agreePrivateB64: legacy.agreePrivate, kdf: TEST_KDF, identityFile: file,
  });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).privateKey, undefined);
  lockMaster(file);
  assert.equal(identityHeld(file), false);
  await assert.rejects(() => store.sign(Buffer.from("hi")), (e) => e.code === "locked");
  assert.throws(() => unlockMaster({ root, password: "wrong horse battery", identityFile: file }), (e) => e.code === "bad_password");
  assert.equal(identityHeld(file), false);
  const opened = unlockMaster({ root, password: "correct horse battery", identityFile: file });
  assert.equal(opened.unlocked, true);
  assert.equal(opened.username, "alex");
  const sig = await store.sign(Buffer.from("hi"));
  assert.equal(sig.length, 64);
  lockMaster(file);
  const viaCode = unlockMaster({ root, recoveryCode: code, identityFile: file });
  assert.equal(viaCode.unlocked, true);
  assert.equal((await store.sign(Buffer.from("hi"))).length, 64);
  const gh = linkGithub(root, { login: "alex-studio", subject: "gh_12345" }, file);
  assert.equal(gh.linked, true);
  lockMaster(file);
  assert.throws(() => linkGithub(root, { login: "other", subject: "gh_99999" }, file), (e) => e.code === "locked");
  assert.equal(identityHeld(file), false, "a GitHub subject does not unwrap the master key");
  const carry = signinCarry(root);
  assert.equal(carry.recoveryWrap, undefined);
  assert.equal(JSON.stringify(carry).includes(readMaster(root).recoveryWrap.ct), false);
  assert.equal(masterStatus(root, file).github, "alex-studio");
  forgetAll();
});

test("migration wraps a 0.5.x identity and leaves the vault key file in place", async () => {
  const root = scratch();
  const dir = path.join(root, "spaces");
  const store = fileIdentityStore(dir);
  await store.generate();
  store.setName("alex");
  const file = path.join(dir, "identity.json");
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.mkdirSync(path.join(root, "vault"), { recursive: true });
  const vaultHex = Buffer.alloc(32, 7).toString("hex");
  fs.writeFileSync(path.join(root, "vault", "key"), vaultHex + "\n", { mode: 0o600 });
  const code = newRecoveryCode();
  const made = migrateLegacy({ root, identityFile: file, password: "correct horse battery", recoveryCode: code, vaultKey: Buffer.from(vaultHex, "hex"), kdf: TEST_KDF });
  assert.equal(made.username, "alex");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.privateKey, undefined);
  assert.equal(after.agreePrivate, undefined);
  assert.equal(after.sealed, true);
  assert.equal(after.publicKey, before.publicKey);
  assert.equal(fs.readFileSync(path.join(root, "vault", "key"), "utf8").trim(), vaultHex);
  lockMaster(file);
  unlockMaster({ root, password: "correct horse battery", identityFile: file });
  assert.equal((await store.sign(Buffer.from("migrated"))).length, 64);
  const { currentPersonalKey } = await import("./holder.js");
  const mk = currentPersonalKey();
  assert.equal(mk && mk.toString("hex"), vaultHex);
  forgetAll();
});
