// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { backup, restore, checkEntries } from "./backup.js";
import { tempHome } from "../../test/helpers.js";

const mode = p => fs.statSync(p).mode & 0o777;
const dead = () => false;

/** A root with a bit of everything, including things a backup must leave out. */
function seed(root) {
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex" }));
  fs.writeFileSync(path.join(root, "hub.json"), JSON.stringify({ rev: 1, account: {} }));
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('one'), ('two');");
  db.close();
  for (const d of ["vault", "watchers", "certs", "models", "logs"]) fs.mkdirSync(path.join(root, d), { mode: 0o700 });
  fs.writeFileSync(path.join(root, "vault", "key"), "k", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "watchers", "w.json"), "{}");
  fs.writeFileSync(path.join(root, "certs", "box.example.com.crt"), "cert");
  fs.writeFileSync(path.join(root, "models", "big.bin"), "weights");
  fs.writeFileSync(path.join(root, "logs", "today.log"), "log");
  fs.writeFileSync(path.join(root, "vyred.pid"), "999999");
}

test("backup: includes the state, leaves out models, logs and pid, and is 0600", async t => {
  const home = tempHome(t);
  const root = path.join(home, "box"); fs.mkdirSync(root);
  seed(root);
  const file = path.join(home, "out", "b.tar.gz");
  const r = await backup({ root, file });
  assert.deepEqual(r.included, ["config.json", "hub.json", "vyre.db", "vault", "watchers", "certs"]);
  assert.equal(r.file, file);
  assert.equal(r.bytes, fs.statSync(file).size);
  assert.equal(mode(file), 0o600);
  const list = execFileSync("tar", ["-tzf", file], { encoding: "utf8" });
  assert.match(list, /vault\/key/);
  assert.doesNotMatch(list, /models|logs|vyred\.pid|vyre\.db-wal/);
  assert.deepEqual(fs.readdirSync(path.join(home, "out")), ["b.tar.gz"], "no temp file left");
});

test("backup: uses an open database handle when given one", async t => {
  const home = tempHome(t);
  const db = new DatabaseSync(path.join(home, "vyre.db"));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('live');");
  const r = await backup({ root: home, file: path.join(home, "b.tar.gz"), db });
  db.close();
  assert.deepEqual(r.included, ["vyre.db"]);
});

test("restore: round-trips into an empty root", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), b = path.join(home, "b");
  fs.mkdirSync(a); seed(a);
  const file = path.join(home, "b.tar.gz");
  await backup({ root: a, file });
  const r = await restore({ root: b, file, alive: dead });
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

test("restore: refuses to replace a store without force, and replaces it with force", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"); fs.mkdirSync(a); seed(a);
  const file = path.join(home, "b.tar.gz");
  await backup({ root: a, file });
  const b = path.join(home, "b"); fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, "vyre.db"), "old");
  fs.writeFileSync(path.join(b, "vyre.db-wal"), "stale");
  await assert.rejects(restore({ root: b, file, alive: dead }), /already exists/);
  assert.equal(fs.readFileSync(path.join(b, "vyre.db"), "utf8"), "old");
  await restore({ root: b, file, force: true, alive: dead });
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
  await assert.rejects(restore({ root: home, file: path.join(home, "none.tar.gz"), alive: o => { asked = o; return true; } }), /vyred is running/);
  assert.equal(asked?.pid, other.pid);
  await assert.rejects(restore({ root: home, file: path.join(home, "none.tar.gz") }), /vyred is running/);
});

test("restore: a stale pid file naming the restore itself is not a running vyred", async t => {
  // A container killed with vyred as pid 7 leaves 7 behind, and the one-off container that
  // runs the restore gives its own CLI pid 7 too.
  const home = tempHome(t);
  const a = path.join(home, "a"), b = path.join(home, "b");
  fs.mkdirSync(a); seed(a); fs.mkdirSync(b);
  const file = path.join(home, "b.tar.gz");
  await backup({ root: a, file });
  fs.writeFileSync(path.join(b, "vyred.pid"), String(process.pid));
  const r = await restore({ root: b, file });
  assert.ok(r.restored.includes("config.json"));
});

test("restore: rejects archives with absolute, escaping or unknown entries", async t => {
  assert.throws(() => checkEntries("./vault/../../etc/passwd\n"), /unsafe/);
  assert.throws(() => checkEntries("/etc/passwd\n"), /unsafe/);
  assert.throws(() => checkEntries("./.bashrc\n"), /unsafe/);
  assert.doesNotThrow(() => checkEntries("./\n./config.json\n./vault/\n./vault/key\n"));

  const home = tempHome(t);
  const src = path.join(home, "src"); fs.mkdirSync(path.join(src, "evil"), { recursive: true });
  fs.writeFileSync(path.join(src, "evil", "x"), "x");
  const file = path.join(home, "evil.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", src, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const root = path.join(home, "root");
  await assert.rejects(restore({ root, file, alive: dead }), /unsafe entries/);
  assert.ok(!fs.existsSync(path.join(root, "evil")));
});

test("restore: rejects an archive that carries a symlink", async t => {
  const home = tempHome(t);
  const src = path.join(home, "src"); fs.mkdirSync(path.join(src, "vault"), { recursive: true });
  fs.symlinkSync("/etc", path.join(src, "vault", "out"));
  const file = path.join(home, "link.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", src, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const root = path.join(home, "root");
  await assert.rejects(restore({ root, file, alive: dead }), /link/);
  assert.ok(!fs.existsSync(path.join(root, "vault")));
});
