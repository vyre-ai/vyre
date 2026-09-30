// @ts-check
// The one grant (reviewer-2 H2, PLAN.md P15): a box-side or ACP agent may drive this Mac only
// once a person names it here, on the Mac itself. Granting needs presence (the grant moment
// itself is the one friction point); revoking does not, since taking access away is never the
// thing a "no nag" rule protects against. An ungranted caller is denied, not silently refused as
// though the tool did not exist, so an agent (and a person reading the log) can tell "not built"
// from "not granted" from "floor".

export const MIGRATIONS = [
  `CREATE TABLE hands_grants (
     agent TEXT PRIMARY KEY, granted_at INTEGER NOT NULL, by TEXT
   );`,
];

/** @param {import("node:sqlite").DatabaseSync} db */
export function grants(db) {
  return {
    /** Every agent granted to drive this Mac, oldest first. */
    list() {
      return /** @type {{agent: string, granted_at: number, by: string|null}[]} */ (
        db.prepare("SELECT agent, granted_at, by FROM hands_grants ORDER BY granted_at").all()
      );
    },
    has(/** @type {string} */ agent) {
      return Boolean(db.prepare("SELECT 1 FROM hands_grants WHERE agent = ?").get(agent));
    },
    add(/** @type {string} */ agent, /** @type {string|null} */ by, /** @type {number} */ now) {
      db.prepare(`INSERT INTO hands_grants (agent, granted_at, by) VALUES (?, ?, ?)
        ON CONFLICT(agent) DO UPDATE SET granted_at = excluded.granted_at, by = excluded.by`).run(agent, now, by || null);
      return { agent, granted: true };
    },
    remove(/** @type {string} */ agent) {
      const r = db.prepare("DELETE FROM hands_grants WHERE agent = ?").run(agent);
      return { agent, revoked: r.changes > 0 };
    },
  };
}
