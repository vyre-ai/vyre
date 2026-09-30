// @ts-check
// Scan your avatar to pair your phone: the redeem flow's pure state machine (no DOM, no calls,
// no crypto - deck/js/pair-scan.js wires this to the camera and deck/js/pair-ticket.js). See
// docs/work/pwa.md's "Phone-side contract" for the full flow.
//
// The real shape now (tailnet's split, work/tailnet 13852c7a): scan -> resolveTicket() (look up
// and verify, no pairing) -> show "Pair with <name> (<fingerprint>)?" -> the person confirms ->
// pairOffer() (the handshake) -> done. "Not this one" drops the resolved offer (it carries the
// derived pairing secret) without ever pairing.
//
//   step(state, event) -> next state
//   initial()           the starting state

/**
 * @typedef {
 *   { kind: "scanning" } |
 *   { kind: "resolving" } |
 *   { kind: "confirm", name: string, fingerprint: string, handle: string | null } |
 *   { kind: "pairing", name: string, fingerprint: string, handle: string | null } |
 *   { kind: "done", box: string, fingerprint: string, deviceName: string, handle: string | null } |
 *   { kind: "error", code: string, message: string, retryable: boolean }
 * } State
 */

/** @returns {State} */
export function initial() { return { kind: "scanning" }; }

/**
 * @typedef {
 *   { type: "found" } |
 *   { type: "resolved", name: string, fingerprint: string, handle: string | null } |
 *   { type: "resolveFailed", code?: string, message: string } |
 *   { type: "confirm" } |
 *   { type: "notThisOne" } |
 *   { type: "paired", box: string, deviceName: string } |
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
      return { kind: "confirm", name: event.name, fingerprint: event.fingerprint, handle: event.handle };
    case "resolveFailed":
      if (state.kind !== "resolving") return state;
      return errorFor(event.code, event.message);
    case "confirm":
      if (state.kind !== "confirm") return state;
      return { kind: "pairing", name: state.name, fingerprint: state.fingerprint, handle: state.handle };
    case "notThisOne":
      if (state.kind !== "confirm") return state;
      return { kind: "scanning" }; // the offer this state carried (in the DOM layer, not here) is dropped, never used
    case "paired":
      if (state.kind !== "pairing") return state;
      return { kind: "done", box: event.box, fingerprint: state.fingerprint, deviceName: event.deviceName, handle: state.handle };
    case "pairFailed":
      if (state.kind !== "pairing") return state;
      return errorFor(event.code, event.message);
    case "retry":
      return { kind: "scanning" };
    default:
      return state;
  }
}

/** Turns a refusal into a shown state. The wording itself comes from the caller (deck/js/
 * pair-ticket.js's classifyError(), the one place that maps relay/client's stable `.code`
 * values - ticket_gone, rate_limited, bad_record, bad_input, pair_failed - to words), so this
 * doesn't re-derive it a second time; it only ever needs `retryable`, which is always true here
 * (every refusal this flow can hit ends in "scan again", never a dead end). */
function errorFor(/** @type {string | undefined} */ code, /** @type {string} */ message) {
  return { kind: "error", code: code || "error", message: message || "Something went wrong. Try again.", retryable: true };
}
