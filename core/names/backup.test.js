// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { backup, restore, checkEntries, estimate } from "./backup.js";
import { seal, open as unsealBytes, isSealed } from "./seal.js";
import { readRecords, isStream } from "./sealstream.js";
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
  // A v2 file: the box's own data is segment 1; a v1 file is one sealed blob.
  if (isStream(fs.readFileSync(file).subarray(0, 32))) {
    const parts = [];
    for (const r of readRecords(file, passphrase)) if (r.seg === 1) parts.push(r.plain);
    fs.writeFileSync(plain, Buffer.concat(parts));
  } else fs.writeFileSync(plain, unsealBytes(fs.readFileSync(file), passphrase));
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
  assert.ok(isStream(fs.readFileSync(file).subarray(0, 32)), "the file on disk is sealed, never a plain tar.gz");
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
  assert.throws(() => [...readRecords(file, "not the right passphrase")], /does not open/);
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

test("backup: a new account's sign-in (named in sessions_accounts) is left out, and its value is not in the file's free pages", async t => {
  const home = tempHome(t);
  const root = path.join(home, "box"); fs.mkdirSync(root);
  const scratch = path.join(home, "scratch"); fs.mkdirSync(scratch);
  const before = process.env.VYRE_TMPDIR;
  process.env.VYRE_TMPDIR = scratch;
  t.after(() => { if (before === undefined) delete process.env.VYRE_TMPDIR; else process.env.VYRE_TMPDIR = before; });
  seed(root);
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  db.exec("CREATE TABLE sessions_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL, vault_item TEXT)");
  db.prepare("INSERT INTO sessions_accounts (id, provider, label, kind, vault_item) VALUES (?,?,?,?,?)").run("a1", "codex", "Work", "api-key", "codex-work-key");
  db.prepare("INSERT INTO vault_items (id, name, kind, fields, created, updated) VALUES (?,?,?,?,?,?)")
    .run("item9", "codex-work-key", "pat", JSON.stringify(["SECRET-CODEX-VALUE-1234567890"]), Date.now(), Date.now());
  db.prepare("INSERT INTO vault_items (id, name, kind, fields, created, updated) VALUES (?,?,?,?,?,?)")
    .run("item10", "a-normal-login", "pat", "[]", Date.now(), Date.now());
  db.close();
  fs.writeFileSync(path.join(root, "vault", "items", "item9.json"), JSON.stringify({ sealed: "fake" }));
  const file = path.join(home, "acct.tar.gz");
  const r = await backup({ root, file, passphrase: PASSPHRASE });
  assert.deepEqual(r.excludedLogins, ["codex-work-key"]);
  const dir = path.join(home, "check"); fs.mkdirSync(dir);
  execFileSync("tar", ["-xzf", unpack(t, home, file), "-C", dir]);
  const raw = fs.readFileSync(path.join(dir, "vyre.db"));
  assert.ok(!raw.includes("SECRET-CODEX-VALUE"), "the deleted row's content is not recoverable from the staged db file");
  assert.ok(!fs.existsSync(path.join(dir, "vault", "items", "item9.json")));
  assert.deepEqual(fs.readdirSync(scratch), [], "no staging or plain archive is left behind");
  assert.deepEqual(fs.readdirSync(home).filter(n => n.includes(".plain")), [], "no plain archive beside the destination");
});


// --- project files: streamed, sized up front, skippable, resumable (lead's ruling, 30 Sep) ---

import crypto from "node:crypto";
import v8 from "node:v8";
import vm from "node:vm";
const FAST = { sealParams: { N: 1024, r: 8, p: 1 }, chunk: 4096 };

/** A /work with two projects, some random (incompressible) files, and a link that must not travel. */
function seedWork(work) {
  fs.mkdirSync(path.join(work, "harlow-intake", "docs"), { recursive: true });
  fs.mkdirSync(path.join(work, "northwind-site"), { recursive: true });
  fs.writeFileSync(path.join(work, "harlow-intake", "README.md"), "# Harlow intake\n");
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(work, "harlow-intake", "docs", `f${i}.bin`), crypto.randomBytes(50_000));
  fs.writeFileSync(path.join(work, "northwind-site", "index.html"), "<h1>Northwind Bakery</h1>");
  fs.symlinkSync("/etc/passwd", path.join(work, "northwind-site", "link"));
}
const tree = dir => {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + "/" + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out[r] = crypto.createHash("sha256").update(fs.readFileSync(path.join(d, e.name))).digest("hex"); } };
  walk(dir, ""); return out;
};

test("export: sizes are known up front, project files go by default, links stay out, and it restores to a chosen folder", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), work = path.join(home, "work");
  fs.mkdirSync(a); seed(a); fs.mkdirSync(work); seedWork(work);
  const est = estimate({ root: a, workRoots: [work] });
  assert.equal(est.work.length, 1);
  assert.equal(est.work[0].files, 8, "eight files, the link not counted");
  assert.equal(est.work[0].links, 1);
  assert.ok(est.total >= est.work[0].bytes && est.work[0].bytes > 300_000);
  const file = path.join(home, "all.vyre");
  const seen = [];
  const r = await backup({ root: a, file, passphrase: PASSPHRASE, work: { roots: [work] }, onProgress: p => seen.push(p), ...FAST });
  assert.deepEqual(r.projects.map(p => p.name), ["work"]);
  assert.ok(seen.some(p => p.phase === "projects" && p.total === est.work[0].bytes), "progress reports against the size shown up front");
  assert.equal(mode(file), 0o600);
  assert.ok(!fs.existsSync(file + ".partial"));
  const b = path.join(home, "b"), back = path.join(home, "restored-work");
  const out = await restore({ root: b, file, passphrase: PASSPHRASE, workTo: { work: back }, alive: dead });
  assert.equal(out.projects[0].to, back);
  const want = tree(work); delete want["northwind-site/link"];
  assert.deepEqual(tree(back), want, "every project file, byte for byte, and no link");
  assert.ok(fs.existsSync(path.join(b, "vyre.db")));
  await assert.rejects(restore({ root: path.join(home, "c"), file, passphrase: PASSPHRASE, workTo: { work: back }, alive: dead }), /already exists; pass force/);
});

test("export: skipping project files leaves them out, and restore can skip them too", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), work = path.join(home, "work");
  fs.mkdirSync(a); seed(a); fs.mkdirSync(work); seedWork(work);
  const file = path.join(home, "state.vyre");
  const r = await backup({ root: a, file, passphrase: PASSPHRASE, work: { roots: [work], skip: true }, ...FAST });
  assert.deepEqual(r.projects, []);
  assert.ok(fs.statSync(file).size < 200_000);
  const full = path.join(home, "full.vyre");
  await backup({ root: a, file: full, passphrase: PASSPHRASE, work: { roots: [work] }, ...FAST });
  const out = await restore({ root: path.join(home, "b"), file: full, passphrase: PASSPHRASE, skipProjects: true, alive: dead });
  assert.deepEqual(out.projects, []);
});

test("export: a damaged, cut-short or reordered file is refused before anything is restored", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), work = path.join(home, "work");
  fs.mkdirSync(a); seed(a); fs.mkdirSync(work); seedWork(work);
  const file = path.join(home, "all.vyre");
  await backup({ root: a, file, passphrase: PASSPHRASE, work: { roots: [work] }, ...FAST });
  const bytes = fs.readFileSync(file);
  const tryRestore = async (name, buf, re) => {
    const f = path.join(home, name); fs.writeFileSync(f, buf);
    const b = path.join(home, "into-" + name); 
    await assert.rejects(restore({ root: b, file: f, passphrase: PASSPHRASE, workTo: { work: path.join(home, "w-" + name) }, alive: dead }), re, name);
    assert.ok(!fs.existsSync(path.join(b, "vyre.db")) && !fs.existsSync(path.join(home, "w-" + name)), `${name}: nothing was written`);
  };
  await tryRestore("cut", bytes.subarray(0, bytes.length - 40), /cut short|does not open/);
  const flipped = Buffer.from(bytes); flipped[Math.floor(bytes.length / 2)] ^= 0xff;
  await tryRestore("flip", flipped, /does not open/);
  const noEnd = bytes.subarray(0, bytes.length - (6 + 16));
  await tryRestore("noend", noEnd, /cut short|does not open/);
});

test("export: an interrupted export resumes where it stopped, and the result restores identically", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), work = path.join(home, "work");
  fs.mkdirSync(a); seed(a); fs.mkdirSync(work); seedWork(work);
  const file = path.join(home, "all.vyre");
  await assert.rejects(backup({ root: a, file, passphrase: PASSPHRASE, work: { roots: [work] }, ...FAST,
    onProgress: p => { if (p.phase === "projects" && p.done > 150_000) throw new Error("power cut"); } }), /power cut/);
  assert.ok(fs.existsSync(file + ".partial") && !fs.existsSync(file));
  const partialSize = fs.statSync(file + ".partial").size;
  const r = await backup({ root: a, file, passphrase: PASSPHRASE, work: { roots: [work] }, ...FAST });
  assert.equal(r.resumed, true);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.bytes > partialSize);
  assert.ok(!fs.existsSync(file + ".partial"));
  const back = path.join(home, "back");
  await restore({ root: path.join(home, "b"), file, passphrase: PASSPHRASE, workTo: { work: back }, alive: dead });
  const want = tree(work); delete want["northwind-site/link"];
  assert.deepEqual(tree(back), want);
});

test("export: a resume with changed project files starts that project again and says so; the wrong passphrase starts over", async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), work = path.join(home, "work");
  fs.mkdirSync(a); seed(a); fs.mkdirSync(work); seedWork(work);
  const file = path.join(home, "all.vyre");
  await assert.rejects(backup({ root: a, file, passphrase: PASSPHRASE, work: { roots: [work] }, ...FAST,
    onProgress: p => { if (p.phase === "projects" && p.done > 150_000) throw new Error("power cut"); } }), /power cut/);
  fs.writeFileSync(path.join(work, "harlow-intake", "README.md"), "# changed after the cut\n");
  fs.writeFileSync(path.join(work, "harlow-intake", "docs", "f0.bin"), crypto.randomBytes(50_000));
  const r = await backup({ root: a, file, passphrase: PASSPHRASE, work: { roots: [work] }, ...FAST });
  assert.match(r.warnings.join(" "), /changed since the unfinished export/);
  const back = path.join(home, "back");
  await restore({ root: path.join(home, "b"), file, passphrase: PASSPHRASE, workTo: { work: back }, alive: dead });
  const want = tree(work); delete want["northwind-site/link"];
  assert.deepEqual(tree(back), want, "the new content, not a mix");

  // A partial made under another passphrase cannot be continued: it is dropped and a full export made.
  const f2 = path.join(home, "two.vyre");
  await assert.rejects(backup({ root: a, file: f2, passphrase: "first passphrase here", work: { roots: [work] }, ...FAST,
    onProgress: p => { if (p.phase === "projects" && p.done > 100_000) throw new Error("cut"); } }), /cut/);
  const r2 = await backup({ root: a, file: f2, passphrase: "second passphrase here", work: { roots: [work] }, ...FAST });
  assert.equal(r2.resumed, false);
  await restore({ root: path.join(home, "b2"), file: f2, passphrase: "second passphrase here", workTo: { work: path.join(home, "back2") }, alive: dead });
});

test("export: a large tree (240 MB of incompressible files) streams in bounded memory, resumes after a cut, and restores byte for byte", { timeout: 240_000 }, async t => {
  const home = tempHome(t);
  const a = path.join(home, "a"), work = path.join(home, "work");
  fs.mkdirSync(a); seed(a); fs.mkdirSync(path.join(work, "northwind-site", "media"), { recursive: true });
  const sums = {};
  // Twelve 20 MB files of random bytes, written in 1 MB pieces so building the tree is not the memory test.
  for (let i = 0; i < 12; i++) {
    const f = path.join(work, "northwind-site", "media", `reel-${i}.bin`);
    const fd = fs.openSync(f, "w"), h = crypto.createHash("sha256");
    for (let k = 0; k < 20; k++) { const b = crypto.randomBytes(1 << 20); fs.writeSync(fd, b); h.update(b); }
    fs.closeSync(fd); sums[`northwind-site/media/reel-${i}.bin`] = h.digest("hex");
  }
  const file = path.join(home, "big.vyre");
  const params = { sealParams: { N: 1024, r: 8, p: 1 } };
  // Live memory, not RSS: the allocator keeps freed pages, so RSS says nothing about a leak. gc() is
  // reached without a flag through v8 and vm, then heap plus external buffers are what is left.
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  const live = () => { gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
  const base = live();
  let peak = 0, cut = false;
  const watch = p => { peak = Math.max(peak, live()); if (!cut && p.phase === "projects" && p.done > 100 * (1 << 20)) { cut = true; throw new Error("power cut"); } };
  await assert.rejects(backup({ root: a, file, passphrase: PASSPHRASE, work: { roots: [work] }, onProgress: watch, ...params }), /power cut/);
  const partial = fs.statSync(file + ".partial").size;
  assert.ok(partial > 50 * (1 << 20), "a good part was already written");
  const r = await backup({ root: a, file, passphrase: PASSPHRASE, work: { roots: [work] }, onProgress: watch, ...params });
  assert.equal(r.resumed, true);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.bytes > 230 * (1 << 20));
  assert.ok(peak - base < 64 * (1 << 20), `live memory grew ${Math.round((peak - base) / 1048576)} MB against a 240 MB tree`);
  const back = path.join(home, "back");
  await restore({ root: path.join(home, "b"), file, passphrase: PASSPHRASE, workTo: { work: back }, alive: dead });
  const got = tree(back);
  assert.deepEqual(got, Object.fromEntries(Object.entries(sums).map(([k, v]) => ["work/" + k.replace("work/", ""), v]).map(([k, v]) => [k.replace(/^work\//, ""), v])));
});
