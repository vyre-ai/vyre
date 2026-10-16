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
import { createMaster, TEST_KDF, serverVaultKey } from "../../kernel/identity/master.js";
import { openVaultKey } from "../../kernel/identity/vault-at-rest.js";
import { newRecoveryCode } from "../../kernel/identity/code.js";
import { clearPersonal, currentPersonalKey, forgetAll, holdPersonal } from "../../kernel/identity/holder.js";

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
  const made = serverVaultKey(root);
  assert.ok(made && made.length === 32);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
  const sealed = openVaultKey(root);
  assert.ok(sealed && sealed.equals(made));
  sealed.fill(0);
  assert.equal(fs.readFileSync(path.join(root, "vault", "server-wrap.json"), "utf8").includes(made.toString("hex")), false);
  master(root, Buffer.from(made));
  assert.ok(currentPersonalKey()?.equals(made));
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
  clearPersonal();
  await vault.put({ name: "northwind", kind: "secret", fields: { value: "in-the-air-9f3a" } }, "cli");
  const row = /** @type {any} */ (vault.db.prepare("SELECT * FROM vault_items WHERE name = ?").get("northwind"));
  vault.lock();
  assert.equal(currentPersonalKey(), null);
  const body = await vault.open(row);
  assert.equal(body.fields.value, "in-the-air-9f3a");
  fs.writeFileSync(path.join(root, "vault", "key"), `${"ab".repeat(32)}\n`, { mode: 0o600 });
  vault.lock();
  const again = await vault.open(row);
  assert.equal(again.fields.value, "in-the-air-9f3a");
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false, "a planted plaintext key is dropped once a master record exists");
  fs.writeFileSync(path.join(root, "vault", "server-wrap.json"), "{}\n");
  holdPersonal(Buffer.from(made));
  vault.lock();
  const repaired = await vault.open(row);
  assert.equal(repaired.fields.value, "in-the-air-9f3a");
  const back = openVaultKey(root);
  assert.ok(back && back.equals(made));
  back.fill(0);
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
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
  const wrapBefore = fs.existsSync(path.join(root, "vault", "server-wrap.json")) ? fs.readFileSync(path.join(root, "vault", "server-wrap.json")) : null;
  master(root, crypto.randomBytes(32));
  clearPersonal();
  const wrapAfter = fs.readFileSync(path.join(root, "vault", "server-wrap.json"));
  await assert.rejects(vault.key(), (e) => /** @type {any} */ (e).code === "locked" && /does not open this vault/.test(e.message));
  assert.equal(fs.existsSync(path.join(root, "vault", "key")), false);
  assert.equal(fs.readFileSync(path.join(root, "vault", "server-wrap.json")).equals(wrapAfter), true);
  assert.equal(wrapBefore, null);
});
