// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { backup, restore, checkEntries } from "./backup.js";
import { seal, open as unsealBytes, isSealed } from "./seal.js";
import { tempHome } from "../../test/helpers.js";

const mode = p => fs.statSync(p).mode & 0o777;
const dead = () => false;
const PASSPHRASE = "correct horse battery staple";

/** A root with a bit of everything, including things a backup must leave out. */
function seed(root) {
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex" }));
  fs.writeFileSync(path.join(root, "hub.json"), JSON.stringify({ rev: 1, account: {} }));
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('one'), ('two');");
  db.exec(`CREATE TABLE vault_items (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL, url TEXT, hosts TEXT NOT NULL DEFAULT '[]', origin TEXT, rotate TEXT,
    created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  db.close();
  for (const d of ["vault", path.join("vault", "items"), "watchers", "certs", "models", "logs"]) fs.mkdirSync(path.join(root, d), { mode: 0o700 });
  fs.writeFileSync(path.join(root, "vault", "key"), "k", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "watchers", "w.json"), "{}");
  fs.writeFileSync(path.join(root, "certs", "box.example.com.crt"), "cert");
  fs.writeFileSync(path.join(root, "models", "big.bin"), "weights");
  fs.writeFileSync(path.join(root, "logs", "today.log"), "log");
  fs.writeFileSync(path.join(root, "vyred.pid"), "999999");
}

/** Add a vault item row plus its sealed file, the shape a real provider sign-in takes. */
function seedVaultItem(root, id, name) {
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  db.prepare("INSERT INTO vault_items (id, name, kind, fields, created, updated) VALUES (?,?,?,?,?,?)")
    .run(id, name, "pat", "[]", Date.now(), Date.now());
  db.close();
  fs.writeFileSync(path.join(root, "vault", "items", id + ".json"), JSON.stringify({ sealed: "fake" }));
}

/** Unpack a sealed backup file's plain tar.gz to a fresh folder, for assertions on its contents. */
function unpack(t, home, file, passphrase = PASSPHRASE) {
  const plain = path.join(home, `unpacked-${Math.random().toString(36).slice(2)}.tar.gz`);
  fs.writeFileSync(plain, unsealBytes(fs.readFileSync(file), passphrase));
  t.after(() => fs.rmSync(plain, { force: true }));
  return plain;
}

test("backup: is sealed under a passphrase, includes the state, leaves out models/logs/pid, and is 0600", async t => {
  const home = tempHome(t);
  const root = path.join(home, "box"); fs.mkdirSync(root);
  seed(root);
  const file = path.join(home, "out", "b.tar.gz");
  const r = await backup({ root, file, passphrase: PASSPHRASE });
  assert.deepEqual(r.included, ["config.json", "hub.json", "vyre.db", "vault", "watchers", "certs"]);
  assert.equal(r.file, file);
  assert.equal(r.bytes, fs.statSync(file).size);
  assert.equal(mode(file), 0o600);
  assert.ok(isSealed(fs.readFileSync(file)), "the file on disk is sealed, never a plain tar.gz");
  const plain = unpack(t, home, file);
  const list = execFileSync("tar", ["-tzf", plain], { encoding: "utf8" });
  assert.match(list, /vault\/key/);
  assert.doesNotMatch(list, /models|logs|vyred\.pid|vyre\.db-wal/);
  assert.deepEqual(fs.readdirSync(path.join(home, "out")).filter(n => !n.startsWith("unpacked-")), ["b.tar.gz"], "no temp file left");
});

test("backup: refuses a short passphrase, and refuses to open with the wrong one", async t => {
  const home = tempHome(t);
  const root = path.join(home, "box"); fs.mkdirSync(root);
  seed(root);
  const file = path.join(home, "b.tar.gz");
  await assert.rejects(backup({ root, file, passphrase: "short" }), /at least 12 characters/);
  await backup({ root, file, passphrase: PASSPHRASE });
  assert.throws(() => unsealBytes(fs.readFileSync(file), "not the right passphrase"), /does not open/);
});

test("backup: uses an open database handle when given one", async t => {
  const home = tempHome(t);
  const db = new DatabaseSync(path.join(home, "vyre.db"));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('live');");
  const r = await backup({ root: home, file: path.join(home, "b.tar.gz"), db, passphrase: PASSPHRASE });
  db.close();
  assert.deepEqual(r.included, ["vyre.db"]);
});

test("backup: leaves provider sign-ins out of the vault by default (R8), and can include them", async t => {
  const home = tempHome(t);
  const root = path.join(home, "box"); fs.mkdirSync(root);
  seed(root);
  seedVaultItem(root, "item1", "claude-setup-token");
  seedVaultItem(root, "item2", "a-normal-login");
  const fileDefault = path.join(home, "default.tar.gz");
  const r1 = await backup({ root, file: fileDefault, passphrase: PASSPHRASE });
  assert.deepEqual(r1.excludedLogins, ["claude-setup-token"]);
  const plain1 = unpack(t, home, fileDefault);
  const dir1 = path.join(home, "check1"); fs.mkdirSync(dir1);
  execFileSync("tar", ["-xzf", plain1, "-C", dir1]);
  const db1 = new DatabaseSync(path.join(dir1, "vyre.db"));
  assert.deepEqual(db1.prepare("SELECT name FROM vault_items ORDER BY name").all().map(x => x.name), ["a-normal-login"]);
  db1.close();
  assert.ok(!fs.existsSync(path.join(dir1, "vault", "items", "item1.json")), "the excluded item's sealed file is gone too");
  assert.ok(fs.existsSync(path.join(dir1, "vault", "items", "item2.json")));

  const fileWith = path.join(home, "with.tar.gz");
  const r2 = await backup({ root, file: fileWith, passphrase: PASSPHRASE, includeProviderLogins: true });
  assert.deepEqual(r2.excludedLogins, []);
  const plain2 = unpack(t, home, fileWith);
  const dir2 = path.join(home, "check2"); fs.mkdirSync(dir2);
  execFileSync("tar", ["-xzf", plain2, "-C", dir2]);
  const db2 = new DatabaseSync(path.join(dir2, "vyre.db"));
  assert.deepEqual(db2.prepare("SELECT name FROM vault_items ORDER BY name").all().map(x => x.name), ["a-normal-login", "claude-setup-token"]);
  db2.close();
});

test("restore: round-trips into an empty root", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), b = path.join(home, "b");
  fs.mkdirSync(a); seed(a);
  const file = path.join(home, "b.tar.gz");
  await backup({ root: a, file, passphrase: PASSPHRASE });
  const r = await restore({ root: b, file, passphrase: PASSPHRASE, alive: dead });
  assert.deepEqual(r.restored, ["config.json", "hub.json", "vyre.db", "vault", "watchers", "certs"]);
  const db = new DatabaseSync(path.join(b, "vyre.db"));
  assert.deepEqual(db.prepare("SELECT v FROM t ORDER BY v").all().map(x => x.v), ["one", "two"]);
  db.close();
  assert.equal(fs.readFileSync(path.join(b, "vault", "key"), "utf8"), "k");
  assert.equal(JSON.parse(fs.readFileSync(path.join(b, "hub.json"), "utf8")).rev, 1, "the settings hub comes back");
  assert.equal(mode(path.join(b, "vault", "key")), 0o600);
  assert.ok(!fs.existsSync(path.join(b, "models")));
  assert.ok(!fs.readdirSync(b).some(n => n.startsWith(".restore-")), "staging removed");
});

test("restore: refuses the wrong passphrase before touching anything on disk", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), b = path.join(home, "b");
  fs.mkdirSync(a); seed(a); fs.mkdirSync(b);
  const file = path.join(home, "b.tar.gz");
  await backup({ root: a, file, passphrase: PASSPHRASE });
  await assert.rejects(restore({ root: b, file, passphrase: "wrong passphrase entirely", alive: dead }), /does not open/);
  assert.ok(!fs.existsSync(path.join(b, "vyre.db")), "nothing written on a failed open");
});

test("restore: refuses to replace a store without force, and replaces it with force", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"); fs.mkdirSync(a); seed(a);
  const file = path.join(home, "b.tar.gz");
  await backup({ root: a, file, passphrase: PASSPHRASE });
  const b = path.join(home, "b"); fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, "vyre.db"), "old");
  fs.writeFileSync(path.join(b, "vyre.db-wal"), "stale");
  await assert.rejects(restore({ root: b, file, passphrase: PASSPHRASE, alive: dead }), /already exists/);
  assert.equal(fs.readFileSync(path.join(b, "vyre.db"), "utf8"), "old");
  await restore({ root: b, file, passphrase: PASSPHRASE, force: true, alive: dead });
  assert.ok(!fs.existsSync(path.join(b, "vyre.db-wal")), "old WAL removed");
  const db = new DatabaseSync(path.join(b, "vyre.db"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM t").get()?.n, 2);
  db.close();
});

test("restore: refuses while vyred is alive", async t => {
  const home = tempHome(t);
  // A live process that is not this one stands in for vyred.
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => other.kill());
  fs.writeFileSync(path.join(home, "vyred.pid"), String(other.pid));
  let asked = null;
  await assert.rejects(restore({ root: home, file: path.join(home, "none.tar.gz"), passphrase: PASSPHRASE, alive: o => { asked = o; return true; } }), /vyred is running/);
  assert.equal(asked?.pid, other.pid);
  await assert.rejects(restore({ root: home, file: path.join(home, "none.tar.gz"), passphrase: PASSPHRASE }), /vyred is running/);
});

test("restore: a stale pid file naming the restore itself is not a running vyred", async t => {
  // A container killed with vyred as pid 7 leaves 7 behind, and the one-off container that
  // runs the restore gives its own CLI pid 7 too.
  const home = tempHome(t);
  const a = path.join(home, "a"), b = path.join(home, "b");
  fs.mkdirSync(a); seed(a); fs.mkdirSync(b);
  const file = path.join(home, "b.tar.gz");
  await backup({ root: a, file, passphrase: PASSPHRASE });
  fs.writeFileSync(path.join(b, "vyred.pid"), String(process.pid));
  const r = await restore({ root: b, file, passphrase: PASSPHRASE });
  assert.ok(r.restored.includes("config.json"));
});

test("restore: rejects a file that is not a sealed vyre backup at all", async t => {
  const home = tempHome(t);
  const src = path.join(home, "src"); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "x"), "x");
  const file = path.join(home, "plain.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", src, "."]);
  const root = path.join(home, "root");
  await assert.rejects(restore({ root, file, passphrase: PASSPHRASE, alive: dead }), /not a sealed vyre backup/);
});

test("restore: rejects archives with absolute, escaping or unknown entries, even sealed under the right passphrase", async t => {
  assert.throws(() => checkEntries("./vault/../../etc/passwd\n"), /unsafe/);
  assert.throws(() => checkEntries("/etc/passwd\n"), /unsafe/);
  assert.throws(() => checkEntries("./.bashrc\n"), /unsafe/);
  assert.doesNotThrow(() => checkEntries("./\n./config.json\n./vault/\n./vault/key\n"));

  const home = tempHome(t);
  const src = path.join(home, "src"); fs.mkdirSync(path.join(src, "evil"), { recursive: true });
  fs.writeFileSync(path.join(src, "evil", "x"), "x");
  const plain = path.join(home, "evil.plain.tar.gz");
  execFileSync("tar", ["-czf", plain, "-C", src, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const file = path.join(home, "evil.tar.gz");
  fs.writeFileSync(file, seal(fs.readFileSync(plain), PASSPHRASE));
  const root = path.join(home, "root");
  await assert.rejects(restore({ root, file, passphrase: PASSPHRASE, alive: dead }), /unsafe entries/);
  assert.ok(!fs.existsSync(path.join(root, "evil")));
});

test("restore: rejects an archive that carries a symlink, even sealed under the right passphrase", async t => {
  const home = tempHome(t);
  const src = path.join(home, "src"); fs.mkdirSync(path.join(src, "vault"), { recursive: true });
  fs.symlinkSync("/etc", path.join(src, "vault", "out"));
  const plain = path.join(home, "link.plain.tar.gz");
  execFileSync("tar", ["-czf", plain, "-C", src, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const file = path.join(home, "link.tar.gz");
  fs.writeFileSync(file, seal(fs.readFileSync(plain), PASSPHRASE));
  const root = path.join(home, "root");
  await assert.rejects(restore({ root, file, passphrase: PASSPHRASE, alive: dead }), /link/);
  assert.ok(!fs.existsSync(path.join(root, "vault")));
});
