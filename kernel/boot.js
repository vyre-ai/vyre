// kernel/boot.js: the durable kernel on the home. The same composition root as `createKernel` (kernel/index.js), with the durable event log and the durable
// store (the home's SQLite) in place of the in-memory ones. A first start makes the first owner; a restart rebuilds every grant, member, offer, once-mark,
// meter and rate window from the log. The daemon calls this when the kernel is on (team/0.3/KERNEL-default-on.md); until then nothing does.
import { createKernel } from "./index.js";
import { createSqliteStore } from "./store/sqlite.js";
import { createSqliteEventLog } from "./store/sqlite-log.js";

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
  const texts = { get: (/** @type {string} */ id) => { const r = /** @type {any} */ (getT.get(String(id))); try { return r ? JSON.parse(r.text) : undefined; } catch { return undefined; } }, set: (/** @type {string} */ id, /** @type {any} */ v) => { if (v === undefined) delT.run(String(id)); else putT.run(String(id), JSON.stringify(v)); }, drop: (/** @type {string} */ id) => { delT.run(String(id)); } };
  return await createKernel({ ...rest, log, store, texts });
}
