// @ts-check
// Touch ID unlock of the personal vault (ADR 0006 decision 2), with the fake enclave helper:
// no test here ever shows a biometric dialog. The fake's "enclave key" is an ordinary P-256 key,
// so these tests check the Node side (the wrap, the files, the refusals), not the enclave.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Helper } from "./mac/helper.js";
import { writeFakes } from "./mac/fakes.js";
import { TEST_KDF } from "./testing.js";
import { SCRATCH } from "../../test/scratch.mjs";

const PASSWORD = `fixture-pw-${crypto.randomBytes(12).toString("hex")}`;

function setup(t, enclaveMode = "ok") {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-touchid-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const events = [];
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), testKdf: TEST_KDF });
  const f = writeFakes(path.join(tmp, "fakes"), { enclaveMode });
  vault.enclave = new Helper({ name: "enclave", dir: path.join(tmp, "helpers"), command: f.helpers.enclave });
  return { tmp, db, vault, events, f };
}

test("touch id: enroll with the password, then unlock with no password", async t => {
  const { vault, db, f, tmp } = setup(t);
  const pw = `fixture-mail-${crypto.randomBytes(8).toString("hex")}`;
  const made = await vault.createAccount({ password: PASSWORD });
  await vault.put({ name: "mail-login", kind: "login", fields: { username: "alex@example.com", password: pw } }, "cli");
  assert.deepEqual(vault.accountStatus(), { account: true, unlocked: true, touchid: false, acct: made.acct });
  await assert.rejects(vault.unlockAccount({ method: "touchid" }), /not set up on this Mac/);
  await assert.rejects(vault.enrollTouchId({ password: "fixture-wrong-password" }), /does not open/);
  assert.deepEqual(await vault.enrollTouchId({ password: PASSWORD }), { enrolled: true });
  assert.equal(vault.accountStatus().touchid, true);

  vault.lockAccount();
  await assert.rejects(vault.fields(vault.row("mail-login")), e => /** @type {any} */ (e).code === "locked");
  assert.equal((await vault.unlockAccount({ method: "touchid" })).method, "touchid");
  assert.equal((await vault.fields(vault.row("mail-login"))).password, pw);
  // The person read a reason, and nothing secret went over argv or into the file.
  assert.deepEqual(fs.readFileSync(f.state.enclave, "utf8").trim().split("\n").map(l => JSON.parse(l)), [{ reason: "unlock your personal vault" }]);
  const file = fs.readFileSync(path.join(vault.dir, "touchid.json"), "utf8");
  for (const s of [PASSWORD, pw, made.secretKey]) assert.ok(!file.includes(s));
  assert.equal(fs.statSync(path.join(vault.dir, "touchid.json")).mode & 0o077, 0);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM vault_audit").all()).includes(PASSWORD));
  void tmp;
});

test("touch id: a refused dialog, a changed wrap and another account's file all fail in words", async t => {
  const { vault, db, tmp } = setup(t, "refuse");
  await vault.createAccount({ password: PASSWORD });
  await vault.enrollTouchId({ password: PASSWORD });
  vault.lockAccount();
  await assert.rejects(vault.unlockAccount({ method: "touchid" }), /Touch ID was not confirmed/);
  assert.ok(db.prepare("SELECT * FROM vault_audit WHERE action='account-unlock' AND ok=0").all().some(r => r.why === "touch id refused"));
  assert.equal(vault.pvk, null);

  // A working enclave, but the stored wrap was swapped for one made to another key.
  const ok = writeFakes(path.join(tmp, "fakes-ok"));
  vault.enclave = new Helper({ name: "enclave", dir: path.join(tmp, "helpers"), command: ok.helpers.enclave });
  const file = path.join(vault.dir, "touchid.json");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const other = crypto.createECDH("prime256v1"); other.generateKeys();
  fs.writeFileSync(file, JSON.stringify({ ...rec, blob: other.getPrivateKey().toString("base64") }));
  await assert.rejects(vault.unlockAccount({ method: "touchid" }), /does not open/);
  fs.writeFileSync(file, JSON.stringify({ ...rec, acct: "ZZZZZZ" }));
  await assert.rejects(vault.unlockAccount({ method: "touchid" }), /not set up/);
  // The password still works whatever happened to Touch ID.
  assert.equal((await vault.unlockAccount({ password: PASSWORD })).unlocked, true);
});

test("touch id: without a helper (not a Mac) it says so", async t => {
  const { vault } = setup(t);
  vault.enclave = null;
  await vault.createAccount({ password: PASSWORD });
  await assert.rejects(vault.enrollTouchId({ password: PASSWORD }), /needs a Mac/);
});

test("touch id: the real enclave helper builds, is hash-checked and answers `available` (no dialog)", { skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/swiftc") }, async t => {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-enclave-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { enclaveCall } = await import("./touchid.js");
  const r = await enclaveCall(new Helper({ name: "enclave", dir: path.join(tmp, "helpers") }), { op: "available" });
  assert.equal(r.ok, true);
  assert.equal(typeof r.available, "boolean");
});
