// @ts-check
// A space's record store answers unavailable until its database is up (a cold Twenty takes minutes): retry for a bounded time, then say so.

/** Retry a call while the space's record store is still starting (it answers unavailable until its database is up). @param {any} w @param {string} tool @param {any} input */
export async function whenStoreIsUp(w, tool, input) {
  const end = Date.now() + 6 * 60_000;
  for (;;) {
    try { return await w.call(tool, input); } catch (e) {
      if (!(/** @type {any} */ (e).code === "unavailable") || Date.now() > end) throw e;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
