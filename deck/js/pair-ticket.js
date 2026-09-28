// @ts-check
// Scan your avatar to pair your phone: turning a decoded Vyre-code ticket into a real pairing,
// WITHOUT the ticket itself ever leaving the phone (reviewer's HIGH 1 on work/pwa bdca618b -
// whoever holds the raw ticket can pair as the owner's phone, so it must never cross the wire).
//
// The ticket `t` (the 8 bytes decode-core2.js recovers) is the pairing secret, not a public id -
// deck/vyrecode/payload.js's own "never a secret" comment describes THAT module's generic
// id+CRC+RS shape, not this specific use of it; see the note there.
//
// Three values are derived from `t` locally, with domain-separated SHA-256 (reviewer's own
// naming) and never transmitted except where the derivation itself uses one:
//   locator = sha256("vyre-pair-loc" || t)   sent to the relay so it can look up the record - a
//             locator on its own does not let anyone pair, it only names a row
//   secret  = sha256("vyre-pair-sec" || t)   used as the Noise handshake's pairing secret
//             (relay/client/client.js's own `pair()`); never leaves this device
//   macKey  = sha256("vyre-pair-mac" || t)   verifies the box's record came back unmodified
//             (reviewer's HIGH 2: never trust a server-supplied fingerprint - the phone
//             recomputes it from the box's public key once the MAC over that key checks out)
//
// PENDING tailnet (see docs/work/pwa.md's "Phone-side contract"): the exact resolve endpoint,
// its request/response shape, and the MAC's input encoding are this file's own best guess at
// the agreed design reviewer described, not confirmed against the real implementation.

import { webCrypto } from "../../relay/client/webcrypto.js";
import { utf8, hex, concat, equal, base64url, fromBase64url } from "../../relay/client/bytes.js";
import { PAIR_BASE, pair as relayPair } from "../../relay/client/client.js";

const crypto = webCrypto();

const LOC_DOMAIN = utf8("vyre-pair-loc");
const SEC_DOMAIN = utf8("vyre-pair-sec");
const MAC_DOMAIN = utf8("vyre-pair-mac");

/** @param {Uint8Array} t the 8-byte ticket, decoded but never sent anywhere as-is */
async function deriveLocator(t) { return hex(await crypto.sha256(concat(LOC_DOMAIN, t))); }
async function deriveSecret(t) { return base64url(await crypto.sha256(concat(SEC_DOMAIN, t))); }
async function deriveMacKey(t) { return crypto.sha256(concat(MAC_DOMAIN, t)); }

/**
 * PENDING tailnet: the real resolve call. Assumed shape: GET a locator-keyed record from a
 * well-known directory host (PAIR_BASE's own origin, same as the QR-pairing flow uses), which
 * returns enough to reach the box PLUS a MAC over it so a malicious or compromised relay can
 * never substitute a different box - the caller below verifies that MAC before trusting
 * anything in this response.
 * @param {string} locator
 * @returns {Promise<{ relay: string, route: string, box: Uint8Array, mac: Uint8Array, boxName: string }>}
 */
async function fetchTicketRecord(locator) {
  const origin = new URL(PAIR_BASE).origin;
  const res = await fetch(`${origin}/api/pair/ticket/${encodeURIComponent(locator)}`);
  if (res.status === 404) throw Object.assign(new Error("That code was not found."), { code: "ticket_not_found" });
  if (res.status === 410) throw Object.assign(new Error("That code expired."), { code: "ticket_expired" });
  if (res.status === 409) throw Object.assign(new Error("That code was already used."), { code: "ticket_used" });
  if (res.status === 429) throw Object.assign(new Error("Too many tries."), { code: "rate_limited" });
  if (!res.ok) throw Object.assign(new Error("Could not reach the relay."), { code: "resolve_failed" });
  try {
    const body = await res.json();
    return {
      relay: String(body.relay || ""),
      route: String(body.route || ""),
      box: fromBase64url(String(body.box || "")),
      mac: fromBase64url(String(body.mac || "")),
      boxName: String(body.name || body.boxName || "your box"),
      handle: String(body.handle || ""), // PENDING tailnet: the person's own <handle>.vyre.run,
                                          // for the success screen's redirect (team-lead, 2026-09-28)
    };
  } catch {
    throw Object.assign(new Error("That didn't look like a Vyre code."), { code: "bad_ticket" });
  }
}

/** A short, human-comparable fingerprint from a verified box public key - computed locally, the
 * same input the box itself would show, never trusted from a server. TODO: swap for the shared
 * keyFingerprint() once it lands from wherever it's built (mentioned by reviewer; not yet in
 * this tree) so both sides format it identically. */
async function fingerprintOf(/** @type {Uint8Array} */ boxPublicKey) {
  const digest = await crypto.sha256(boxPublicKey);
  return hex(digest.slice(0, 4)).toUpperCase().match(/.{1,4}/g)?.join("-") || "";
}

/**
 * Resolves a scanned ticket to a box identity, WITHOUT sending the ticket itself: derives the
 * locator, mac key and (for later) the pairing secret locally, fetches the record by locator
 * only, verifies its MAC with the derived key, and computes the fingerprint from the verified
 * public key. Throws with a `.code` (ticket_expired, ticket_used, ticket_not_found, rate_limited,
 * bad_ticket, resolve_failed) the UI can turn into words.
 * @param {Uint8Array} ticket
 * @returns {Promise<{ box: string, fingerprint: string, handle: string, offer: { relay: string, route: string, box: Uint8Array, secret: string, boxName: string } }>}
 */
export async function resolveTicket(ticket) {
  const locator = await deriveLocator(ticket);
  const record = await fetchTicketRecord(locator);
  if (!record.relay || !record.route || record.box.length !== 32) throw Object.assign(new Error("That didn't look like a Vyre code."), { code: "bad_ticket" });
  const macKey = await deriveMacKey(ticket);
  const expected = await crypto.hmacSha256(macKey, concat(utf8(record.route), record.box));
  if (!equal(expected, record.mac)) throw Object.assign(new Error("That code's record did not check out. Try scanning again."), { code: "bad_ticket" });
  const fingerprint = await fingerprintOf(record.box);
  const secret = await deriveSecret(ticket);
  return { box: record.boxName, fingerprint, handle: record.handle, offer: { relay: record.relay, route: record.route, box: record.box, secret, boxName: record.boxName } };
}

/** Builds the same offer-URL shape relay/client/client.js's parsePairUrl expects, from parts
 * this device derived/verified itself (never re-parsing anything the relay sent as if it were
 * trusted input) - lets the redeem flow call the EXACT SAME pair() the QR flow and the Expo app
 * use, one handshake implementation for every pairing path.
 * @param {{ relay: string, route: string, box: Uint8Array, secret: string, boxName: string }} offer
 */
function offerUrl(offer) {
  const json = JSON.stringify({ v: 1, r: offer.relay, i: offer.route, s: offer.secret, k: base64url(offer.box), n: offer.boxName.slice(0, 64) });
  return `${PAIR_BASE}#${base64url(utf8(json))}`;
}

/**
 * Completes the pairing: the Noise handshake over the relay, using relay/client/client.js's own
 * `pair()` (the same library the Expo app uses). No presence/Touch ID call from the phone here -
 * per reviewer, that gate is at mint time on the box's own side (option A), not at redeem.
 * @param {{ relay: string, route: string, box: Uint8Array, secret: string, boxName: string }} offer
 * @param {{ name: string }} o the device name to send with the pairing
 */
export async function completePairing(offer, o) {
  return relayPair(offerUrl(offer), { name: o.name, about: { kind: "web" } });
}
