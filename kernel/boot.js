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
  // a store the caller made (a Space on Twenty, stores/twenty/space-store.js) replaces the SQLite one
  const store = cfg.store || createSqliteStore({ db, clock: cfg.clock });
  return await createKernel({ ...rest, log, store });
}
