import { within } from "../../lib/within.js";

/** Wait for every promise, but no longer than ms: true when it gave up, false when they all settled in time. */
export const boundedWait = (promises, ms) => within(Promise.all(promises).then(() => false), ms, true);
