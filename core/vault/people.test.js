// @ts-check
// core/vault/people.js: a vault for each person, sealed so the server cannot open it. Items need the person's own unlock; the Secret Key is never kept on the server.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { TEST_KDF } from "./testing.js";
import { PeopleVaults } from "./people.js";

const BOB = "per_" + "b".repeat(26), EVE = "per_" + "e".repeat(26);
const PW = "bob has a long master password";

function rig(/** @type {import("node:test").TestContext} */ t, extra = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-people-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const people = new PeopleVaults({ dir: home, testKdf: TEST_KDF, emit: () => {}, ...extra });
  t.after(() => people.close());
  return { home, people };
}

test("a person's vault: create, lock, unlock with the password and the Secret Key, items round-trip", async t => {
  const { people } = rig(t);
  const made = await people.create(BOB, { password: PW });
  assert.match(made.secretKey, /^V2-/);
  await people.put(BOB, { name: "claude-signin", kind: "ai-signin", fields: { token: "sk-bob" } });
  assert.equal((await people.get(BOB, { name: "claude-signin" })).fields.token, "sk-bob");
  people.lock(BOB);
  await assert.rejects(people.get(BOB, { name: "claude-signin" }), /locked/);
  await assert.rejects(people.unlock(BOB, { password: PW }), /Secret Key/i, "the password alone does not open it");
  await assert.rejects(people.unlock(BOB, { password: "wrong password here!!", secretKey: made.secretKey }));
  await people.unlock(BOB, { password: PW, secretKey: made.secretKey });
  assert.equal((await people.list(BOB)).items.length, 1);
  assert.equal((await people.list(BOB)).items[0].name, "claude-signin");
  assert.ok(!JSON.stringify(await people.list(BOB)).includes("sk-bob"), "a list never carries a value");
});

test("the server keeps ciphertext only: no Secret Key and no plaintext under the person's folder", async t => {
  const { people, home } = rig(t);
  const made = await people.create(BOB, { password: PW });
  await people.put(BOB, { name: "mail", kind: "mail", fields: { token: "plaintext-marker-xyz" } });
  const seen = [];
  (function walk(/** @type {string} */ d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else seen.push(p); } })(home);
  for (const f of seen) {
    const b = fs.readFileSync(f);
    assert.ok(!b.includes("plaintext-marker-xyz"), `${f} holds the value in clear`);
    assert.ok(!b.includes(made.secretKey), `${f} holds the Secret Key`);
    assert.ok(!b.includes("mail"), `${f} names an item`);
  }
  assert.ok(!seen.some(f => path.basename(f) === "secret-key"), "no secret-key file");
});

test("one person's vault is not another's: separate account, separate items, the same password does not cross", async t => {
  const { people } = rig(t);
  const a = await people.create(BOB, { password: PW });
  const b = await people.create(EVE, { password: PW });
  assert.notEqual(a.acct, b.acct);
  await people.put(BOB, { name: "x", kind: "secret", fields: { token: "bobs" } });
  assert.deepEqual((await people.list(EVE)).items, []);
  await assert.rejects(people.get(EVE, { name: "x" }), /no item/);
  people.lock(EVE);
  await assert.rejects(people.unlock(EVE, { password: PW, secretKey: a.secretKey }), "Bob's Secret Key does not open Eve's vault");
});

test("an item file moved into another person's folder does not open", async t => {
  const { people, home } = rig(t);
  await people.create(BOB, { password: PW });
  const b = await people.create(EVE, { password: PW });
  await people.put(BOB, { name: "x", kind: "secret", fields: { token: "bobs" } });
  const find = (/** @type {string} */ id) => { const out = []; (function w(/** @type {string} */ d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (p.includes("me-items")) out.push(p); } })(people.folder(id)); return out; };
  const [src] = find(BOB);
  const dst = path.join(people.folder(EVE), "me-items", path.basename(src));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  assert.deepEqual((await people.list(EVE)).items, [], "a foreign item is skipped, not read");
  void b;
});

test("the lease ends: idle time past the limit locks the vault", async t => {
  let now = 1_000_000;
  const { people } = rig(t, { clock: () => now, idleMs: 1000 });
  await people.create(BOB, { password: PW });
  await people.put(BOB, { name: "x", kind: "secret", fields: { token: "v" } });
  now += 999;
  assert.equal((await people.get(BOB, { name: "x" })).fields.token, "v", "within the limit, and it renews");
  now += 1500;
  await assert.rejects(people.get(BOB, { name: "x" }), /locked/);
});

test("update and remove; bad names and values are refused", async t => {
  const { people } = rig(t);
  await people.create(BOB, { password: PW });
  await people.put(BOB, { name: "x", kind: "secret", fields: { token: "1" } });
  await assert.rejects(people.put(BOB, { name: "x", kind: "secret", fields: { token: "2" } }), /already/);
  await people.update(BOB, { name: "x", fields: { token: "2" } });
  assert.equal((await people.get(BOB, { name: "x" })).fields.token, "2");
  await assert.rejects(people.update(BOB, { name: "nope", fields: { token: "2" } }), /no item/);
  await people.remove(BOB, { name: "x" });
  await assert.rejects(people.get(BOB, { name: "x" }), /no item/);
  await assert.rejects(people.put(BOB, { name: "../etc", kind: "secret", fields: { a: "b" } }), /name/);
  await assert.rejects(people.put(BOB, { name: "ok", kind: "Bad Kind", fields: { a: "b" } }), /kind/);
  await assert.rejects(people.put(BOB, { name: "ok", kind: "secret", fields: { a: 5 } }), /text/);
  await assert.rejects(people.create("../../x", { password: PW }), /person/);
});

test("personalStore: JSON values under a key for one person; locked without a lease; another person never sees them", async t => {
  const { people, home } = rig(t);
  await people.create(BOB, { password: PW });
  await people.create(EVE, { password: PW });
  const bob = people.personalStore(BOB, "spc_x"), eve = people.personalStore(EVE, "spc_x");
  await bob.put("mcp/github", { url: "https://x.example/mcp", token: "t1" });
  await bob.put("mcp/github", { url: "https://x.example/mcp", token: "t2" });
  assert.deepEqual(await bob.get("mcp/github"), { url: "https://x.example/mcp", token: "t2" });
  assert.deepEqual(await bob.list(), [{ key: "mcp/github", value: { url: "https://x.example/mcp", token: "t2" } }]);
  assert.equal(await eve.get("mcp/github"), null);
  assert.deepEqual(await eve.list(), []);
  assert.equal(await bob.get("nope"), null);
  assert.equal(await bob.remove("mcp/github"), true);
  assert.equal(await bob.remove("mcp/github"), false);
  people.lock(BOB);
  await assert.rejects(bob.list(), /locked/);
  assert.throws(() => people.personalStore("../x"), /person/);
  for (const bad of ["../x", "per_/../x", "per_..", "x", "", "per_" + "a".repeat(80)]) assert.throws(() => people.folder(bad), /person/, bad);
  assert.notEqual(people.folder("per_AbC"), people.folder("per_abc"), "case does not merge two people");
  assert.ok(path.resolve(people.folder(BOB)).startsWith(path.resolve(home)), "inside the root");
});

test("a removed member's vault is erased: the next person with the same name starts empty, and the owner's backup folder holds none of it", async t => {
  const { people, home } = rig(t);
  await people.create(BOB, { password: PW });
  await people.put(BOB, { name: "x", kind: "secret", fields: { token: "v" } });
  const folder = people.folder(BOB);
  assert.ok(fs.existsSync(folder));
  people.destroy(BOB);
  assert.ok(!fs.existsSync(folder));
  assert.equal(people.status(BOB).account, false, "a new person with the same id has no account");
  assert.deepEqual(fs.readdirSync(home), ["people"], "nothing else under the people root");
});

test("one person's wrong guesses do not throttle another", async t => {
  const { people } = rig(t);
  const a = await people.create(BOB, { password: PW });
  const b = await people.create(EVE, { password: PW });
  people.lock(BOB); people.lock(EVE);
  for (let i = 0; i < 6; i++) await people.unlock(BOB, { password: "wrong wrong wrong wrong", secretKey: a.secretKey }).catch(() => {});
  await assert.rejects(people.unlock(BOB, { password: PW, secretKey: a.secretKey }), /wait|try again|too many|seconds/i, "Bob is throttled");
  assert.equal((await people.unlock(EVE, { password: PW, secretKey: b.secretKey })).unlocked, true, "Eve is not");
});
