// @ts-check
// lib/vault-wipe.js: reset with wipe. Run ONLY by the host CLI, `sudo vyre admin wipe`, as root with the daemon STOPPED. Not a tool and not imported by the daemon, a module or a session
// (test/vault-wipe.test.js scans for that). It takes the home's lock first, so it refuses while vyred runs and vyred cannot start in the middle of it. Then, keys before folders, so
// whatever a later step fails to remove opens for no one:
//   1. the vault's device key and Secret Key files (`key`, `key.wrapped`, `secret-key`) are overwritten and removed, and a keychain entry is deleted by `destroyKeychain` when the home uses one;
//   2. the sealing master key is overwritten and removed (kernel/seal/wipe.js);
//   3. every vault_ table is emptied, the vault folder and the sealing folder are emptied.
// It reports counts, never a name or a value. A fresh start makes a new vault key, a new sealing master and a new Space checkpoint key.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquire } from "../core/daemon/lock.js";
import { wipeSealDir } from "../kernel/seal/wipe.js";

const overwriteAndRemove = (/** @type {string} */ f) => {
  let had = false;
  try { const n = fs.statSync(f).size, fd = fs.openSync(f, "r+"); fs.writeSync(fd, crypto.randomBytes(Math.max(n, 32))); fs.fsyncSync(fd); fs.closeSync(fd); had = true; } catch { /* not there */ }
  fs.rmSync(f, { force: true });
  return had;
};

/**
 * @param {{ home: string, vaultDir?: string, sealDir?: string, db?: string, destroyKeychain?: () => Promise<void> | void }} o
 *   home: the Vyre home (the folder holding vyred.lock); defaults: vault `<home>/vault`, seal `<home>/seal`, db `<home>/vyre.db`. destroyKeychain: supplied by the CLI when the home's
 *   keystore is the OS keychain (a desktop); a box uses files.
 * @returns {Promise<{ vault: { key_files_destroyed: number, keychain_destroyed: boolean, tables_emptied: number, files_removed: number }, seal: { master_destroyed: boolean, removed: number } }>}
 */
export async function wipeHome({ home, vaultDir = path.join(home, "vault"), sealDir = path.join(home, "seal"), db = path.join(home, "vyre.db"), destroyKeychain }) {
  let release;
  try { release = acquire(home); } catch (e) { throw Object.assign(new Error(`${/** @type {Error} */ (e).message}; stop it first`), { code: "daemon_running" }); }
  try {
    let keys = 0, keychain = false;
    if (fs.existsSync(vaultDir)) for (const f of ["key", "key.wrapped", "secret-key"]) if (overwriteAndRemove(path.join(vaultDir, f))) keys++;
    if (destroyKeychain) { await destroyKeychain(); keychain = true; }
    const seal = wipeSealDir(sealDir);
    let tables = 0;
    if (fs.existsSync(db)) {
      const conn = new DatabaseSync(db);
      try {
        for (const t of /** @type {any[]} */ (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vault\\_%' ESCAPE '\\'").all())) { conn.prepare(`DELETE FROM "${String(t.name).replace(/"/g, "")}"`).run(); tables++; }
      } finally { conn.close(); }
    }
    let files = 0;
    if (fs.existsSync(vaultDir)) { for (const e of fs.readdirSync(vaultDir, { withFileTypes: true })) { fs.rmSync(path.join(vaultDir, e.name), { recursive: true, force: true }); files++; } fs.chmodSync(vaultDir, 0o700); }
    return { vault: { key_files_destroyed: keys, keychain_destroyed: keychain, tables_emptied: tables, files_removed: files }, seal };
  } finally { release(); }
}
