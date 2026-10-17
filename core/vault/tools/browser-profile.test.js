// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../../test/scratch.mjs";
import { TEST_KDF } from "../testing.js";
import { PeopleVaults } from "../people.js";
import { register } from "./browser-profile.js";
import { MEMBER_BROWSER_PROFILE_KEY, AGENT_BROWSER_PROFILE_KEY } from "../../../lib/browser-profile.js";
import { open } from "../../store/index.js";
import { Vault, MIGRATIONS } from "../vault.js";
import { migrate } from "../../store/index.js";

const BOB = "per_" + "b".repeat(26);
const EVE = "per_" + "e".repeat(26);
const PW = "long-enough-master-password";

test("vault.person.browser-profile-key: computers only; auto-creates when unlocked; locked refuses with unlock detail", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-bprof-key-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const people = new PeopleVaults({ dir: home, testKdf: TEST_KDF });
  t.after(() => people.close());
  const bobSk = (await people.create(BOB, { password: PW })).secretKey;
  const eveSk = (await people.create(EVE, { password: PW })).secretKey;
  const vaultDir = path.join(home, "space-vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: vaultDir, config: { vault: { keystore: "file" } }, emit: () => {}, log: () => {}, testKdf: TEST_KDF });
  await vault.key();
  /** @type {Record<string, Function>} */
  const tools = {};
  register({
    people,
    vault,
    internal: (name, _d, _i, run) => { tools[name] = run; },
  });
  const personRun = tools["vault.person.browser-profile-key"];
  await assert.rejects(() => personRun({ person: BOB }, { caller: "module:glass" }), /computers module/);
  people.lock(BOB);
  await assert.rejects(
    () => personRun({ person: BOB }, { caller: "module:computers" }),
    (e) => e.code === "locked" && e.detail && e.detail.unlock === "vault.me.account.unlock",
  );
  await people.unlock(BOB, { password: PW, secretKey: bobSk });
  const bob = await personRun({ person: BOB }, { caller: "module:computers" });
  assert.match(bob.key, /^[0-9a-f]{64}$/i);
  const bob2 = await personRun({ person: BOB }, { caller: "module:computers" });
  assert.equal(bob2.key, bob.key, "second call returns the same key");
  await people.unlock(EVE, { password: PW, secretKey: eveSk });
  const eve = await personRun({ person: EVE }, { caller: "module:computers" });
  assert.notEqual(eve.key, bob.key);
});

test("vault.space.browser-profile-key: auto-creates when unlocked; locked refuses with vault_locked", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-bprof-space-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const people = new PeopleVaults({ dir: home, testKdf: TEST_KDF });
  t.after(() => people.close());
  const vaultDir = path.join(home, "space-vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: vaultDir, config: { vault: { keystore: "file" } }, emit: () => {}, log: () => {}, testKdf: TEST_KDF });
  await vault.key();
  const sk = (await vault.createAccount({ password: PW })).secretKey;
  /** @type {Record<string, Function>} */
  const tools = {};
  register({ people, vault, internal: (name, _d, _i, run) => { tools[name] = run; } });
  const spaceRun = tools["vault.space.browser-profile-key"];
  await assert.rejects(() => spaceRun({}, { caller: "module:glass" }), /computers module/);
  vault.lockAccount("test");
  await assert.rejects(
    () => spaceRun({}, { caller: "module:computers" }),
    (e) => e.code === "vault_locked" && e.detail && e.detail.unlock === "vault.account.unlock",
  );
  await vault.unlockAccount({ password: PW, secretKey: sk });
  const a = await spaceRun({}, { caller: "module:computers" });
  assert.match(a.key, /^[0-9a-f]{64}$/i);
  assert.equal(vault.row(AGENT_BROWSER_PROFILE_KEY).name, AGENT_BROWSER_PROFILE_KEY);
  const b = await spaceRun({}, { caller: "module:computers" });
  assert.equal(b.key, a.key);
  void MEMBER_BROWSER_PROFILE_KEY;
});
