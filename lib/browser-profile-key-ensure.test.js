// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../test/scratch.mjs";
import { TEST_KDF } from "../core/vault/testing.js";
import { PeopleVaults } from "../core/vault/people.js";
import { ensureMemberBrowserProfileKey, ensureAgentBrowserProfileKey } from "./browser-profile-key-ensure.js";
import { MEMBER_BROWSER_PROFILE_KEY, AGENT_BROWSER_PROFILE_KEY } from "./browser-profile.js";
import { open, migrate } from "../core/store/index.js";
import { Vault, MIGRATIONS } from "../core/vault/vault.js";

const PW = "long-enough-master-password";
const BOB = "per_" + "b".repeat(26);

test("ensureMemberBrowserProfileKey: creates once; locked throws locked with unlock tool", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-ensure-member-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const people = new PeopleVaults({ dir: home, testKdf: TEST_KDF });
  t.after(() => people.close());
  const sk = (await people.create(BOB, { password: PW })).secretKey;
  const k1 = await ensureMemberBrowserProfileKey(people, BOB);
  assert.match(k1, /^[0-9a-f]{64}$/i);
  const listed = await people.list(BOB);
  assert.ok(listed.items.some(i => i.name === MEMBER_BROWSER_PROFILE_KEY));
  assert.equal(await ensureMemberBrowserProfileKey(people, BOB), k1);
  people.lock(BOB);
  await assert.rejects(
    () => ensureMemberBrowserProfileKey(people, BOB),
    (e) => e.code === "locked" && e.detail.unlock === "vault.me.account.unlock",
  );
  await people.unlock(BOB, { password: PW, secretKey: sk });
  assert.equal(await ensureMemberBrowserProfileKey(people, BOB), k1);
});

test("ensureAgentBrowserProfileKey: creates once; locked throws vault_locked", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-ensure-agent-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vaultDir = path.join(home, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: vaultDir, config: { vault: { keystore: "file" } }, emit: () => {}, log: () => {}, testKdf: TEST_KDF });
  await vault.key();
  const sk = (await vault.createAccount({ password: PW })).secretKey;
  const k1 = await ensureAgentBrowserProfileKey(vault);
  assert.match(k1, /^[0-9a-f]{64}$/i);
  assert.equal(await ensureAgentBrowserProfileKey(vault), k1);
  assert.ok(vault.row(AGENT_BROWSER_PROFILE_KEY));
  vault.lockAccount("test");
  await assert.rejects(
    () => ensureAgentBrowserProfileKey(vault),
    (e) => e.code === "vault_locked" && e.detail.unlock === "vault.account.unlock",
  );
  await vault.unlockAccount({ password: PW, secretKey: sk });
  assert.equal(await ensureAgentBrowserProfileKey(vault), k1);
});
