// @ts-check
// Every fixture here is fictional and inline: example.com hosts, made-up values.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { backup, inspect, restore } from "./backup.js";

// A cheap scrypt cost so the suite runs fast. The default (N=2^17) is checked on its own below.
const FAST = { params: { N: 1 << 12, r: 8, p: 1 } };
const PASS = "tangerine-orbit-7Q-harbor";

const FIXTURES = {
  "example-api": { kind: "api-key", fields: { value: "fixture-api-Zq81vXr2Lm0pWn" }, hosts: ["https://api.example.com"], description: "the example API" },
  "example-login": { kind: "login", fields: { username: "alex@example.com", password: "tr0ub4dor-Hq8!-example" }, url: "https://mail.example.com/login" },
  "example-card": { kind: "card", fields: { number: "4111222233334444", code: "987", holder: "Alex Example" } },
  "example-note": { kind: "note", fields: { text: "recovery-code-kkkk-7777-example" } },
  "example-env": { kind: "env-set", fields: { EXAMPLE_TOKEN: "env-token-Pq3sT9-example", EXAMPLE_SECRET: "env-secret-Wm4bY7-example" } },
};
const VALUES = Object.values(FIXTURES).flatMap(f => Object.values(f.fields)).filter(v => v.length > 6);

function makeVault(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-backup-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const dir = path.join(home, "vault");
  const vault = new Vault({ db, dir, config: { name, vault: { keystore: "file" } }, emit: () => {} });
  return { home, db, dir, vault };
}

async function filled() {
  const a = makeVault("a");
  a.vault.relayUrl = "http://relay.example.com:7443";
  for (const [name, f] of Object.entries(FIXTURES)) await a.vault.put({ name, ...f }, "cli");
  a.vault.grant({ name: "example-api", module: "switchboard" }, "cli");
  a.vault.db.prepare("UPDATE vault_items SET rotate='sent sealed' WHERE name='example-note'").run();
  const c = makeVault("c");
  await a.vault.createPass({ holder: "Sam Example", card: (await c.vault.card()).card, items: ["example-api"] }, "cli");
  return a;
}

/** Every file under a folder, as bytes, for the plaintext checks. */
function allBytes(root) {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push([path.join(e.parentPath, e.name), fs.readFileSync(path.join(e.parentPath, e.name))]);
  }
  return out;
}

test("a backup restores into a vault with a different master key", async () => {
  const a = await filled();
  const blob = await backup(a.vault, PASS, FAST);
  assert.match(blob, /^vyre-backup:v1:/);

  const b = makeVault("b");
  const bmk = await b.vault.key();
  assert.notDeepEqual(bmk, await a.vault.key());

  const r = await restore(b.vault, blob, PASS);
  assert.deepEqual(r.added.sort(), Object.keys(FIXTURES).sort());
  assert.deepEqual(r.kept, []);
  assert.equal(r.grants, 1);
  assert.equal(r.passes, 1);
  assert.equal(r.identity, "restored");

  for (const name of Object.keys(FIXTURES)) {
    const ra = a.vault.row(name), rb = b.vault.row(name);
    assert.deepEqual(await b.vault.fields(rb), await a.vault.fields(ra), name);
    for (const k of ["kind", "description", "url", "hosts", "origin", "rotate", "created", "updated", "fields"]) assert.equal(rb[k], ra[k], `${name}.${k}`);
  }
  assert.ok(b.db.prepare("SELECT 1 FROM vault_grants WHERE item='example-api' AND module='switchboard' AND status='active'").get());
  assert.ok(b.db.prepare("SELECT 1 FROM vault_people WHERE name='Sam Example'").get());
  assert.equal(b.vault.passOut(b.db.prepare("SELECT * FROM vault_passes").get()).holder, "Sam Example");

  const ca = await a.vault.card(), cb = await b.vault.card();
  const pub = c => JSON.parse(Buffer.from(c.card.slice(c.card.lastIndexOf(":") + 1), "base64url").toString());
  assert.equal(pub(cb).sign, pub(ca).sign);
  assert.equal(pub(cb).box, pub(ca).box);
  assert.deepEqual(await b.vault.identity(), await a.vault.identity());

  const audit = b.vault.auditTrail().entries.find(e => e.action === "restore");
  assert.ok(audit && /5 added/.test(String(audit.why)));

  // No fixture value in plain text: not in the blob, not in inspect, not on the second vault's disk.
  const decoded = Buffer.from(blob.slice("vyre-backup:v1:".length), "base64url").toString();
  const shown = JSON.stringify(inspect(blob));
  const ident = await a.vault.identity();
  for (const v of [...VALUES, ident.sign.private, ident.box.private]) {
    assert.ok(!blob.includes(v) && !decoded.includes(v), "a value appeared in the backup");
    assert.ok(!shown.includes(v), "a value appeared in inspect");
  }
  b.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  for (const [file, bytes] of allBytes(b.home)) for (const v of VALUES) assert.ok(!bytes.includes(Buffer.from(v)), `a value appeared in ${path.basename(file)}`);
});

test("inspect reads the label without the passphrase", async () => {
  const a = await filled();
  const before = Date.now();
  const blob = await backup(a.vault, PASS, FAST);
  const i = inspect(blob);
  assert.equal(i.v, 1);
  assert.equal(i.items, 5);
  assert.ok(i.at >= before && i.at <= Date.now());
  assert.deepEqual(Object.keys(i).sort(), ["at", "items", "v"]);
  assert.throws(() => inspect("not a backup"), /not a vyre backup/);
});

test("a wrong passphrase or a tampered blob does not open", async () => {
  const a = await filled();
  const blob = await backup(a.vault, PASS, FAST);
  const b = makeVault("b");
  await assert.rejects(restore(b.vault, blob, "a-different-passphrase"), /that passphrase does not open this backup/);

  const o = JSON.parse(Buffer.from(blob.slice(15), "base64url").toString());
  const ct = Buffer.from(o.ct, "base64"); ct[10] ^= 1;
  const flipped = "vyre-backup:v1:" + Buffer.from(JSON.stringify({ ...o, ct: ct.toString("base64") })).toString("base64url");
  await assert.rejects(restore(b.vault, flipped, PASS), /does not open this backup/);

  const relabelled = "vyre-backup:v1:" + Buffer.from(JSON.stringify({ ...o, items: 99 })).toString("base64url");
  await assert.rejects(restore(b.vault, relabelled, PASS), /altered/);
  assert.equal(b.db.prepare("SELECT COUNT(*) AS n FROM vault_items").get().n, 0);
});

test("merge keeps an existing item and an existing identity", async () => {
  const a = await filled();
  const blob = await backup(a.vault, PASS, FAST);
  const b = makeVault("b");
  await b.vault.put({ name: "example-note", kind: "note", fields: { text: "the second vault's own note" } }, "cli");
  const own = await b.vault.identity();
  const r = await restore(b.vault, blob, PASS, { mode: "merge" });
  assert.deepEqual(r.kept, ["example-note"]);
  assert.equal(r.added.length, 4);
  assert.equal(r.identity, "kept");
  assert.deepEqual(await b.vault.fields(b.vault.row("example-note")), { text: "the second vault's own note" });
  assert.deepEqual(await b.vault.identity(), own);
});

test("replace needs an empty vault", async () => {
  const a = await filled();
  const blob = await backup(a.vault, PASS, FAST);
  const b = makeVault("b");
  await b.vault.put({ name: "other", kind: "secret", fields: { value: "other-value-example" } }, "cli");
  await assert.rejects(restore(b.vault, blob, PASS, { mode: "replace" }), /empty vault/);

  const c = makeVault("c");
  await c.vault.identity();
  const r = await restore(c.vault, blob, PASS, { mode: "replace" });
  assert.equal(r.identity, "restored");
  assert.deepEqual(await c.vault.identity(), await a.vault.identity());
});

test("a short passphrase is refused, and the default cost is N=2^17", async () => {
  const a = await filled();
  await assert.rejects(backup(a.vault, "too-short"), /at least 12/);
  const blob = await backup(a.vault, PASS);
  const o = JSON.parse(Buffer.from(blob.slice(15), "base64url").toString());
  assert.equal(o.N, 1 << 17);
  assert.equal(o.r, 8);
  assert.equal(o.p, 1);
});
