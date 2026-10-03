// @ts-check
// Reset with wipe, the vault side: the device key is destroyed first, then every vault row and file; a fresh vault on the same folder holds nothing and makes a new key.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { wipeHome } from "./wipe-host.js";

test("Vault.wipe: key gone first, rows and files gone, the old key file's bytes are not left, and a fresh vault is empty", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-wipe-")), db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const dir = path.join(home, "vault"), mk = () => new Vault({ db, dir, config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let v = mk();
  await v.put({ name: "note", kind: "secret", fields: { value: "fixture-wipe-value-aaaa1111" } }, "cli");
  const keyBefore = fs.readFileSync(path.join(dir, "key"), "utf8");
  assert.ok(db.prepare("SELECT COUNT(*) n FROM vault_items").get().n >= 1);
  const r = await v.wipe();
  assert.equal(r.wiped, true); assert.ok(r.tables > 5);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM vault_items").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM vault_audit").get().n, 0);
  await assert.rejects(v.key(), /stopping/);
  v = mk();
  assert.equal(v.list().items.length, 0);
  await v.key();
  assert.notEqual(fs.readFileSync(path.join(dir, "key"), "utf8"), keyBefore, "a new key");
  await v.stop();
});

test("wipeHome: vault and sealing folder both destroyed, keys first, counts returned", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-wipeh-")), dbp = path.join(home, "vyre.db"), db = open(dbp);
  migrate(db, "vault", MIGRATIONS);
  const config = { name: "harlow-box", vault: { keystore: "file" } }, dir = path.join(home, "vault"), seal = path.join(home, "seal");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const v = new Vault({ db, dir, config, emit: () => {}, log: () => {} });
  await v.put({ name: "note", kind: "secret", fields: { value: "fixture-wipe-value-bbbb2222" } }, "cli");
  await v.stop(); db.close();
  fs.mkdirSync(seal, { recursive: true }); fs.writeFileSync(path.join(seal, "master.key"), "00".repeat(32)); fs.mkdirSync(path.join(seal, "values"));
  const r = await wipeHome({ db: dbp, vaultDir: dir, sealDir: seal, config });
  assert.equal(r.vault.keys_destroyed, true); assert.equal(r.seal.master_destroyed, true);
  assert.deepEqual(fs.readdirSync(dir), []); assert.deepEqual(fs.readdirSync(seal), []);
});
