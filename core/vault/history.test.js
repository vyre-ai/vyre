// @ts-check
// Item history: the last 10 sealed versions per item, what changed (names only, from HMACs),
// reading and copying an old version, reverting, and no value in any row, file name or listing.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS, PERSONAL } from "./vault.js";
import { KEEP, historyPath } from "./history.js";
import { recorded } from "./testing.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = l => `fixture-${l}-${crypto.randomBytes(10).toString("hex")}`;

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-hist-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: () => {}, testKdf: { kdf: "argon2id", m: 256, t: 1, p: 1 } });
  return { vault, db, tmp };
}

test("history: versions list changed field names, old versions open, revert makes a new version", async t => {
  const { vault, db } = setup(t);
  const p1 = fake("p1"), p2 = fake("p2");
  await vault.put({ name: "mail-login", kind: "login", fields: { username: "alex@example.com", password: p1 } }, "cli");
  await vault.put({ name: "mail-login", kind: "login", fields: { username: "alex@example.com", password: p2 } }, "deck");
  await vault.put({ name: "mail-login", kind: "login", fields: { username: "dana@example.com", password: p2, totp: "JBSWY3DPEHPK3PXP" } }, "cli");
  const h = vault.history({ name: "mail-login" });
  assert.deepEqual(h.entries.map(e => [e.version, e.by, e.changed, e.current]), [
    [3, "cli", ["totp", "username"], true],
    [2, "deck", ["password"], false],
    [1, "cli", ["password", "username"], false],
  ]);
  assert.deepEqual(h.versions[1], { ver: 2, at: h.entries[1].at, by: "deck", fields: ["password"] });
  assert.equal(h.passwords.length, 1, "one earlier password");
  assert.deepEqual(vault.history({ name: "mail-login", field: "password" }).entries.map(e => e.version), [2, 1]);
  const r = vault.row("mail-login");
  assert.equal((await vault.versionFields(r, 1)).password, p1);
  assert.equal((await vault.versionFields(r, 3)).password, p2);
  await assert.rejects(vault.versionFields(r, 9), /no version 9/);
  assert.deepEqual(await vault.revert({ name: "mail-login", version: 1 }, "cli"), { name: "mail-login", version: 4, from: 1 });
  assert.equal((await vault.fields(vault.row("mail-login"))).password, p1);
  assert.deepEqual(vault.history({ name: "mail-login" }).entries[0].changed, ["password", "totp", "username"]);
  // Nothing in vyre.db or the listing carries a value, and fh is not a plain hash of one.
  const dump = JSON.stringify([db.prepare("SELECT * FROM vault_history").all(), vault.history({ name: "mail-login" })]);
  for (const v of [p1, p2, crypto.createHash("sha256").update(p1).digest("base64")]) assert.ok(!dump.includes(v));
});

test("history: only the last 10 older versions are kept, and deleting an item drops its history", async t => {
  const { vault, db } = setup(t);
  for (let i = 1; i <= KEEP + 4; i++) await vault.put({ name: "api-key", kind: "api-key", fields: { value: fake(`v${i}`) } }, "cli");
  const r = vault.row("api-key");
  assert.equal(r.ver, KEEP + 4);
  const vers = vault.history({ name: "api-key" }).entries.map(e => e.version);
  assert.equal(vers.length, KEEP + 1);
  assert.equal(Math.min(...vers), 4);
  assert.ok(!fs.existsSync(historyPath(vault.dir, r.id, 3)));
  assert.ok(fs.existsSync(historyPath(vault.dir, r.id, 4)));
  assert.equal(fs.statSync(historyPath(vault.dir, r.id, 4)).mode & 0o077, 0);
  vault.remove({ name: "api-key" }, "cli");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vault_history").get().n, 0);
  assert.ok(!fs.existsSync(path.join(vault.dir, "history", r.id)));
});

test("history: a forged history row is ignored, a swapped old file does not open, a personal version needs the unlock", async t => {
  const { vault, db } = setup(t);
  await vault.put({ name: "note-1", kind: "note", fields: { text: fake("a") } }, "cli");
  await vault.put({ name: "note-1", kind: "note", fields: { text: fake("b") } }, "cli");
  db.prepare("UPDATE vault_history SET changed='[]' WHERE ver=1").run();
  assert.deepEqual(vault.history({ name: "note-1" }).entries.map(e => e.version), [2]);
  const r = vault.row("note-1");
  await assert.rejects(vault.versionFields(r, 1), /no version 1 kept/);

  await vault.createAccount({ password: fake("password-long") });
  await vault.put({ name: "note-1", kind: "note", fields: { text: fake("c") } }, "cli");
  const r2 = vault.row("note-1");
  assert.equal(r2.vault, PERSONAL);
  vault.lockAccount();
  await assert.rejects(vault.versionFields(r2, r2.ver - 1), e => /** @type {any} */ (e).code === "locked");
  // The agent-vault version 2 is still readable while locked, but not from another slot.
  const two = historyPath(vault.dir, r2.id, 2);
  fs.copyFileSync(historyPath(vault.dir, r2.id, 3), two);
  await assert.rejects(vault.versionFields(r2, 2), /does not open/);
});

test("history tools: vault.history is names only for Claude, revert and old-version reveal need presence", async t => {
  const { run, tools } = await recorded(t);
  const p1 = fake("p1");
  await run("vault.put", { name: "site-login", kind: "login", fields: { username: "alex", password: p1 } });
  await run("vault.put", { name: "site-login", kind: "login", fields: { username: "alex", password: fake("p2") } });
  const h = await run("vault.history", { name: "site-login" }, "mcp");
  assert.equal(h.entries.length, 2);
  assert.ok(!JSON.stringify(h).includes(p1));
  assert.ok(tools.get("vault.revert").presence);
  assert.match(await tools.get("vault.reveal").presence.summary({ name: "site-login", version: 1 }), /from version 1/);
  assert.equal((await run("vault.reveal", { name: "site-login", version: 1 })).value, p1);
  assert.equal((await run("vault.revert", { name: "site-login", version: 1 })).version, 3);
});
