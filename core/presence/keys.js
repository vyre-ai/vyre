// @ts-check
// Public keys presence accepts, in the forms devices really export them, all turned into the one
// stored form: base64url SPKI DER.
//
// - SPKI DER (base64 or base64url): what a phone, a browser and node export. Left as sent.
// - JWK (an object or its JSON text): kty EC or RSA, public members only. A `d` or any private
//   member is refused, so a private key is never taken in by mistake.
// - BCRYPT_RSAKEY_BLOB (magic "RSA1"): what Windows' KeyCredential exports as its public key.
//   Header of six little-endian u32 (magic, bit length, exponent bytes, modulus bytes, prime1 = 0,
//   prime2 = 0), then the exponent and the modulus, both big-endian.

import crypto from "node:crypto";

const RSA1 = 0x31415352;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/** RSA modulus floor and ceiling in bits, and the only public exponent accepted. */
export const RSA_MIN_BITS = 2048;
export const RSA_MAX_BITS = 8192;
export const RSA_EXPONENT = 65537n;

/** A BCRYPT_RSAKEY_BLOB public key as a JWK. Throws on anything but a well-formed public RSA1 blob. @param {Buffer} b */
export function bcryptRsaToJwk(b) {
  if (b.length < 24 || b.readUInt32LE(0) !== RSA1) throw new Error("not a BCRYPT RSA public key blob (magic RSA1)");
  const bits = b.readUInt32LE(4), e = b.readUInt32LE(8), n = b.readUInt32LE(12), p1 = b.readUInt32LE(16), p2 = b.readUInt32LE(20);
  if (p1 !== 0 || p2 !== 0) throw new Error("that blob holds private key material; send the public key only");
  if (e < 1 || e > 8 || n < 1 || n > RSA_MAX_BITS / 8 || b.length !== 24 + e + n) throw new Error("the RSA key blob's lengths do not add up");
  if (bits !== n * 8) throw new Error("the RSA key blob's bit length does not match its modulus");
  return { kty: "RSA", e: b.subarray(24, 24 + e).toString("base64url"), n: b.subarray(24 + e, 24 + e + n).toString("base64url") };
}

/**
 * Whatever a device sent, as base64url SPKI DER. Strings that are neither JSON nor an RSA1 blob
 * come back untouched, so today's SPKI callers see no change. Throws when it cannot be read.
 * @param {unknown} input
 * @returns {string}
 */
export function normalizePublicKey(input) {
  let jwk = null;
  if (input && typeof input === "object" && !Buffer.isBuffer(input)) jwk = input;
  else if (typeof input === "string" && input.trim().startsWith("{")) {
    try { jwk = JSON.parse(input); } catch { throw new Error("public_key looks like JSON but is not"); }
  } else if (typeof input === "string") {
    const raw = Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (raw.length >= 4 && raw.readUInt32LE(0) === RSA1) jwk = bcryptRsaToJwk(raw);
  }
  if (!jwk) return /** @type {string} */ (input);
  const j = /** @type {any} */ (jwk);
  if (!j || (j.kty !== "RSA" && j.kty !== "EC")) throw new Error("a JWK public key must have kty RSA or EC");
  for (const m of PRIVATE_MEMBERS) if (m in j) throw new Error("that JWK holds private key material; send the public key only");
  const pub = crypto.createPublicKey({ key: j.kty === "RSA" ? { kty: "RSA", n: j.n, e: j.e } : { kty: "EC", crv: j.crv, x: j.x, y: j.y }, format: "jwk" });
  return pub.export({ format: "der", type: "spki" }).toString("base64url");
}

/**
 * The RSA rules for a presence key: at least 2048 bits (at most 8192, so a verify stays cheap)
 * and public exponent 65537. Throws otherwise. @param {import("node:crypto").KeyObject} key
 */
export function checkRsa(key) {
  const d = /** @type {any} */ (key.asymmetricKeyDetails || {});
  if (key.asymmetricKeyType !== "rsa") throw new Error("not an RSA key");
  if (!(d.modulusLength >= RSA_MIN_BITS)) throw new Error(`an RSA key needs at least ${RSA_MIN_BITS} bits, not ${d.modulusLength}`);
  if (d.modulusLength > RSA_MAX_BITS) throw new Error(`an RSA key may be at most ${RSA_MAX_BITS} bits`);
  if (BigInt(d.publicExponent) !== RSA_EXPONENT) throw new Error("an RSA key's public exponent must be 65537");
}
