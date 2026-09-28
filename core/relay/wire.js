// @ts-check
// wire: what the box and the relay agree on outside the encrypted channel (ADR 0026, section 2).
// The route id, the box's signed registration, and the relay's limits. The Worker in
// relay/worker/ repeats these with WebCrypto; relay/worker/worker.test.js checks they match.

import crypto from "node:crypto";

/** Signed by the box's route key, with the route id and the relay's challenge. */
export const BOX_AUTH_TAG = "vyre-relay-box-v1";
/** The Noise prologue's prefix; the route id follows, so a handshake cannot cross routes. */
export const PROLOGUE_TAG = "vyre-relay-v1";

export const LIMITS = Object.freeze({
  /** device connections the box has not picked up yet, per route */
  waiting: 8,
  /** device connections open at once, per route */
  open: 32,
  /** frames held for one waiting connection */
  buffered: 64,
  /** the largest frame the relay forwards; the channel chunks anything bigger */
  frame: 1 << 20,
});

/** Close codes the relay uses (4000 to 4999 are the application's). */
export const CLOSE = Object.freeze({
  boxOffline: 4404,
  busy: 4429,
  refused: 4401,
  replaced: 4409,
  boxGone: 4410,
  deviceGone: 4411,
  tooBig: 1009,
});

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The route id: the first 26 base32 characters (130 bits) of sha256 of the Ed25519 route key. */
export const routeId = routePub => base32(crypto.createHash("sha256").update(routePub).digest()).slice(0, 26);

export const ROUTE_RE = /^[a-z2-7]{26}$/;

/** The bytes the box signs to register: the tag, the route id and the relay's challenge. */
export const authMessage = (route, challenge) => Buffer.concat([Buffer.from(`${BOX_AUTH_TAG}\n${route}\n`), challenge]);

const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

// Pairing tickets (ADR 0037, ADR 0026 section 6 amendment): a compact 64-bit random value a
// Vyre code can carry, in place of the full offer a QR encodes. Everything derived from it and
// handed to the relay is a one-way function of the ticket under a distinct tag, so the relay
// never learns the pairing secret and can't forge or substitute the record it hands back
// (reviewer, 28 Sep): a locator to store the record under, a MAC key to authenticate it with, and
// the pairing secret itself, which only ever travels to the box (at redeem, inside the Noise
// channel) and never to the relay at all.
export const TICKET_BYTES = 8;
export const TICKET_TTL = 5 * 60_000;
const TAG = { loc: "vyre-pair-loc", sec: "vyre-pair-sec", mac: "vyre-pair-mac" };
/** @param {"loc"|"sec"|"mac"} which @param {Buffer} ticket */
export const ticketDerive = (which, ticket) => crypto.createHash("sha256").update(`${TAG[which]}\n`).update(ticket).digest();
/** HMAC over the exact record bytes the relay stores and hands back, never a re-serialized copy. @param {Buffer} ticket @param {Buffer|string} record */
export const ticketMac = (ticket, record) => crypto.createHmac("sha256", ticketDerive("mac", ticket)).update(record).digest();

/** A new Ed25519 route key, raw. */
export function newRouteKey() {
  const k = crypto.generateKeyPairSync("ed25519");
  return {
    priv: Buffer.from(k.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)),
    pub: Buffer.from(k.publicKey.export({ format: "der", type: "spki" }).subarray(-32)),
  };
}

/** @param {Buffer} priv @param {Buffer} message */
export const signRoute = (priv, message) =>
  crypto.sign(null, message, crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, priv]), format: "der", type: "pkcs8" }));

/** @param {Buffer} pub @param {Buffer} message @param {Buffer} sig */
export function verifyRoute(pub, message, sig) {
  if (pub.length !== 32 || sig.length !== 64) return false;
  try {
    return crypto.verify(null, message, crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, pub]), format: "der", type: "spki" }), sig);
  } catch { return false; }
}
