// @ts-check
// lib/sandbox: shared by the watchers runtime and platform's module host. One place for the rules
// about what a sandboxed child may reach: its own uid, no network of its own, and a parent-run
// GET/HEAD fetch that refuses every non-public address after DNS and on every redirect.
export { isPublicAddress } from "./addr.js";
export { mediatedFetch, FetchRefused, FETCH_LIMITS } from "./fetch.js";
export { sandboxIdentity } from "./identity.js";

/** Tests only: fetch options a test sets to let a watcher reach its own loopback fixture. Children cannot reach this object. */
export const testHooks = { net: /** @type {object} */ ({}) };
