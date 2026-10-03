// @ts-check
// Reset with wipe: keys first, then rows and folders; refused while the daemon holds the home's lock; and no tool, module, daemon file or session can reach it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../core/store/index.js";
import { Vault, MIGRATIONS } from "../core/vault/vault.js";
import { acquire } from "../core/daemon/lock.js";
import { wipeHome } from "../lib/vault-wipe.js";
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
  const tools = JSON.parse(fs.readFileSync(path.join(ROOT, "core/vault/module.json"), "utf8")).does.tools.map(t => (typeof t === "string" ? t : t.name));
  assert.deepEqual(tools.filter(n => /wipe|destroy/i.test(n)), []);
});
