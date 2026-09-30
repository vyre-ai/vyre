// @ts-check
// wire: what the box and the relay agree on outside the encrypted channel (ADR 0026, section 2).
// The route id, the box's signed registration, and the relay's limits. The Worker in
// relay/worker/ repeats these with WebCrypto; relay/worker/worker.test.js checks they match.

import crypto from "node:crypto";
import { WORDS } from "./words.js";

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

// Pairing tickets (ADR 0045, ADR 0026 section 6 amendment): a compact 64-bit random value a
// Vyre code can carry, in place of the full offer a QR encodes. Everything derived from it and
// handed to the relay is a one-way function of the ticket under a distinct tag, so the relay
// never learns the pairing secret and can't forge or substitute the record it hands back
// (reviewer, 28 Sep): a locator to store the record under, a MAC key to authenticate it with, and
// the pairing secret itself, which only ever travels to the box (at redeem, inside the Noise
// channel) and never to the relay at all. The record itself is sealed under a fourth key (the
// lead's ruling, 28 Sep, closing ADR 0026's relay-operator threat row): the relay stores and
// hands back only ciphertext, so the box's name, handle, identity fingerprint and key never sit
// on it in the clear.
export const TICKET_BYTES = 8;
export const TICKET_TTL = 5 * 60_000;
const TAG = { loc: "vyre-pair-loc", sec: "vyre-pair-sec", mac: "vyre-pair-mac", enc: "vyre-pair-enc" };
/** @param {"loc"|"sec"|"mac"|"enc"} which @param {Buffer} ticket */
export const ticketDerive = (which, ticket) => crypto.createHash("sha256").update(`${TAG[which]}\n`).update(ticket).digest();
/** HMAC over the exact record bytes the relay stores and hands back, never a re-serialized copy. @param {Buffer} ticket @param {Buffer|string} record */
export const ticketMac = (ticket, record) => crypto.createHmac("sha256", ticketDerive("mac", ticket)).update(record).digest();
// A fresh random 12-byte nonce rides in front of every sealed record (the reviewer's LOW 2), so
// nonce safety never depends on tickets being unique across every box. relay/client/client.js
// opens it with the same layout and AD, byte for byte. The seal's real strength against the relay
// operator is the ticket's 64 bits: the relay holds the locator, a hash of the ticket, so it can
// search the ticket space offline with no time limit (ADR 0045).
export const TICKET_SEAL_AD = "vyre-pair-record\n1";
/** AES-256-GCM, base64url(nonce12 || ciphertext || tag16). @param {Buffer} ticket @param {string} plaintext */
export function ticketSeal(ticket, plaintext) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", ticketDerive("enc", ticket), nonce);
  c.setAAD(Buffer.from(TICKET_SEAL_AD));
  return Buffer.concat([nonce, c.update(plaintext, "utf8"), c.final(), c.getAuthTag()]).toString("base64url");
}
/** The inverse of ticketSeal; throws on a wrong key or any modified byte. @param {Buffer} ticket @param {string} sealed */
export function ticketOpen(ticket, sealed) {
  const b = Buffer.from(sealed, "base64url");
  if (b.length < 28) throw new Error("sealed record too short");
  const d = crypto.createDecipheriv("aes-256-gcm", ticketDerive("enc", ticket), b.subarray(0, 12));
  d.setAAD(Buffer.from(TICKET_SEAL_AD));
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString("utf8");
}

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

// ---- The setup session (tailnet plan 3.6 and 3.6b) ----
//
// The setup page makes a 16-byte secret and a non-extractable P-256 key, and the install line
// carries both as one code: C = base64url(secret16 || fp16), 43 characters, where fp is the first
// 16 bytes of sha256("vyre-setup-key\n" || the key's SPKI). Everything the relay sees derives from
// secret16 alone, under distinct tags, exactly as a Wink ticket's values do (ticketDerive): a
// locator, a MAC key and a seal key for the offer record, the pairing secret (which never reaches
// the relay), and three keys for the progress mailbox. The fingerprint in the code is what binds
// the setup channel to the page's key: someone who saw C can resolve the offer but holds no key
// that hashes to fp, so the box admits no hello from them (setupHelloOk below).
export const SETUP_CODE_LEN = 43;
export const SETUP_TTL = 60 * 60_000;
export const SETUP_TAG = { key: "vyre-setup-key", hello: "vyre-setup-hello", read: "vyre-setup-read", words: "vyre-setup-words",
  mbxw: "vyre-setup-mbx-w", mbxenc: "vyre-setup-mbx-enc", mbxmac: "vyre-setup-mbx-mac" };
/** loc, sec, mac and enc are ticketDerive's own (secret16 is just a longer ticket); the rest are setup's. @param {"loc"|"sec"|"mac"|"enc"|"mbxw"|"mbxenc"|"mbxmac"} which @param {Buffer} secret */
export const setupDerive = (which, secret) => which in TAG ? ticketDerive(/** @type {any} */ (which), secret) : crypto.createHash("sha256").update(`${SETUP_TAG[which]}\n`).update(secret).digest();

const P256_SPKI_HEAD = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
/** A P-256 SPKI and nothing else: the exact 91 bytes WebCrypto exports, uncompressed point. @param {Buffer} spki */
export const isP256Spki = spki => Buffer.isBuffer(spki) && spki.length === 91 && spki.subarray(0, 26).equals(P256_SPKI_HEAD) && spki[26] === 4;
/** @param {Buffer} spki */
export const setupFingerprint = spki => crypto.createHash("sha256").update(`${SETUP_TAG.key}\n`).update(spki).digest().subarray(0, 16);
/** @param {Buffer} secret @param {Buffer} spki */
export const setupCode = (secret, spki) => Buffer.concat([secret, setupFingerprint(spki)]).toString("base64url");
/** The secret and the fingerprint in a code, or null when it is not exactly one. @param {string} code @returns {{ secret: Buffer, fp: Buffer } | null} */
export function parseSetupCode(code) {
  if (typeof code !== "string" || code.length !== SETUP_CODE_LEN || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
  const b = Buffer.from(code, "base64url");
  if (b.length !== 32 || b.toString("base64url") !== code) return null;
  return { secret: b.subarray(0, 16), fp: b.subarray(16) };
}

/** What the page signs to be admitted: bound to this route and to this Noise session's device key. @param {string} route @param {Buffer} noiseStatic */
/** The claim token's signed message: the box's route, the one-time challenge and the address it is for, so a token for another box or another name never verifies. @param {string} route @param {Buffer} challenge @param {string} host */
export const setupClaimMessage = (route, challenge, host) => Buffer.concat([Buffer.from(`vyre-setup-claim\n${route}\n`), challenge, Buffer.from(`\n${String(host).toLowerCase()}`)]);
export const CLAIM_TTL = 2 * 60_000;
export const setupHelloMessage = (route, noiseStatic) => Buffer.concat([Buffer.from(`${SETUP_TAG.hello}\n${route}\n`), noiseStatic]);
/** @param {Buffer} spki @param {Buffer} message @param {Buffer} sig 64 bytes, r || s (WebCrypto's ECDSA form) */
export function verifyP256(spki, message, sig) {
  if (!isP256Spki(spki) || sig.length !== 64) return false;
  try { return crypto.verify("sha256", message, { key: crypto.createPublicKey({ key: spki, format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" }, sig); } catch { return false; }
}
/**
 * Admit a setup hello only with the exact key whose fingerprint the code carries and a valid
 * signature over route and the device's Noise key (so a captured hello cannot be replayed from
 * another Noise key).
 * @param {{ fp: Buffer, route: string, noiseStatic: Buffer, key: string, sig: string }} o
 * @returns {Buffer | null} the SPKI, or null when refused
 */
export function setupHelloOk(o) {
  const spki = Buffer.from(String(o.key || ""), "base64url"), sig = Buffer.from(String(o.sig || ""), "base64url");
  if (!isP256Spki(spki) || sig.length !== 64) return null;
  const fp = setupFingerprint(spki);
  if (fp.length !== o.fp.length || !crypto.timingSafeEqual(fp, o.fp)) return null;
  return verifyP256(spki, setupHelloMessage(o.route, o.noiseStatic), sig) ? spki : null;
}

/** Four words (44 bits) from sha256(box static key || secret): the box prints them, the page shows them. @param {Buffer} boxStatic @param {Buffer} secret */
export function setupWords(boxStatic, secret) {
  const h = crypto.createHash("sha256").update(`${SETUP_TAG.words}\n`).update(boxStatic).update(secret).digest();
  const bits = h.readUIntBE(0, 6);              // 48 bits; the top 44 are used
  return [0, 1, 2, 3].map(i => WORDS[Math.floor(bits / 2 ** (37 - 11 * i)) % 2048]);
}

// The mailbox line: base64url(iv16 || AES-256-CTR ciphertext || HMAC-SHA256 32), the HMAC over
// seq (u32 big-endian) || iv || ciphertext under its own key. `openssl enc -aes-256-ctr -K <hex>
// -iv <hex>` and `openssl dgst -sha256 -mac HMAC -macopt hexkey:<hex>` make the same bytes, so the
// install script needs no GCM. The sequence number is not sent: the reader counts, so a line moved
// to another place or played twice fails its HMAC.
export const MBX_LINE_MAX = 1024;
const seqBytes = seq => { const b = Buffer.alloc(4); b.writeUInt32BE(seq); return b; };
/** @param {Buffer} secret @param {number} seq @param {string} text @param {Buffer} [iv] */
export function mbxSeal(secret, seq, text, iv = crypto.randomBytes(16)) {
  const c = crypto.createCipheriv("aes-256-ctr", setupDerive("mbxenc", secret), iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  const mac = crypto.createHmac("sha256", setupDerive("mbxmac", secret)).update(seqBytes(seq)).update(iv).update(ct).digest();
  return Buffer.concat([iv, ct, mac]).toString("base64url");
}
/** The text of line number `seq`, or null when any byte is wrong or the line belongs elsewhere. @param {Buffer} secret @param {number} seq @param {string} line */
export function mbxOpen(secret, seq, line) {
  const b = Buffer.from(String(line), "base64url");
  if (b.length < 48) return null;
  const iv = b.subarray(0, 16), ct = b.subarray(16, -32), mac = b.subarray(-32);
  const want = crypto.createHmac("sha256", setupDerive("mbxmac", secret)).update(seqBytes(seq)).update(iv).update(ct).digest();
  if (!crypto.timingSafeEqual(mac, want)) return null;
  const d = crypto.createDecipheriv("aes-256-ctr", setupDerive("mbxenc", secret), iv);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
/** What a mailbox reader signs with the page key: fresh (the relay takes a small clock window) and bound to one locator and one read position. @param {string} loc @param {number} ts @param {number} after */
export const mbxReadMessage = (loc, ts, after) => Buffer.from(`${SETUP_TAG.read}\n${loc}\n${ts}\n${after}`);
