// @ts-check
// Scan your avatar to pair your phone: a thin re-export of tailnet's real relay/client API
// (relay/client/client.js, merged in from work/tailnet 13852c7a) - nothing here derives a key,
// builds a MAC, or talks to a resolve endpoint by hand. Kept as its own file only so pair-scan.js
// has one place to import from and one shared crypto provider instance, per reviewer and
// team-lead's "don't reimplement any of it."
//
// Split flow (reviewer, 28 Sep MEDIUM): resolveTicket() looks up and verifies a scanned ticket
// WITHOUT pairing - the person sees who they'd be pairing with and can say no before anything
// happens. pairOffer() is the handshake itself, run only after they tap Pair. Hold the resolved
// `offer` in memory only (it carries the derived pairing secret): never in storage, a URL, or a
// log, and just let it be garbage-collected on "Not this one" - deck/js/pair-scan.js does this by
// construction (the offer lives in a local variable, never assigned anywhere more durable).

import { webCrypto } from "../../relay/client/webcrypto.js";
import { resolveTicket, pairOffer, keyFingerprint } from "../../relay/client/client.js";

const crypto = webCrypto();

export { resolveTicket, pairOffer, keyFingerprint, crypto };

/**
 * Turns one of resolveTicket()/pairOffer()'s Error throws into a `{ code, message, retryable }`
 * the UI can act on. As of relay/client/client.js's `fail()` (work/tailnet 0b711abe) both
 * functions throw with a stable `.code`: `ticket_gone` (404 - expired/used/unknown, deliberately
 * collapsed so a scanner can't tell which applied), `rate_limited` (429), `bad_record` (a MAC or
 * shape failure - must never pair), `bad_input`, `pair_failed`. Reviewer's LOW on the earlier
 * message-matching version: fixed now that a real code exists.
 * @param {Error & { code?: string }} err
 */
export function classifyError(err) {
  const code = err?.code;
  if (code === "ticket_gone") return { code, message: "That code expired or was already used. Open Add your phone again on your Mac.", retryable: true };
  if (code === "rate_limited") return { code, message: "Too many tries. Wait a moment and scan again.", retryable: true };
  if (code === "bad_record") return { code, message: "That code doesn't check out. Try scanning again.", retryable: true };
  if (code === "bad_input" || code === "pair_failed") return { code, message: String(err?.message || "Something went wrong. Try again."), retryable: true };
  return { code: code || "error", message: String(err?.message || err || "Something went wrong. Try again."), retryable: true };
}
