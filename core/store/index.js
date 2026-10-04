// @ts-check
// store — the one SQLite database, and how every module gets its own corner of it.
//
// Two rules came from real failures in the prototype:
//   - WAL plus a busy timeout on EVERY connection. Without both, a second writer does not wait,
//     it fails; an embedding job died two thousand turns in because another process held the
//     lock for a second.
//   - Each module owns tables prefixed with its own name and migrates them itself, so modules
//     built in parallel by different people never collide on a table.

import "../../lib/mac-test-refusal.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/** Open the database with the settings every connection needs. */
export function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // The database holds transcripts and memory: private to this user, as are its WAL files.
  const old = process.umask(0o077);
  let db;
  try {
    db = new DatabaseSync(file);
    // busy_timeout FIRST: switching to WAL itself needs a lock, and with the timeout not yet set a second
    // process opening the same file (the installer's `code` command while the daemon starts) failed at once with "database is locked".
    db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  } finally { process.umask(old); }
  fs.chmodSync(file, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (module, version)
  )`);
  return db;
}

/**
 * Apply a module's migrations in order, each exactly once, each in a transaction.
 * @param {DatabaseSync} db
 * @param {string} module  the module's name; its tables must start with "<module>_"
 * @param {string[]} steps SQL, one string per version, never edited once released
 */
export function migrate(db, module, steps) {
  const done = new Set(db.prepare("SELECT version FROM _migrations WHERE module = ?").all(module).map(r => Number(r.version)));
  steps.forEach((sql, i) => {
    const v = i + 1;
    if (done.has(v)) return;
    for (const m of sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi)) {
      if (!m[1].startsWith(module.replace(/-/g, "_") + "_") && m[1] !== module) {
        throw new Error(`module ${module} tried to create table ${m[1]}; its tables must start with "${module.replace(/-/g, "_")}_"`);
      }
    }
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (module, version, at) VALUES (?,?,?)").run(module, v, Date.now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${module} v${v} failed: ${/** @type {Error} */ (e).message}`);
    }
  });
}
