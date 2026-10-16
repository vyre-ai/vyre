// @ts-check
// core/switchboard/inbox-prune.js: retention for delivered inbox rows. Split out of index.js (its line budget).

/**
 * Drop delivered rows older than 30 days, and all but the newest 200 delivered rows of any thread. Safe to call often.
 * @param {any} db @param {(msg: string) => void} log @param {number} now
 */
export function pruneInbox(db, log, now = Date.now()) {
  const cutoff = now - 30 * 86400_000;
  const keep = 200;
  try {
    db.prepare("DELETE FROM threads_inbox WHERE delivered_at IS NOT NULL AND delivered_at < ?").run(cutoff);
    for (const { thread } of /** @type {any[]} */ (db.prepare("SELECT DISTINCT thread FROM threads_inbox WHERE delivered_at IS NOT NULL").all())) {
      const rows = /** @type {any[]} */ (db.prepare("SELECT id FROM threads_inbox WHERE thread = ? AND delivered_at IS NOT NULL ORDER BY delivered_at DESC, id DESC").all(thread));
      for (const r of rows.slice(keep)) db.prepare("DELETE FROM threads_inbox WHERE id = ?").run(r.id);
    }
  } catch (e) { log(`pruning threads_inbox failed: ${/** @type {Error} */ (e).message}`); }
}
