// @ts-check
// Start-up work that needs the Space's record store, when the store is still starting (a team Space's own store takes minutes the first time): try again after a pause instead of giving up until the next
// restart. Only "the store is away" is retried; any other failure is the caller's to say. The pause doubles up to a minute, and the timer never keeps the server alive.

/** Is this the record store being away (not yet attached), as the deferred store and the gateway say it? @param {any} e */
export const storeAway = e => Boolean(e) && (e.code === "unavailable" || /not available yet|still starting/.test(String(e.message)));

/**
 * Run `f` the moment the Space's record store joins (a store still starting has `attached()` false and takes `whenReady` callbacks), so start-up work that retried on a pause does not wait out the pause once Records is
 * ready. Does nothing for a store that is already attached (the caller's own first try covers that) or that has no such hooks. Safe to run beside retryWhileAway: what it runs is idempotent.
 * @param {any} store @param {() => any} f
 */
export function whenStoreJoins(store, f) {
  if (store && typeof store.attached === "function" && !store.attached() && typeof store.whenReady === "function") store.whenReady(() => { try { const r = f(); if (r && typeof r.catch === "function") r.catch(() => {}); } catch { /* the pause-and-retry covers it */ } });
}

/**
 * Run `f` now; when the store is away, run it again after a growing pause until it gets through, then resolve with its answer. Rejects with any other error at once, and with the last one if `stop()` says so.
 * @template T @param {() => Promise<T>} f @param {{ firstMs?: number, maxMs?: number, stop?: () => boolean, said?: (message: string, tries: number) => void }} [o] `said`: told each time the answer changes (the first miss, then a different one), so a retry that never gets through is not silent @returns {Promise<T>}
 */
export async function retryWhileAway(f, o = {}) {
  const first = o.firstMs ?? 5_000, max = o.maxMs ?? 60_000;
  let last = "";
  for (let n = 0; ; n++) {
    try { return await f(); }
    catch (e) {
      if (!storeAway(e) || (o.stop && o.stop())) throw e;
      { const m = String(/** @type {any} */ (e).message || e).slice(0, 300); if (o.said && m !== last) { last = m; try { o.said(m, n + 1); } catch { /* a log line never stops the retry */ } } }
      await new Promise(r => { const t = setTimeout(r, Math.min(first * 2 ** n, max)); if (typeof t.unref === "function") t.unref(); });
    }
  }
}
