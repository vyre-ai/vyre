// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { tempHome } from "../../test/helpers.js";
import { createMaster, TEST_KDF, serverVaultKey, readVaultKeyFile } from "../../kernel/identity/master.js";
import { openVaultKey } from "../../kernel/identity/vault-at-rest.js";
import { newRecoveryCode } from "../../kernel/identity/code.js";
import { clearPersonal, currentPersonalKey, forgetAll, holdPersonal } from "../../kernel/identity/holder.js";
import { installHeldKey } from "./master-root.js";

process.env.VYRE_TEST_MASTER_KDF = "cheap";

/** @param {import("node:test").TestContext} t */
function home(t) {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  t.after(() => { forgetAll(); try { db.close(); } catch { /* closed */ } });
  const vault = new Vault({ db, dir: path.join(root, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  return { root, db, vault };
}

/** @param {string} root @param {Buffer} vaultKey */
function master(root, vaultKey) {
  createMaster({
    root, username: "alex", id: "id_alex", password: "correct horse battery", recoveryCode: newRecoveryCode(),
    privateKeyB64: Buffer.from("a".repeat(32)).toString("base64url"), vaultKey, kdf: TEST_KDF,
  });
}

test("the master key is the vault root, and lending still opens with nobody unlocked", async (t) => {
  const { root, vault } = home(t);
  const plain = path.join(root, "vault", "key");
  // home() made a vault with its plaintext key file, the way a home from before the master password has one.
  const made = serverVaultKey(root);
  assert.ok(made && made.length === 32);
  const fileKey = readVaultKeyFile(plain);
  assert.ok(fileKey && fileKey.equals(made));
  master(root, Buffer.from(made));
  assert.equal(fs.existsSync(plain), false, "making the master password sealed the key and removed the plaintext file");
  assert.ok(openVaultKey(root)?.equals(made), "the sealed copy opens to the same key");
  assert.ok(currentPersonalKey()?.equals(made));
  clearPersonal();
  await vault.put({ name: "northwind", kind: "secret", fields: { value: "in-the-air-9f3a" } }, "cli");
  const row = /** @type {any} */ (vault.db.prepare("SELECT * FROM vault_items WHERE name = ?").get("northwind"));
  vault.lock();
  assert.equal(currentPersonalKey(), null);
  const body = await vault.open(row);
  assert.equal(body.fields.value, "in-the-air-9f3a");
  const held = Buffer.from(made);
  fs.writeFileSync(plain, `${"ab".repeat(32)}\n`, { mode: 0o600 });
  holdPersonal(held);
  vault.lock();
  const again = await vault.open(row);
  assert.equal(again.fields.value, "in-the-air-9f3a");
  assert.equal(fs.existsSync(plain), false, "a plaintext copy that came back is gone once the held key is sealed");
  assert.ok(openVaultKey(root)?.equals(made), "and the sealed copy is the held key, so the two cannot diverge");
});

test("a plaintext vault key left from before the master password is sealed and removed, with a migration that keeps lending working", async (t) => {
  const { root, vault } = home(t);
  const plain = path.join(root, "vault", "key");
  await vault.put({ name: "harlow", kind: "secret", fields: { value: "survives-migration" } }, "cli");
  const row = /** @type {any} */ (vault.db.prepare("SELECT * FROM vault_items WHERE name = ?").get("harlow"));
  const raw = /** @type {Buffer} */ (readVaultKeyFile(plain));
  assert.ok(raw);
  // a master record that was made without sealing (an older build): the plaintext is still there
  createMaster({ root, username: "alex", id: "id_alex", password: "correct horse battery", recoveryCode: newRecoveryCode(), privateKeyB64: Buffer.from("a".repeat(32)).toString("base64url"), kdf: TEST_KDF });
  assert.equal(fs.existsSync(plain), true);
  assert.equal(openVaultKey(root), null);
  clearPersonal();
  vault.lock();
  assert.equal((await vault.open(row)).fields.value, "survives-migration", "still opens");
  assert.equal(fs.existsSync(plain), false, "the plaintext file is removed");
  assert.ok(openVaultKey(root)?.equals(raw), "after the sealed copy opens to the same key");
  vault.lock();
  assert.equal((await vault.open(row)).fields.value, "survives-migration", "and lending works from the sealed copy with nobody unlocked");
  assert.equal(fs.existsSync(plain), false, "no plaintext was made again");
});

test("a master key that does not open the agent vault fails closed and leaves the server copy", async (t) => {
  const { root, vault } = home(t);
  await vault.put({ name: "northwind", kind: "secret", fields: { value: "keep-me" } }, "cli");
  const before = fs.readFileSync(path.join(root, "vault", "key"), "utf8");
  holdPersonal(crypto.randomBytes(32));
  vault.lock();
  await assert.rejects(vault.key(), (e) => /** @type {any} */ (e).code === "locked" && /does not open this vault/.test(e.message));
  assert.equal(fs.readFileSync(path.join(root, "vault", "key"), "utf8"), before);
  clearPersonal();
  fs.rmSync(path.join(root, "vault", "key"));
  master(root, /** @type {any} */ (null));
  clearPersonal();
  await assert.rejects(vault.key(), (e) => /** @type {any} */ (e).code === "locked" && /no server copy/.test(e.message));
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
});

test("installHeldKey puts the held key into a vault that is not open yet and drops plaintext", async (t) => {
  const { root, vault } = home(t);
  const made = crypto.randomBytes(32);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
  master(root, Buffer.from(made));
  assert.equal(vault.vk, null);
  fs.writeFileSync(path.join(root, "vault", "key"), `${made.toString("hex")}\n`, { mode: 0o600 });
  const installed = await installHeldKey(vault);
  assert.deepEqual(installed, { installed: true, plaintext: false });
  assert.ok(vault.vk);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
  await vault.put({ name: "juniper", kind: "secret", fields: { value: "tray-7" } }, "cli");
  const row = /** @type {any} */ (vault.db.prepare("SELECT * FROM vault_items WHERE name = ?").get("juniper"));
  vault.lock();
  clearPersonal();
  assert.equal((await vault.open(row)).fields.value, "tray-7");
});

test("installHeldKey keeps an already open vault and a mismatched key does not replace it", async (t) => {
  const { root, vault } = home(t);
  await vault.put({ name: "northwind", kind: "secret", fields: { value: "keep-open" } }, "cli");
  const raw = Buffer.from(fs.readFileSync(path.join(root, "vault", "key"), "utf8").trim(), "hex");
  const open = vault.vk;
  master(root, raw);
  fs.writeFileSync(path.join(root, "vault", "key"), `${raw.toString("hex")}\n`, { mode: 0o600 });
  const installed = await installHeldKey(vault);
  assert.deepEqual(installed, { installed: true, plaintext: false });
  assert.equal(vault.vk, open);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
  clearPersonal();
  holdPersonal(crypto.randomBytes(32));
  fs.writeFileSync(path.join(root, "vault", "key"), `${"ab".repeat(32)}\n`, { mode: 0o600 });
  await assert.rejects(installHeldKey(vault), (e) => /** @type {any} */ (e).code === "locked");
  assert.equal(vault.vk, open);
  assert.equal(fs.readFileSync(path.join(root, "vault", "key"), "utf8").trim(), "ab".repeat(32));
  clearPersonal();
  await assert.rejects(installHeldKey(vault), (e) => /** @type {any} */ (e).code === "locked" && /Unlock this identity/.test(e.message));
  assert.equal(vault.vk, open);
});
