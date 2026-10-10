// @ts-check
// Start-up work that needs the Space's record store, when the store is still starting (a team Space's own store takes minutes the first time): try again after a pause instead of giving up until the next
// restart. Only "the store is away" is retried; any other failure is the caller's to say. The pause doubles up to a minute, and the timer never keeps the server alive.

/** Is this the record store being away (not yet attached), as the deferred store and the gateway say it? @param {any} e */
export const storeAway = e => Boolean(e) && (e.code === "unavailable" || /not available yet|still starting/.test(String(e.message)));

/**
 * Run `f` now; when the store is away, run it again after a growing pause until it gets through, then resolve with its answer. Rejects with any other error at once, and with the last one if `stop()` says so.
 * @template T @param {() => Promise<T>} f @param {{ firstMs?: number, maxMs?: number, stop?: () => boolean }} [o] @returns {Promise<T>}
 */
export async function retryWhileAway(f, o = {}) {
  const first = o.firstMs ?? 5_000, max = o.maxMs ?? 60_000;
  for (let n = 0; ; n++) {
    try { return await f(); }
    catch (e) {
      if (!storeAway(e) || (o.stop && o.stop())) throw e;
      await new Promise(r => { const t = setTimeout(r, Math.min(first * 2 ** n, max)); if (typeof t.unref === "function") t.unref(); });
    }
  }
}
