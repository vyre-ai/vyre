// kernel/boot.js: the durable kernel on the home. The same composition root as `createKernel` (kernel/index.js), with the durable event log and the durable
// store (the home's SQLite) in place of the in-memory ones. A first start makes the first owner; a restart rebuilds every grant, member, offer, once-mark,
// meter and rate window from the log. The daemon calls this when the kernel is on (team/0.3/KERNEL-default-on.md); until then nothing does.
import { createKernel } from "./index.js";
import { createSqliteStore } from "./store/sqlite.js";
import { createSqliteEventLog } from "./store/sqlite-log.js";

/**
 * One database transaction for a record write and its event: the built-in store's change and the log's insert commit together (one fsync instead of two) or not at all.
 * `begin()` opens it (null when one is already open, so a caller falls back to committing as it goes) and the caller commits or rolls back. It is held only across steps that never wait on
 * anything but the microtask queue, so no other writer on this connection can run inside it (the database is shared with every module in the daemon).
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function createUnit(db) {
  let tail = /** @type {Promise<any>} */ (Promise.resolve());
  return Object.freeze({
    /** Wait for the unit in front (writers take turns: a second writer must not run inside the first one's transaction), then open one. @returns {Promise<{ commit(): void, rollback(): void, abandon(): void }>} */
    begin() {
      /** @type {() => void} */ let release = () => {};
      const mine = new Promise(res => { release = () => res(undefined); });
      const prev = tail;
      tail = prev.then(() => mine);
      return prev.then(() => {
        try { db.exec("BEGIN IMMEDIATE"); } catch (e) { release(); throw e; }
        let done = false;
        const end = (/** @type {string} */ sql) => { if (done) return; done = true; try { db.exec(sql); } finally { release(); } };
        return {
          commit() { end("COMMIT"); },
          rollback() { try { end("ROLLBACK"); } catch { /* the transaction is already gone */ } },
          /** Safety net for a path that never settled the unit: roll back and let the next writer in. */
          abandon() { try { end("ROLLBACK"); } catch { /* nothing to roll back */ } },
        };
      });
    },
  });
}

/**
 * @param {{ db: import("node:sqlite").DatabaseSync, space: string, owner: string, owner_uid: number, key?: Uint8Array | string, clock?: () => number } & Record<string, any>} cfg
 *   everything else is `createKernel`'s: sealer, door, expr, onStageEnter, templates, destinations, ...
 */
export async function bootKernel(cfg) {
  const { db, ...rest } = cfg;
  const log = createSqliteEventLog({ db, space: cfg.space, clock: cfg.clock });
  // The record store is the home's SQLite unless the caller brings the Space's own (the per-Space Twenty, records/space-store.js).
  const store = rest.store || createSqliteStore({ db, clock: cfg.clock });
  // The task store for free text (kernel/tasks): the log carries only hashes of what a person or an assistant typed, the text lives here, and a scrub can empty it.
  db.exec("CREATE TABLE IF NOT EXISTS kernel_task_texts (task TEXT PRIMARY KEY, text TEXT NOT NULL)");
  const getT = db.prepare("SELECT text FROM kernel_task_texts WHERE task = ?"), putT = db.prepare("INSERT INTO kernel_task_texts (task, text) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET text = excluded.text"), delT = db.prepare("DELETE FROM kernel_task_texts WHERE task = ?");
  const texts = { get: (/** @type {string} */ id) => { const r = /** @type {any} */ (getT.get(String(id))); try { return r ? JSON.parse(r.text) : undefined; } catch { return undefined; } }, set: (/** @type {string} */ id, /** @type {any} */ v) => { if (v === undefined) delT.run(String(id)); else putT.run(String(id), JSON.stringify(v)); }, drop: (/** @type {string} */ id) => { delT.run(String(id)); }, all: () => /** @type {any[]} */ (db.prepare("SELECT task, text FROM kernel_task_texts").all()).map(r => { try { return [r.task, JSON.parse(r.text)]; } catch { return [r.task, null]; } }) };
  // The unit of work exists only where the record store and the log are the same database: the built-in store, not one the caller brought (Twenty).
  return await createKernel({ ...rest, log, store, texts, ...(rest.store ? {} : { unit: createUnit(db) }) });
}
