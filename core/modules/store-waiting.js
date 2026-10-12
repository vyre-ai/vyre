// @ts-check
// A module that needs the Space's records and finds the record store still starting (a first start makes the Space's database; after an update on a box it takes minutes) must not FAIL the
// start. It is "waiting": it reports running with a note, its tools answer in the store's own words, and it starts for real the moment the store joins (startStoreWaiting, called by the
// daemon from the store's whenReady). The updater of an earlier version reads `vyre modules` and rolls an update back when a listed module says anything but running or off, so a slow store
// must never show as a failed module.

import { toolEntries } from "../../packages/module-sdk/manifest.js";
import { storeStarting } from "../../lib/store-away.js";

/** What a module that threw at start becomes: waiting when only the record store was away (the store's own refusal, stores/twenty/deferred-store.js), failed otherwise: other starts throw `unavailable` for reasons that are not the store. @param {any} e @returns {{ state: string, error: string, waitsForStore: boolean }} */
export function failure(e) {
  const waits = storeStarting(e);
  return { state: waits ? "waiting" : "failed", error: String((e && e.message) || e), waitsForStore: waits };
}

/** A module that requires one that is waiting waits too (it starts when that one does); otherwise it failed. @param {any} reg @param {string} dep @returns {{ state: string, error: string, waitsForStore: boolean }} */
export function requiresFailure(reg, dep) {
  const r = reg.modules.get(dep);
  return { state: r && r.state === "waiting" ? "waiting" : "failed", error: `requires "${dep}", which is not running`, waitsForStore: Boolean(r && r.state === "waiting") };
}

/** The state `vyre modules` shows: a waiting module is running (with its note), so a slow store is not a failed start. @param {any} r */
export const reported = r => (r.state === "waiting" ? "running" : r.state);

/** The module's tools while it waits: each answers, in the store's words, that records are not up yet. @param {any} reg @param {any} m the manifest @param {string} words */
export function stubTools(reg, m, words) {
  const ctx = reg.context(m);
  for (const e of toolEntries(m)) ctx.tool(e.name, { description: e.description || "", run: async () => { throw Object.assign(new Error(`${m.name} is waiting for the records: ${words}. Try again in a minute; vyre modules shows when it is up.`), { code: "unavailable" }); } });
}

/**
 * Start every waiting module again, in turn, until none of them moves (a module that requires another starts after it). Run when the record store joins, and on a timer while any module still waits (armWaiting):
 * one at a time, so the join and the timer never start a module twice. A request that arrives while a run is going (the store joined just as the timer's run ended) is not lost: the run goes round once more.
 * @param {any} reg
 */
export function startWaiting(reg) {
  if (reg.startingWaiting) { reg.startWaitingAgain = true; return reg.startingWaiting; }
  reg.startingWaiting = (async () => {
    do {
      reg.startWaitingAgain = false;
      for (let moved = true; moved;) {
        moved = false;
        for (const r of [...reg.modules.values()]) {
          if (r.state !== "waiting" || !r.waitsForStore) continue;
          for (const [t, def] of [...reg.tools]) if (def.module === r.manifest.name) reg.tools.delete(t);
          const t0 = Date.now();
          await reg.startOne({ manifest: r.manifest, dir: r.dir });
          if (reg.deps && reg.deps.log) reg.deps.log(`phase module ${r.manifest.name} ${r.state === "waiting" ? "is still waiting for the records" : "started after the store joined"}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          if (r.state !== "waiting") moved = true;
        }
      }
    } while (reg.startWaitingAgain);
  })().finally(() => { reg.startingWaiting = null; });
  return reg.startingWaiting;
}

/**
 * A module that waits for the records is tried again on a timer as well as when the store joins: the join can come before the store has its record types, and a module that started then waits again. The wait doubles from
 * `waitRetryMs` (a minute) to five minutes; one timer, only while a module waits, never keeping the server alive.
 * @param {any} reg @param {number} [n]
 */
export function armWaiting(reg, n = 0) {
  if (reg.waitTimer || reg.stopping) return;
  const ms = Math.min((reg.deps && reg.deps.waitRetryMs ? reg.deps.waitRetryMs : 60_000) * 2 ** n, 300_000);
  reg.waitTimer = setTimeout(async () => {
    reg.waitTimer = null;
    // A store that has not joined yet holds a starting module's first query for up to a minute before it refuses it; the join starts the module the moment it comes, so the timer waits for the store and never sits in that hold.
    const away = reg.deps && typeof reg.deps.storeAttached === "function" && !reg.deps.storeAttached();
    if (!away) { try { await startWaiting(reg); } catch { /* the next round tries again */ } }
    if ([...reg.modules.values()].some(r => r.state === "waiting" && r.waitsForStore)) armWaiting(reg, n + 1);
  }, ms);
  if (typeof reg.waitTimer.unref === "function") reg.waitTimer.unref();
}
