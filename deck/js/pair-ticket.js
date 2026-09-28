// @ts-check
// Scan your avatar to pair your phone: turning a decoded Vyre-code ticket into a real pairing.
// This file used to hand-roll the ticket protocol (locator/secret/MAC derivation, a guessed
// resolve endpoint) - reviewer held that on work/pwa d49335e4: the tags didn't match tailnet's
// real ones, the locator went in a GET URL instead of a POST body, the MAC covered too little
// of the record, and the fingerprint format didn't match the box's own. Per reviewer and
// team-lead: don't reimplement any of it - call tailnet's relay/client library directly
// (relay/client/client.js's `pairTicket()` and `keyFingerprint()`, merged in from work/tailnet
// 8b693dab/2990a810/3cfd01c7). Nothing below derives a key, builds a MAC, or talks to a resolve
// endpoint by hand any more.
//
// INTERIM (2026-09-28): `pairTicket()` is atomic - resolve, verify and the handshake in one call
// - so there is no confirm-before-pairing step available from this library today. Team-lead and
// reviewer asked tailnet to split it into a resolve call and a separate pair call so the sheet
// can show "Pair with <box> (<fingerprint>)?" BEFORE the handshake runs; that sha hasn't landed
// yet. Until it does, `pairNow()` below runs the full pairing immediately on a decoded ticket,
// and the sheet shows the box name and fingerprint AFTER pairing succeeds, as a confirmation
// with an "Unpair" escape hatch, not a gate. Swap this for the split the moment it lands - see
// docs/work/pwa.md's "Phone-side contract".

import { webCrypto } from "../../relay/client/webcrypto.js";
import { fromBase64url } from "../../relay/client/bytes.js";
import { pairTicket, keyFingerprint } from "../../relay/client/client.js";

const crypto = webCrypto();

/**
 * Pairs immediately from a decoded ticket. `relay` is required (nothing in the 72-bit code
 * carries it - PENDING tailnet/launch: where the Deck's "Add your phone" screen gets the box's
 * own relay address from, to pass in here; a self-hosted relay would need the full QR path
 * instead, per tailnet's message).
 * @param {Uint8Array} ticket the raw 8 bytes decode-core2.js recovered - never hex-encoded,
 *   logged, or put anywhere a string would persist on the way here
 * @param {{ relay: string, name: string }} o
 * @returns {Promise<{ box: string, fingerprint: string, relay: string, route: string, boxKey: string, device: any }>}
 */
export async function pairNow(ticket, o) {
  const result = await pairTicket(ticket, { relay: o.relay, name: o.name, about: { kind: "web" }, crypto });
  const fingerprint = await keyFingerprint(fromBase64url(result.box), crypto);
  return { box: result.name, fingerprint, relay: result.relay, route: result.route, boxKey: result.box, device: result.device };
}
