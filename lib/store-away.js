// @ts-check
// Is this error the Space's record store saying it is not there yet, or still starting? The deferred store refuses with the name StoreError; the kernel's gateway passes its code and words on under its own
// name (KernelError, code "unavailable", the words kept: "the record store is still starting: preparing its record types (80 seconds so far)"). Either way it is a wait, not a failure. `unavailable` for any other
// reason (no way to reach a paired server) is not this.

/** @param {any} e */
export const storeStarting = e => Boolean(e) && e.code === "unavailable" && (e.name === "StoreError" || /not available yet|still starting/.test(String(e.message || "")));
