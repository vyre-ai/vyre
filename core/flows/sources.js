// @ts-check
// sources: where each Kit on this Space came from.
//
// A Kit is installed from a file on a person's computer or from an https address. The install
// itself is the kernel's record (the kit-install row): what the Kit added, who said yes and when.
// This keeps the pointer to where it came from, and the version that was proposed from it, so the
// Space can show where a Kit came from and which version it is at.
//
// It is operational state about a pointer, not the Space's own records: one row per Kit, no
// content of the Kit, and never a secret (the source is a path or an address with nothing in it).

/**
 * The module's own store: the rows it keeps beside the kernel's own records.
 * @typedef {{ db: { prepare(sql: string): { run(...args: any[]): any, all(...args: any[]): any[] } } }} SourceStore
 */

/** The steps that made the table. Append only: a released step never moves. */
export const MIGRATIONS = [`
  CREATE TABLE flows_kit_sources (
    kit_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    source TEXT NOT NULL,
    at INTEGER NOT NULL
  );
`];

const TABLE = "flows_kit_sources";

/**
 * Remember where a Kit was proposed from. A later proposal from another place replaces it: the
 * newest source is the one the Space shows.
 * @param {SourceStore} store the module's store
 * @param {string} kitId @param {number} version @param {string} source
 * @param {(message: string) => void} [log] where a failure is said
 */
export function rememberSource(store, kitId, version, source, log) {
  try {
    store.db.prepare(`INSERT INTO ${TABLE} (kit_id, version, source, at) VALUES (?, ?, ?, ?) ON CONFLICT(kit_id) DO UPDATE SET version = excluded.version, source = excluded.source, at = excluded.at`)
      .run(String(kitId), Number(version) || 0, String(source), Date.now());
  } catch (e) {
    // The source is a pointer: the install stands without it, and the Space shows no source.
    if (log) log(`kit source not kept for ${kitId}: ${String(/** @type {Error} */ (e).message || e)}`);
  }
}

/**
 * Forget a Kit that is gone.
 * @param {SourceStore} store @param {string} kitId
 */
export function forgetSource(store, kitId) {
  try { store.db.prepare(`DELETE FROM ${TABLE} WHERE kit_id = ?`).run(String(kitId)); } catch { /* there was no row to forget */ }
}

/**
 * The source of each Kit, by its id.
 * @param {SourceStore} store
 * @returns {Map<string, { source: string, version: number }>}
 */
export function sourcesFor(store) {
  /** @type {Map<string, { source: string, version: number }>} */
  const out = new Map();
  try {
    for (const r of /** @type {any[]} */ (store.db.prepare(`SELECT kit_id, version, source FROM ${TABLE}`).all())) {
      out.set(String(r.kit_id), { source: String(r.source), version: Number(r.version) || 0 });
    }
  } catch { /* no table yet: no Kit has a source */ }
  return out;
}
