// @ts-check
// Scan your avatar to pair your phone: the redeem flow's pure state machine (no DOM, no calls -
// deck/js/pair-scan.js wires this to the camera and the relay). See docs/work/pwa.md's "Scan to
// pair" section for the full flow and what each tool call is expected to return.
//
//   step(state, event) -> next state
//   initial()           the starting state

/**
 * @typedef {
 *   { kind: "scanning" } |
 *   { kind: "resolving", ticket: string } |
 *   { kind: "confirm", ticket: string, box: string, fingerprint: string } |
 *   { kind: "pairing", box: string, fingerprint: string } |
 *   { kind: "done", box: string } |
 *   { kind: "error", code: string, message: string, retryable: boolean }
 * } State
 */

/** @returns {State} */
export function initial() { return { kind: "scanning" }; }

/**
 * @typedef {
 *   { type: "found", ticket: string } |
 *   { type: "resolved", box: string, fingerprint: string } |
 *   { type: "resolveFailed", code?: string, message: string } |
 *   { type: "confirm" } |
 *   { type: "paired", box: string } |
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
      return { kind: "resolving", ticket: event.ticket };
    case "resolved":
      if (state.kind !== "resolving") return state;
      return { kind: "confirm", ticket: state.ticket, box: event.box, fingerprint: event.fingerprint };
    case "resolveFailed":
      if (state.kind !== "resolving") return state;
      return errorFor(event.code, event.message, "resolve");
    case "confirm":
      if (state.kind !== "confirm") return state;
      return { kind: "pairing", box: state.box, fingerprint: state.fingerprint };
    case "paired":
      if (state.kind !== "pairing") return state;
      return { kind: "done", box: event.box };
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
 * sense (a used-up or expired ticket does; a network hiccup does; a wrong-box mismatch does not
 * until the person is actually looking at the right box). */
function errorFor(/** @type {string | undefined} */ code, /** @type {string} */ message, /** @type {"resolve" | "pair"} */ stage) {
  if (code === "ticket_expired") return { kind: "error", code, message: "That code expired. On your Mac, open Add your phone again for a fresh one.", retryable: true };
  if (code === "ticket_used") return { kind: "error", code, message: "That code was already used. Open Add your phone again on your Mac.", retryable: true };
  if (code === "ticket_not_found" || code === "bad_ticket") return { kind: "error", code, message: "That didn't look like a Vyre code. Try scanning again.", retryable: true };
  if (code === "rate_limited") return { kind: "error", code, message: "Too many tries. Wait a moment and scan again.", retryable: true };
  if (stage === "pair" && code === "denied") return { kind: "error", code, message: "Pairing was refused on your Mac.", retryable: true };
  return { kind: "error", code: code || "error", message: message || "Something went wrong. Try again.", retryable: true };
}
