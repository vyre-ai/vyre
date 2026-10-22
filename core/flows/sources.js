// @ts-check
// sources: where each Kit on this Space came from.
//
// A Kit is installed from a file on a person's computer or from an https address. The install
// itself is the kernel's record (the kit-install row): what the Kit added, who said yes and when.
// This keeps the pointer to where a version of a Kit came from, so the Space can show where the
// Kit that is installed came from.
//
// The pointer is keyed by the Kit AND its version: a proposal for another version says nothing
// about the version on the Space, so the Space shows the row of the version that is installed and
// nothing else. A Kit installed from the library has no row of its own and shows no source.
//
// It is operational state about a pointer, not the Space's own records: no content of the Kit in
// it, and never a secret (the source is a path or an address with nothing in it).

/**
 * The module's own store: the rows it keeps beside the kernel's own records.
 * @typedef {{ db: { exec(sql: string): void, prepare(sql: string): { run(...args: any[]): any, all(...args: any[]): any[] } } }} SourceStore
 */

/**
 * The table this module keeps: where each version of a Kit came from. IF NOT EXISTS, so the step
 * can be run again without failing and the table can be made at the moment it is first needed.
 */
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS flows_kit_sources (
    kit_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    source TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (kit_id, version)
  )`;

/** The steps that made the table. Append only: a released step never moves. */
export const MIGRATIONS = [
  // The first step kept one row per Kit, written when a Kit was proposed. It stays as it was.
  `CREATE TABLE IF NOT EXISTS flows_kit_sources (kit_id TEXT PRIMARY KEY, version INTEGER NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL)`,
  // The second step keys the pointer by the Kit and its version, so the Space shows where the version that is installed came from. The rows the first step wrote are dropped, not carried: they were written when a Kit was proposed and could name the wrong origin, which is what this step fixes. The first step never shipped (this module is new to the released list), so no released box has rows to lose.
  `DROP TABLE IF EXISTS flows_kit_sources;\n${TABLE_SQL}`,
];

const TABLE = "flows_kit_sources";

/**
 * The key a pointer is kept under: the Kit and the version it was proposed from.
 * @param {any} kitId @param {any} version
 */
export const sourceKey = (kitId, version) => `${String(kitId)}|${Number(version) || 0}`;

/**
 * The table, made when it is not there yet. The module's own numbered step makes it when the
 * module starts; this makes it again if that step could not run (the database was busy with the
 * kernel's own work), so the pointer is kept either way.
 * @param {SourceStore} store
 */
export function ensureTable(store) {
  try { store.db.exec(TABLE_SQL); return true; } catch { /* the table cannot be made right now */ return false; }
}

/**
 * Remember where a version of a Kit was proposed from. A later proposal of that same version from
 * another place replaces it: the newest source of that version is the one the Space shows.
 * @param {SourceStore} store the module's store
 * @param {string} kitId @param {number} version @param {string} source
 * @param {(message: string) => void} [log] where a failure is said
 */
export function rememberSource(store, kitId, version, source, log) {
  try {
    ensureTable(store);
    store.db.prepare(`INSERT INTO ${TABLE} (kit_id, version, source, at) VALUES (?, ?, ?, ?) ON CONFLICT(kit_id, version) DO UPDATE SET version = excluded.version, source = excluded.source, at = excluded.at`)
      .run(String(kitId), Number(version) || 0, String(source), Date.now());
  } catch (e) {
    // The source is a pointer: the install stands without it, and the Space shows no source.
    if (log) log(`kit source not kept for ${kitId}: ${String(/** @type {Error} */ (e).message || e)}`);
  }
}

/**
 * Forget where one version of a Kit came from: a proposal of that version with no source says it
 * came from nowhere.
 * @param {SourceStore} store @param {string} kitId @param {number} version
 */
export function forgetVersion(store, kitId, version) {
  try { store.db.prepare(`DELETE FROM ${TABLE} WHERE kit_id = ? AND version = ?`).run(String(kitId), Number(version) || 0); } catch { /* there was no row to forget */ }
}

/**
 * Forget a Kit that is gone: every version of it, and every pointer.
 * @param {SourceStore} store @param {string} kitId
 */
export function forgetSource(store, kitId) {
  try { store.db.prepare(`DELETE FROM ${TABLE} WHERE kit_id = ?`).run(String(kitId)); } catch { /* there was no row to forget */ }
}

/**
 * The source of each version of each Kit, by the Kit and the version. A read reads: if the table
 * is not there yet, no Kit has a source, and nothing is made here.
 * @param {SourceStore} store
 * @returns {Map<string, { source: string, version: number }>}
 */
export function sourcesFor(store) {
  /** @type {Map<string, { source: string, version: number }>} */
  const out = new Map();
  try {
    for (const r of /** @type {any[]} */ (store.db.prepare(`SELECT kit_id, version, source FROM ${TABLE}`).all())) {
      out.set(sourceKey(r.kit_id, r.version), { source: String(r.source), version: Number(r.version) || 0 });
    }
  } catch { /* no table yet: no Kit has a source */ }
  return out;
}
