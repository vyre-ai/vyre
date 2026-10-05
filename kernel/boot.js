// kernel/boot.js: the durable kernel on the home. The same composition root as `createKernel` (kernel/index.js), with the durable event log (the home's SQLite)
// in place of the in-memory one. Records live in the Space's own store (Twenty), which the caller brings; a packaged build with none gets a store that refuses every
// record call, a development build the in-memory reference store. A first start makes the first owner; a restart rebuilds every grant, member, offer, once-mark,
// meter and rate window from the log. The daemon calls this when the kernel is on (team/0.3/KERNEL-default-on.md); until then nothing does.
import { createKernel } from "./index.js";
import { createRefusingStore } from "./store/refusing.js";
import { isPackaged } from "./devbuild.js";
import { createSqliteEventLog } from "./store/sqlite-log.js";

/**
 * @param {{ db: import("node:sqlite").DatabaseSync, space: string, owner: string, owner_uid: number, key?: Uint8Array | string, clock?: () => number } & Record<string, any>} cfg
 *   everything else is `createKernel`'s: sealer, door, expr, onStageEnter, templates, destinations, ...
 */
export async function bootKernel(cfg) {
  const { db, ...rest } = cfg;
  const log = createSqliteEventLog({ db, space: cfg.space, clock: cfg.clock });
  // The record store is the Space's own (the per-Space Twenty, stores/twenty/space-store.js). With none, a packaged build refuses every record call and says why; a development
  // build uses the in-memory reference store (createKernel's default), which the test suites rely on and nothing ships.
  const store = rest.store || (isPackaged(rest.packageRoot) ? createRefusingStore("no record store was given") : undefined);
  // The task store for free text (kernel/tasks): the log carries only hashes of what a person or an assistant typed, the text lives here, and a scrub can empty it.
  db.exec("CREATE TABLE IF NOT EXISTS kernel_task_texts (task TEXT PRIMARY KEY, text TEXT NOT NULL)");
  const getT = db.prepare("SELECT text FROM kernel_task_texts WHERE task = ?"), putT = db.prepare("INSERT INTO kernel_task_texts (task, text) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET text = excluded.text"), delT = db.prepare("DELETE FROM kernel_task_texts WHERE task = ?");
  const texts = { get: (/** @type {string} */ id) => { const r = /** @type {any} */ (getT.get(String(id))); try { return r ? JSON.parse(r.text) : undefined; } catch { return undefined; } }, set: (/** @type {string} */ id, /** @type {any} */ v) => { if (v === undefined) delT.run(String(id)); else putT.run(String(id), JSON.stringify(v)); }, drop: (/** @type {string} */ id) => { delT.run(String(id)); }, all: () => /** @type {any[]} */ (db.prepare("SELECT task, text FROM kernel_task_texts").all()).map(r => { try { return [r.task, JSON.parse(r.text)]; } catch { return [r.task, null]; } }) };
  return await createKernel({ ...rest, log, ...(store ? { store } : {}), texts });
}
