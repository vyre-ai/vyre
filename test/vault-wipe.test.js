// @ts-check
// Reset with wipe: keys first, then rows and folders; refused while the daemon holds the home's lock; and no tool, module, daemon file or session can reach it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../core/store/index.js";
import { Vault, MIGRATIONS } from "../core/vault/vault.js";
import { acquire } from "../core/daemon/lock.js";
import { wipeHome, vaultHolds, homeKeystore } from "../lib/vault-wipe.js";
import { spawnSync } from "node:child_process";
import { startSealer } from "../kernel/seal/client.js";
import { SCRATCH } from "./scratch.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

async function rig(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-wipe-")), dbp = path.join(home, "vyre.db"), db = open(dbp);
  migrate(db, "vault", MIGRATIONS);
  const dir = path.join(home, "vault"), seal = path.join(home, "seal"), config = { name: "harlow-box", vault: { keystore: "file" } };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const v = new Vault({ db, dir, config, emit: () => {}, log: () => {} });
  await v.put({ name: "note", kind: "secret", fields: { value: "fixture-wipe-value-aaaa1111" } }, "cli");
  const keyBefore = fs.readFileSync(path.join(dir, "key"), "utf8");
  await v.stop(); db.close();
  fs.mkdirSync(path.join(seal, "values"), { recursive: true }); fs.writeFileSync(path.join(seal, "master.key"), "00".repeat(32));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ vault: { keystore: "file" } }));
  return { home, dbp, dir, seal, config, keyBefore };
}

test("wipeHome: keys destroyed, vault rows and folders emptied, counts returned, and a fresh vault is empty with a new key", async t => {
  const r = await rig(t);
  const out = await wipeHome({ home: r.home });
  assert.equal(out.vault.key_files_destroyed, 1); assert.equal(out.seal.master_destroyed, true); assert.ok(out.vault.tables_emptied > 5);
  assert.deepEqual(fs.readdirSync(r.dir), []); assert.deepEqual(fs.readdirSync(r.seal), []);
  assert.ok(!fs.existsSync(path.join(r.home, "vyred.lock")), "the lock is released");
  const db = open(r.dbp); const v = new Vault({ db, dir: r.dir, config: r.config, emit: () => {}, log: () => {} });
  assert.equal(v.list().items.length, 0); await v.key();
  assert.notEqual(fs.readFileSync(path.join(r.dir, "key"), "utf8"), r.keyBefore, "a new key");
  await v.stop(); db.close();
});

test("wipeHome refuses while the daemon holds the home's lock, and destroys nothing", async t => {
  const r = await rig(t), release = acquire(r.home);
  try {
    await assert.rejects(wipeHome({ home: r.home }), e => /** @type {any} */ (e).code === "daemon_running" && /stop it first/.test(e.message));
  } finally { release(); }
  assert.ok(fs.existsSync(path.join(r.dir, "key")) && fs.existsSync(path.join(r.seal, "master.key")));
});

test("wipeHome refuses while a sealing process serves the folder, and destroys nothing", async t => {
  const r = await rig(t); fs.rmSync(r.seal, { recursive: true, force: true });
  const s = startSealer({ dir: r.seal, timeoutMs: 8000, dev: true, unattested: true }); let closed = false;
  t.after(async () => { if (!closed) await s.close(); });
  await s.api.put({ chain: (await import("../kernel/seal/testing.js")).person(), record: "vyre://spc_testspace0001/contact/c_jane", field: "ssn", class: "us-ssn", value: "123-45-6789" });
  await assert.rejects(wipeHome({ home: r.home }), e => /** @type {any} */ (e).code === "sealer_running" && /stop it first/.test(e.message));
  assert.ok(fs.existsSync(path.join(r.dir, "key")) && fs.existsSync(path.join(r.seal, "master.key")));
  await s.close(); closed = true;
  assert.equal((await wipeHome({ home: r.home })).seal.master_destroyed, true);
});

test("wipeHome never reports success while a key survives: a keychain keystore with no way to delete it, and a sealing master that is not a file, are refused by name", async t => {
  const r = await rig(t);
  const cfg = path.join(r.home, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ vault: { keystore: "keychain" } }));
  await assert.rejects(wipeHome({ home: r.home }), e => /** @type {any} */ (e).code === "keystore_survives" && /keychain/.test(e.message));
  fs.writeFileSync(cfg, JSON.stringify({ vault: { keystore: "file" } }));
  fs.rmSync(path.join(r.seal, "master.key")); fs.writeFileSync(path.join(r.seal, "values", "x.json"), "{}");
  await assert.rejects(wipeHome({ home: r.home }), e => /** @type {any} */ (e).code === "keystore_survives" && /sealing master/.test(e.message));
  assert.ok(fs.existsSync(path.join(r.dir, "key")), "nothing was destroyed");
  fs.writeFileSync(cfg, JSON.stringify({ vault: { keystore: "keychain" } }));
  let called = 0; fs.rmSync(path.join(r.seal, "values", "x.json")); fs.writeFileSync(path.join(r.seal, "master.key"), "00".repeat(32));
  const out = await wipeHome({ home: r.home, destroyKeychain: () => { called++; } });
  assert.equal(called, 1); assert.equal(out.vault.keychain_destroyed, true);
});

test("vaultHolds answers exactly false when the home is empty, true with an item or a sealed value, and true when it cannot tell", async t => {
  const r = await rig(t);
  assert.equal(vaultHolds({ home: r.home }), true, "a vault item");
  await wipeHome({ home: r.home });
  assert.equal(vaultHolds({ home: r.home }), false);
  fs.mkdirSync(path.join(r.seal, "values"), { recursive: true }); fs.writeFileSync(path.join(r.seal, "values", "seal_anchor0000000000000000.json"), "{}");
  assert.equal(vaultHolds({ home: r.home }), false, "bookkeeping is not data");
  fs.writeFileSync(path.join(r.seal, "values", "seal_abcdefghijklmnopqrstuv.json"), "{}");
  assert.equal(vaultHolds({ home: r.home }), true, "a sealed value");
  fs.writeFileSync(r.dbp, "not a database");
  assert.equal(vaultHolds({ home: r.home }), true, "unreadable counts as holding");
});

test("WP-1 and WP-2: the keystore must be stated (a missing or unknown one refuses), homeKeystore reads it from config, every named backup is destroyed or named, and the notices say what remains", async t => {
  const r = await rig(t);
  // WP-1: the key's place is read from the home's config, never trusted from the caller.
  await assert.rejects(wipeHome({ home: r.home, keystore: "keychain" }), e => /** @type {any} */ (e).code === "keystore_mismatch", "the caller says keychain, the config says file");
  fs.writeFileSync(path.join(r.home, "config.json"), JSON.stringify({ vault: { keystore: "keychain" } }));
  await assert.rejects(wipeHome({ home: r.home, keystore: "file" }), e => /** @type {any} */ (e).code === "keystore_mismatch", "the caller says file, the config says keychain: nothing is wiped and nothing reported");
  assert.ok(fs.existsSync(path.join(r.dir, "key")), "a mismatch destroyed nothing");
  fs.writeFileSync(path.join(r.home, "config.json"), JSON.stringify({ vault: { keystore: "rot13" } }));
  await assert.rejects(wipeHome({ home: r.home }), e => /** @type {any} */ (e).code === "keystore_unknown");
  fs.writeFileSync(path.join(r.home, "config.json"), "{not json");
  await assert.rejects(wipeHome({ home: r.home }), e => /** @type {any} */ (e).code === "keystore_unknown");
  fs.writeFileSync(path.join(r.home, "config.json"), JSON.stringify({ vault: { keystore: "file" } }));
  assert.ok(fs.existsSync(path.join(r.dir, "key")), "nothing destroyed by a refusal");
  fs.writeFileSync(path.join(r.home, "config.json"), JSON.stringify({ vault: { keystore: "keychain" } })); assert.equal(homeKeystore(r.home), "keychain");
  fs.writeFileSync(path.join(r.home, "config.json"), JSON.stringify({ vault: { keystore: "rot13" } })); assert.throws(() => homeKeystore(r.home), e => /** @type {any} */ (e).code === "keystore_unknown");
  fs.writeFileSync(path.join(r.home, "config.json"), "{not json"); assert.throws(() => homeKeystore(r.home), e => /** @type {any} */ (e).code === "keystore_unknown");
  fs.rmSync(path.join(r.home, "config.json")); assert.ok(["file", "keychain"].includes(homeKeystore(r.home)), "no config: the platform default");
  const prev = path.join(r.home, "release.prev"), src = path.join(r.home, "src.prev", "deep");
  fs.mkdirSync(path.join(prev, "vault"), { recursive: true }); fs.writeFileSync(path.join(prev, "vault", "key"), "k".repeat(64)); fs.mkdirSync(src, { recursive: true }); fs.writeFileSync(path.join(src, "x.db"), "data");
  const out = await wipeHome({ home: r.home, backups: [prev, path.join(r.home, "src.prev"), path.join(r.home, "not-there")] });
  assert.equal(out.backups_removed, 2); assert.ok(!fs.existsSync(prev) && !fs.existsSync(path.join(r.home, "src.prev")));
  assert.ok(out.notices.some(n => /backup string or export/.test(n)) && out.notices.some(n => /valid at the provider/.test(n)));
});

test("WP-2: a symlinked backup is never followed blindly: a target inside the home is destroyed with the link, one outside is refused by name, and every path is verified gone", async t => {
  const r = await rig(t), tgt = path.join(r.home, "real-prev"), link = path.join(r.home, "link.prev");
  fs.mkdirSync(path.join(tgt, "vault"), { recursive: true }); fs.writeFileSync(path.join(tgt, "vault", "key"), "k".repeat(64)); fs.symlinkSync(tgt, link);
  const outside = fs.mkdtempSync(path.join(SCRATCH, "vyre-outside-")); fs.writeFileSync(path.join(outside, "keep"), "x"); const elink = path.join(r.home, "out.prev"); fs.symlinkSync(outside, elink);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  await assert.rejects(wipeHome({ home: r.home, backups: [elink] }), e => /** @type {any} */ (e).code === "backup_survives" && e.message.includes("out.prev") && e.message.includes("outside the home"));
  assert.ok(fs.existsSync(path.join(outside, "keep")), "nothing outside the home was touched");
  fs.rmSync(elink);
  const out = await wipeHome({ home: r.home, backups: [link] });
  assert.equal(out.backups_removed, 1);
  for (const p of [link, tgt]) assert.throws(() => fs.lstatSync(p), /ENOENT/, `${p} is gone`);
});

test("a backup that cannot be removed is named and the wipe reports no success", async t => {
  const r = await rig(t), locked = path.join(r.home, "locked.prev");
  fs.mkdirSync(locked); fs.writeFileSync(path.join(locked, "f"), "x"); fs.chmodSync(locked, 0o500);
  if (process.getuid && process.getuid() === 0) return t.skip("root can remove anything");
  try { await assert.rejects(wipeHome({ home: r.home, backups: [locked] }), e => /** @type {any} */ (e).code === "backup_survives" && e.message.includes("locked.prev")); }
  finally { fs.chmodSync(locked, 0o700); }
});

test("scripts/admin-wipe.mjs: wipes a home from its own config and prints counts, refuses (exit 2, nothing destroyed) on a bad config, and 64 on bad arguments", async t => {
  const r = await rig(t), script = path.join(ROOT, "scripts", "admin-wipe.mjs");
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(run([]).status, 64); assert.equal(run(["--home", "relative"]).status, 64); assert.equal(run(["--home", r.home, "--bogus"]).status, 64);
  fs.writeFileSync(path.join(r.home, "config.json"), JSON.stringify({ vault: { keystore: "rot13" } }));
  const bad = run(["--home", r.home]); assert.equal(bad.status, 2); assert.match(bad.stderr, /keystore_unknown/);
  assert.ok(fs.existsSync(path.join(r.dir, "key")), "a refusal destroyed nothing");
  fs.writeFileSync(path.join(r.home, "config.json"), JSON.stringify({ vault: { keystore: "file" } }));
  const prev = path.join(r.home, "release.prev"); fs.mkdirSync(prev); fs.writeFileSync(path.join(prev, "x"), "d");
  const ok = run(["--home", r.home, "--backup", prev]);
  assert.equal(ok.status, 0, ok.stderr); const out = JSON.parse(ok.stdout);
  assert.equal(out.vault.key_files_destroyed, 1); assert.equal(out.backups_removed, 1); assert.match(ok.stderr, /valid at the provider/);
  assert.ok(!fs.existsSync(path.join(r.dir, "key")) && !fs.existsSync(prev));
});

test("nothing in the daemon, a module, the kernel or a tool reaches the wipe: no file but the host CLI's imports it, and no tool is named wipe", () => {
  const hits = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(e.name)) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.(m?js|json)$/.test(e.name) && !/test\.m?js$/.test(e.name) && /vault-wipe|wipeHome|wipeSealDir/.test(fs.readFileSync(f, "utf8"))) hits.push(path.relative(ROOT, f));
  } };
  for (const d of ["core", "kernel", "modules", "local", "deck", "relay", "lib"]) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  assert.deepEqual(hits.sort(), ["kernel/seal/wipe.js", "lib/vault-wipe.js"]);
  assert.ok(fs.readFileSync(path.join(ROOT, "scripts", "admin-wipe.mjs"), "utf8").includes("wipeHome"), "the host CLI script is the one importer outside");
  const tools = JSON.parse(fs.readFileSync(path.join(ROOT, "core/vault/module.json"), "utf8")).does.tools.map(t => (typeof t === "string" ? t : t.name));
  assert.deepEqual(tools.filter(n => /wipe|destroy/i.test(n)), []);
});
