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
 * Turns one of resolveTicket()/pairOffer()'s plain-message Error throws into a `{ code, message,
 * retryable }` the UI can act on. Neither function exports a `.code` (they throw plain Error
 * objects with human words - see their own source), so this matches the exact strings they throw
 * rather than guessing at HTTP statuses itself; brittle to a wording change there, but there is
 * no better signal available today. Per reviewer's mapping: 404 (expired/used/unknown, collapsed
 * on purpose) -> rescan; 429 -> wait; a MAC or shape failure -> "doesn't check out", and it must
 * never pair.
 * @param {Error} err
 */
export function classifyError(err) {
  const m = String(err?.message || err || "");
  if (/expired or was already used/.test(m)) return { code: "not_found", message: "That code expired or was already used. Open Add your phone again on your Mac.", retryable: true };
  if (/\(429\)/.test(m)) return { code: "rate_limited", message: "Too many tries. Wait a moment and scan again.", retryable: true };
  if (/does not check out|not shaped like an offer|not valid|needs the relay/.test(m)) return { code: "bad_ticket", message: "That code doesn't check out. Try scanning again.", retryable: true };
  return { code: "error", message: m || "Something went wrong. Try again.", retryable: true };
}
