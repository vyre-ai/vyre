// @ts-check
// The keychain helper (ADR 0006 finding 1): the device key and the Secret Key are written with
// an access list naming only the hash-checked helper, and an item the old `security -i` path
// wrote is read once, rewritten through the helper and deleted. Temporary keychains only
// (testing.js); user interaction is off in the helper, so nothing here can show a dialog. The
// access list is read with `security dump-keychain -a`, which shows it without the secret.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { keystore, secretKeyStore, accountFor, keychainWriteCommand, SERVICE } from "./keys.js";
import { Helper } from "./mac/helper.js";
import { tempKeychain, securityRetry } from "./testing.js";
import { SCRATCH } from "../../test/scratch.mjs";

const mac = process.platform === "darwin" && fs.existsSync("/usr/bin/swiftc");

/** The applications trusted to decrypt each item, from the keychain's ACL dump. */
async function decryptApps(keychain) {
  const r = await securityRetry(["dump-keychain", "-a", keychain]);
  const out = [];
  for (const entry of r.out.split(/\n\s*entry \d+:/).slice(1)) {
    if (!/authorizations \(\d+\):[^\n]*\bdecrypt\b/.test(entry)) continue;
    out.push([...entry.matchAll(/\d+: (\/\S+)/g)].map(m => m[1]));
  }
  return out;
}

async function setup(t) {
  const keychain = await tempKeychain(t);
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-kch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = new Helper({ name: "keychain", dir: path.join(dir, "helpers") });
  return { keychain, dir, helper, vaultDir: path.join(dir, "vault") };
}

test("keychain helper: the key is on an access list naming only the helper", { skip: !mac && "macOS with swiftc only" }, async t => {
  const { keychain, helper, vaultDir } = await setup(t);
  const ks = keystore({ dir: vaultDir, kind: "keychain", keychain, helper });
  assert.equal(await ks.load(), null);
  const mk = await ks.create();
  assert.ok((await ks.load()).equals(mk));
  const built = await helper.ensure();
  const bin = built.path;
  const { enclaveCall: call } = await import("./touchid.js");
  const info = await call(helper, { op: "info", service: SERVICE, account: accountFor(vaultDir), keychain, noUI: true });
  assert.deepEqual(info, { ok: true, found: true, comment: `vyre-helper:${built.hash}` }, "the item names the build that wrote it, and info returns no secret");
  const apps = await decryptApps(keychain);
  assert.equal(apps.length, 1);
  assert.deepEqual(apps[0].map(p => fs.realpathSync(p)), [fs.realpathSync(bin)], "only the helper may decrypt; /usr/bin/security is not on the list");
  const sk = secretKeyStore({ dir: vaultDir, kind: "keychain", keychain, helper });
  await sk.put("V2-ABCDEF-AAAAAAAAAAAAAAAAAAAAAAAAAA-AA");
  assert.equal(await sk.read(), "V2-ABCDEF-AAAAAAAAAAAAAAAAAAAAAAAAAA-AA");
  assert.equal((await decryptApps(keychain)).length, 2);
  await ks.destroy();
  assert.equal(await ks.load(), null);
});

test("keychain helper: an item the old security path wrote is moved to the helper and the old one deleted", { skip: !mac && "macOS with swiftc only" }, async t => {
  const { keychain, helper, vaultDir } = await setup(t);
  const hex = crypto.randomBytes(32).toString("hex");
  const { argv, stdin } = keychainWriteCommand({ account: accountFor(vaultDir), hex, keychain });
  await new Promise((resolve, reject) => {
    const p = execFile("security", argv, e => (e ? reject(e) : resolve(undefined)));
    p.stdin?.end(stdin);
  });
  assert.equal((await decryptApps(keychain))[0].some(p => p.endsWith("/security")), true, "the old path trusts /usr/bin/security");
  const ks = keystore({ dir: vaultDir, kind: "keychain", keychain, helper });
  assert.equal((await ks.load()).toString("hex"), hex);
  const apps = await decryptApps(keychain);
  assert.equal(apps.length, 1, "one item: the old one is gone");
  assert.ok(!apps[0].some(p => p.endsWith("/security")));
  assert.equal((await ks.load()).toString("hex"), hex, "and it reads through the helper from now on");
  void SERVICE;
});

test("keychain helper: an item a gone build wrote is refused with the migrate-key path, and nothing tries to read it", { skip: !mac && "macOS with swiftc only" }, async t => {
  const { keychain, helper, vaultDir } = await setup(t);
  const { enclaveCall: call } = await import("./touchid.js");
  // Written by this build but labelled as another, as a build that has since been deleted would have.
  const w = await call(helper, { op: "write", service: SERVICE, account: accountFor(vaultDir), keychain, noUI: true, secret: crypto.randomBytes(32).toString("hex"), helper: "0".repeat(64) });
  assert.equal(w.ok, true);
  const ks = keystore({ dir: vaultDir, kind: "keychain", keychain, helper });
  await assert.rejects(ks.load(), /written by a helper build that is gone; run vyre vault migrate-key/);
});
