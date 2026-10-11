// @ts-check
// A member's own AI key (G03): private to the identity that put it, not in the vault's items, not in a backup or a restore, released only to its owner. Every value here is made up.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { MemberKeys, MEMBER_KEYS_MIGRATION } from "./member-keys.js";
import { backup, restore } from "./backup.js";
import { SCRATCH } from "../../test/scratch.mjs";

const FAST = { params: { N: 1 << 12, r: 8, p: 1 } };
const PASS = "tangerine-orbit-7Q-harbor";
const BOB = "per_" + "b".repeat(26), EVE = "per_" + "e".repeat(26), OWNER = "per_" + "o".repeat(26);

function makeVault(t, name) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-memberkeys-"));
  const db = open(path.join(home, "vyre.db"));
  t.after(() => { try { db.close(); } catch {} fs.rmSync(home, { recursive: true, force: true }); });
  migrate(db, "vault", [...MIGRATIONS, MEMBER_KEYS_MIGRATION]);
  const dir = path.join(home, "vault");
  const vault = new Vault({ db, dir, config: { name, vault: { keystore: "file" } }, emit: () => {} });
  vault.memberKeys = new MemberKeys(vault);
  return { home, db, dir, vault };
}
const secret = () => `sk-fixture-${crypto.randomBytes(14).toString("hex")}`;

test("a member's key is theirs: listed, owned and removed by that identity only, and its value is released to no one else", async t => {
  const { vault, dir } = makeVault(t, "a");
  const key = secret();
  const put = await vault.memberKeys.put(BOB, { label: "Bob's key", kind: "api-key", value: key });
  assert.match(put.item, /^member:mk_[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(put).includes(key), "the answer carries no value");
  assert.deepEqual(vault.memberKeys.list(BOB).map(k => k.label), ["Bob's key"]);
  assert.deepEqual(vault.memberKeys.list(EVE), [], "another member sees none");
  assert.deepEqual(vault.memberKeys.list(OWNER), [], "nor does the owner");
  assert.equal(vault.memberKeys.owns(BOB, put.id), true);
  assert.equal(vault.memberKeys.owns(EVE, put.id), false);
  assert.equal(vault.memberKeys.owns(OWNER, put.id), false);
  assert.equal(await vault.memberKeys.release(BOB, put.id), key, "released to its owner");
  await assert.rejects(() => vault.memberKeys.release(EVE, put.id), { code: "not_found" });
  await assert.rejects(() => vault.memberKeys.release(OWNER, put.id), { code: "not_found" });
  assert.throws(() => vault.memberKeys.remove(EVE, put.id), { code: "not_found" });
  assert.throws(() => vault.memberKeys.remove(OWNER, put.id), { code: "not_found" });
  // it is sealed on disk, and the vault's own items do not list it
  const files = (/** @type {string} */ d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of files(dir)) assert.ok(!fs.readFileSync(f).toString("latin1").includes(key), `${f} holds no plaintext`);
  assert.equal(vault.list({}).items.some((/** @type {any} */ i) => /member/.test(i.name)), false, "the vault's list does not show it");
  vault.memberKeys.remove(BOB, put.id);
  await assert.rejects(() => vault.memberKeys.release(BOB, put.id), { code: "not_found" }, "removed means gone: the account needs attention");
});

test("the owner's recovery code never opens a member's key: it is in no backup and no restore", async t => {
  const a = makeVault(t, "a");
  const key = secret();
  await a.vault.put({ name: "owner-key", kind: "api-key", fields: { value: "fixture-owner-Zq81vXr2Lm0pWn" } }, "cli");
  const put = await a.vault.memberKeys.put(BOB, { label: "Bob's key", kind: "api-key", value: key });
  const blob = await backup(a.vault, PASS, FAST);
  assert.ok(!blob.includes(key) && !blob.includes(put.id), "the backup file names no member key");
  const b = makeVault(t, "b");
  await restore(b.vault, blob, PASS, { mode: "merge" });
  assert.equal(b.vault.list({}).items.some((/** @type {any} */ i) => i.name === "owner-key"), true, "the owner's own item is restored");
  assert.deepEqual(b.vault.memberKeys.list(BOB), [], "a restore brings back no member key: the member adds it again");
  await assert.rejects(() => b.vault.memberKeys.release(BOB, put.id), { code: "not_found" });
});

test("a key must look like a key, be one of the two kinds, and belong to someone", async t => {
  const { vault } = makeVault(t, "a");
  await assert.rejects(() => vault.memberKeys.put("", { kind: "api-key", value: secret() }), { code: "denied" });
  await assert.rejects(() => vault.memberKeys.put(BOB, { kind: "password", value: secret() }), { code: "bad_input" });
  await assert.rejects(() => vault.memberKeys.put(BOB, { kind: "api-key", value: "short" }), { code: "bad_input" });
  await assert.rejects(() => vault.memberKeys.put(BOB, { kind: "api-key", value: "has a space inside it xx" }), { code: "bad_input" });
});

test("a sealed copy swapped between two members' keys is refused", async t => {
  const { vault, dir } = makeVault(t, "a");
  const a = await vault.memberKeys.put(BOB, { kind: "api-key", value: secret() });
  const b = await vault.memberKeys.put(EVE, { kind: "setup-token", value: secret() });
  const fa = path.join(dir, "items", `${a.id}.json`), fb = path.join(dir, "items", `${b.id}.json`);
  const found = fs.readdirSync(path.join(dir, "items")).filter(f => f.includes(a.id) || f.includes(b.id));
  assert.equal(found.length, 2, `each key has a sealed file: ${found.join(", ")}`);
  const pa = path.join(dir, "items", found.find(f => f.includes(a.id))), pb = path.join(dir, "items", found.find(f => f.includes(b.id)));
  const tmp = fs.readFileSync(pa);
  fs.writeFileSync(pa, fs.readFileSync(pb));
  fs.writeFileSync(pb, tmp);
  void fa; void fb;
  await assert.rejects(() => vault.memberKeys.release(BOB, a.id), { code: "not_found" });
  await assert.rejects(() => vault.memberKeys.release(EVE, b.id), { code: "not_found" });
});
