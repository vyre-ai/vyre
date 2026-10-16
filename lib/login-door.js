// @ts-check
// Where the sign-in listener (core/identity) is on loopback. The identity module sets it when it listens and clears it when it stops; the public gate (core/wink) asks.
// One number, so the gate learns it without a tool of its own.

/** @type {number | null} */
let port = null;

/** @param {number | null} p */
export function setLoginPort(p) { port = Number.isInteger(p) && /** @type {number} */ (p) > 0 ? /** @type {number} */ (p) : null; }

/** @returns {number | null} */
export function loginPort() { return port; }
