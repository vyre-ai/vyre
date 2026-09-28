// @ts-check
// Scan your avatar to pair your phone: the redeem flow's pure state machine (no DOM, no calls,
// no crypto - deck/js/pair-scan.js wires this to the camera and deck/js/pair-ticket.js). See
// docs/work/pwa.md's "Phone-side contract" for the full flow, and reviewer's verdict on work/pwa
// bdca618b for why the ticket itself never appears as a value here past `found` (deck/js/
// pair-ticket.js derives everything it needs from it and never hands the raw ticket back).
//
//   step(state, event) -> next state
//   initial()           the starting state

/**
 * @typedef {
 *   { kind: "scanning" } |
 *   { kind: "resolving" } |
 *   { kind: "confirm", box: string, fingerprint: string, name: string, handle: string } |
 *   { kind: "pairing", box: string, fingerprint: string, name: string, handle: string } |
 *   { kind: "done", box: string, fingerprint: string, name: string, handle: string } |
 *   { kind: "error", code: string, message: string, retryable: boolean }
 * } State
 */

/** @returns {State} */
export function initial() { return { kind: "scanning" }; }

/**
 * @typedef {
 *   { type: "found" } |
 *   { type: "resolved", box: string, fingerprint: string, handle: string, defaultName: string } |
 *   { type: "resolveFailed", code?: string, message: string } |
 *   { type: "rename", name: string } |
 *   { type: "confirm" } |
 *   { type: "paired", box?: string } |
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
      return { kind: "resolving" };
    case "resolved":
      if (state.kind !== "resolving") return state;
      return { kind: "confirm", box: event.box, fingerprint: event.fingerprint, handle: event.handle, name: event.defaultName };
    case "resolveFailed":
      if (state.kind !== "resolving") return state;
      return errorFor(event.code, event.message, "resolve");
    case "rename":
      if (state.kind !== "confirm") return state;
      return { ...state, name: event.name.slice(0, 60) };
    case "confirm":
      if (state.kind !== "confirm") return state;
      return { kind: "pairing", box: state.box, fingerprint: state.fingerprint, name: state.name, handle: state.handle };
    case "paired":
      if (state.kind !== "pairing") return state;
      return { kind: "done", box: event.box || state.box, fingerprint: state.fingerprint, name: state.name, handle: state.handle };
    case "pairFailed":
      if (state.kind !== "pairing") return state;
      return errorFor(event.code, event.message, "pair");
    case "retry":
      return { kind: "scanning" };
    default:
      return state;
  }
}

/** Turns a refusal into words that say what to do, and whether "point your camera again" makes
 * sense (a used-up or expired ticket does; a network hiccup does). */
function errorFor(/** @type {string | undefined} */ code, /** @type {string} */ message, /** @type {"resolve" | "pair"} */ stage) {
  if (code === "ticket_expired") return { kind: "error", code, message: "That code expired. On your Mac, open Add your phone again for a fresh one.", retryable: true };
  if (code === "ticket_used") return { kind: "error", code, message: "That code was already used. Open Add your phone again on your Mac.", retryable: true };
  if (code === "ticket_not_found" || code === "bad_ticket") return { kind: "error", code, message: "That didn't look like a Vyre code. Try scanning again.", retryable: true };
  if (code === "rate_limited") return { kind: "error", code, message: "Too many tries. Wait a moment and scan again.", retryable: true };
  if (stage === "pair" && code === "denied") return { kind: "error", code, message: "Pairing was refused.", retryable: true };
  return { kind: "error", code: code || "error", message: message || "Something went wrong. Try again.", retryable: true };
}
