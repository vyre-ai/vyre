// @ts-check
// Reset with wipe where the vault's device key is in the macOS Keychain: the CLI hands wipeHome the keystore's own destroy, the entry is really gone afterwards, and with no way to delete it
// the wipe refuses before touching anything. A temporary keychain only (never the login keychain); runs on the hosted Mac job.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { keystore } from "./keys.js";
import { tempKeychain } from "./testing.js";
import { wipeHome } from "../../lib/vault-wipe.js";

test("wipeHome with a Keychain-held vault key: refused without a way to delete it, and the entry is really deleted with one", { skip: process.platform !== "darwin" && "macOS only" }, async t => {
  const keychain = await tempKeychain(t), home = path.dirname(keychain), vaultDir = path.join(home, "vault");
  fs.mkdirSync(vaultDir, { recursive: true }); fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ vault: { keystore: "keychain" } })); fs.mkdirSync(path.join(home, "seal"), { recursive: true }); fs.writeFileSync(path.join(home, "seal", "master.key"), "00".repeat(32));
  const ks = keystore({ dir: vaultDir, kind: "keychain", keychain });
  await ks.create();
  await assert.rejects(wipeHome({ home }), e => /** @type {any} */ (e).code === "keystore_survives" && /keychain/.test(e.message));
  assert.equal(await ks.exists(), true, "nothing was destroyed by the refusal");
  assert.ok(fs.existsSync(path.join(home, "seal", "master.key")));
  const out = await wipeHome({ home, destroyKeychain: () => ks.destroy() });
  assert.equal(out.vault.keychain_destroyed, true);
  assert.equal(await ks.exists(), false, "the Keychain entry is gone");
  assert.equal(await ks.load(), null);
});
