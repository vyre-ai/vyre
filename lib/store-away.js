// @ts-check
// Is this error the Space's record store saying it is not there yet, or still starting? The deferred store refuses with the name StoreError; the kernel's gateway passes its code and words on under its own
// name (KernelError, code "unavailable", the words kept: "the record store is still starting: preparing its record types (80 seconds so far)"). Either way it is a wait, not a failure. `unavailable` for any other
// reason (no way to reach a paired server) is not this.

/** @param {any} e */
export const storeStarting = e => Boolean(e) && e.code === "unavailable" && (e.name === "StoreError" || /not available yet|still starting/.test(String(e.message || "")));

/**
 * How long to wait before try number `n` (0 is the first retry): doubling from `base` up to `max`; past `tries` quick tries, the slow wait. The one schedule for a thing that waits for the record store: a module that
 * waits for it (core/modules/store-waiting.js) and the Flows host's record types (core/daemon/flows-host.js).
 * @param {number} n @param {{ base?: number, max?: number, tries?: number, slow?: number }} [o]
 */
export const retryAfter = (n, o = {}) => (o.tries !== undefined && n >= o.tries ? (o.slow ?? o.max ?? 300_000) : Math.min((o.base ?? 60_000) * 2 ** n, o.max ?? 300_000));
