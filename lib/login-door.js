// @ts-check
// Where the sign-in listener (core/identity) is on loopback. The identity module sets it when it listens and clears it when it stops; the public gate (core/wink) asks.
// One number, so the gate learns it without a tool of its own.

/** @type {number | null} */
let port = null;

/** @param {number | null} p */
export function setLoginPort(p) { port = Number.isInteger(p) && /** @type {number} */ (p) > 0 ? /** @type {number} */ (p) : null; }

/** @returns {number | null} */
export function loginPort() { return port; }

/** The running sign-in service (kernel/identity/space-login.js), for the identity module's own tools: list a person's sign-ins and revoke one. @type {any} */
let service = null;
/** @param {any} svc */
export function setLoginService(svc) { service = svc || null; }
export function loginService() { return service; }
