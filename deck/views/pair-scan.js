// @ts-check
// Scan your avatar to pair your phone: the redeem flow's pure state machine (no DOM, no calls,
// no crypto - deck/js/pair-scan.js wires this to the camera and deck/js/pair-ticket.js). See
// docs/work/pwa.md's "Phone-side contract" for the full flow.
//
// INTERIM shape (2026-09-28): relay/client/client.js's `pairTicket()` is atomic (resolve, verify
// and the handshake in one call), so there is no confirm-before-pairing step today - pairing
// starts the moment a ticket decodes, and the box name/fingerprint are shown AFTER, as a
// confirmation rather than a gate. Swap for a resolve-then-confirm-then-pair shape once
// tailnet's split lands (see pair-ticket.js's own header).
//
//   step(state, event) -> next state
//   initial()           the starting state

/**
 * @typedef {
 *   { kind: "scanning" } |
 *   { kind: "pairing" } |
 *   { kind: "done", box: string, fingerprint: string, name: string } |
 *   { kind: "error", code: string, message: string, retryable: boolean }
 * } State
 */

/** @returns {State} */
export function initial() { return { kind: "scanning" }; }

/**
 * @typedef {
 *   { type: "found" } |
 *   { type: "paired", box: string, fingerprint: string, name: string } |
 *   { type: "pairFailed", code?: string, message: string } |
 *   { type: "retry" }
 * } Event
 */

/**
 * @param {State} state
 * @param {Event} event
 * @returns {State}
 */
export function step(state, event) {
  switch (event.type) {
    case "found":
      if (state.kind !== "scanning") return state; // a stray late frame after we've moved on
      return { kind: "pairing" };
    case "paired":
      if (state.kind !== "pairing") return state;
      return { kind: "done", box: event.box, fingerprint: event.fingerprint, name: event.name };
    case "pairFailed":
      if (state.kind !== "pairing") return state;
      return errorFor(event.code, event.message);
    case "retry":
      return { kind: "scanning" };
    default:
      return state;
  }
}

/** Turns a refusal into words that say what to do. Per tailnet: the relay's 404 deliberately
 * covers expired, used and unknown alike (so a scanner can't fingerprint which reason applied),
 * so this can only ever say the generic version, not pick a more specific one. */
function errorFor(/** @type {string | undefined} */ code, /** @type {string} */ message) {
  if (code === "rate_limited") return { kind: "error", code, message: "Too many tries. Wait a moment and scan again.", retryable: true };
  if (code === "not_found") return { kind: "error", code, message: "That code expired or was already used. Open Add your phone again on your Mac.", retryable: true };
  return { kind: "error", code: code || "error", message: message || "Something went wrong. Try again.", retryable: true };
}
