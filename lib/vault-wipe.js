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
import { execFileSync } from "node:child_process";
import { acquire } from "../core/daemon/lock.js";
import { wipeSealDir } from "../kernel/seal/wipe.js";

const overwriteAndRemove = (/** @type {string} */ f) => {
  let had = false;
  try { const n = fs.statSync(f).size, fd = fs.openSync(f, "r+"); fs.writeSync(fd, crypto.randomBytes(Math.max(n, 32))); fs.fsyncSync(fd); fs.closeSync(fd); had = true; } catch { /* not there */ }
  fs.rmSync(f, { force: true });
  return had;
};

const refuse = (/** @type {string} */ code, /** @type {string} */ why) => Object.assign(new Error(why), { code });

/** Is a sealing process serving this folder? Its command line names kernel/seal/process.js and its environment VYRE_SEAL_DIR; where the environment cannot be read, any sealing process counts (refuse, never guess). */
export function sealerRunning(/** @type {string} */ sealDir) {
  let out = "";
  try { out = execFileSync("ps", ["-axo", "uid=,pid=,command="], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return true; }
  const want = path.resolve(sealDir);
  let owner = null; try { owner = fs.statSync(sealDir).uid; } catch { /* no folder yet */ }
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[2]) === process.pid || !/kernel[\/\\]seal[\/\\]process\.js/.test(m[3])) continue;
    // The folder is 0700: a process of another user (root excepted) cannot be serving it.
    if (owner !== null && Number(m[1]) !== 0 && Number(m[1]) !== owner) continue;
    try { const env = fs.readFileSync(`/proc/${m[2]}/environ`, "utf8").split("\0").find(x => x.startsWith("VYRE_SEAL_DIR=")); if (env && path.resolve(env.slice(14)) !== want) continue; } catch { /* unreadable: counts */ }
    return true;
  }
  return false;
}

/**
 * @param {{ home: string, vaultDir?: string, sealDir?: string, db?: string, keystore?: string, destroyKeychain?: () => Promise<void> | void }} o
 *   home: the Vyre home (the folder holding vyred.lock); defaults: vault `<home>/vault`, seal `<home>/seal`, db `<home>/vyre.db`. destroyKeychain: supplied by the CLI when the home's
 *   keystore is the OS keychain (a desktop); a box uses files. keystore: the vault's `vault.keystore` ("file", "passphrase" or "keychain"); a keychain home with no `destroyKeychain` is refused before anything is touched.
 *   Never reports success while a key survives: a sealing folder that holds values but no master.key file means the master is in an OS keystore, and that is refused too (name: sealing master).
 * @returns {Promise<{ vault: { key_files_destroyed: number, keychain_destroyed: boolean, tables_emptied: number, files_removed: number }, seal: { master_destroyed: boolean, removed: number } }>}
 */
export async function wipeHome({ home, vaultDir = path.join(home, "vault"), sealDir = path.join(home, "seal"), db = path.join(home, "vyre.db"), keystore = "file", destroyKeychain }) {
  let release;
  if (keystore === "keychain" && !destroyKeychain) throw refuse("keystore_survives", "the vault's key is in the OS keychain and this wipe was given no way to delete it; refusing so no key survives");
  if (sealerRunning(sealDir)) throw refuse("sealer_running", "the sealing process is running; stop it first");
  if (fs.existsSync(path.join(sealDir, "values")) && fs.readdirSync(path.join(sealDir, "values")).length && !fs.existsSync(path.join(sealDir, "master.key"))) throw refuse("keystore_survives", "the sealing master key is not a file here (an OS keystore holds it) and this wipe cannot delete it; refusing so no key survives");
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
    // Never report success while a key survives.
    const left = ["key", "key.wrapped", "secret-key"].map(f => path.join(vaultDir, f)).concat(path.join(sealDir, "master.key")).filter(f => fs.existsSync(f));
    if (left.length) throw refuse("key_survives", `a key file is still there after the wipe: ${left.map(f => path.basename(f)).join(", ")}`);
    return { vault: { key_files_destroyed: keys, keychain_destroyed: keychain, tables_emptied: tables, files_removed: files }, seal };
  } finally { release(); }
}
