// @ts-check
// AES-256-GCM wraps and an X25519 seal for the master record and the space vault. node:crypto only.

import crypto from "node:crypto";

const b64 = (/** @type {Buffer|Uint8Array} */ b) => Buffer.from(b).toString("base64url");
const raw = (/** @type {string} */ s) => Buffer.from(s, "base64url");

/**
 * @param {Buffer} kek 32 bytes
 * @param {Buffer|Uint8Array} plain
 * @param {string} aad
 */
export function aesWrap(kek, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

/**
 * @param {Buffer} kek
 * @param {{ iv: string, ct: string, tag: string }} box
 * @param {string} aad
 * @returns {Buffer}
 */
export function aesUnwrap(kek, box, aad) {
  const d = crypto.createDecipheriv("aes-256-gcm", kek, raw(box.iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw(box.tag));
  return Buffer.concat([d.update(raw(box.ct)), d.final()]);
}

/** @param {Buffer|Uint8Array|string} ikm @param {string} salt @param {string} info */
export function hkdf32(ikm, salt, info) {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(ikm), Buffer.from(salt), info, 32));
}

/** A fresh X25519 pair, raw 32-byte halves as base64url. */
export function x25519Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const pub = /** @type {any} */ (publicKey.export({ format: "jwk" })).x;
  const priv = /** @type {any} */ (privateKey.export({ format: "jwk" })).d;
  return { pub: String(pub), priv: String(priv) };
}

/** @param {"pub"|"priv"} side @param {string} b64u */
function jwk(side, b64u) {
  return side === "pub"
    ? { kty: "OKP", crv: "X25519", x: b64u }
    : { kty: "OKP", crv: "X25519", d: b64u, x: "" };
}

/** @param {string} privB64 @param {string} pubB64 */
export function x25519Shared(privB64, pubB64) {
  const priv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: privB64, x: pubOfPriv(privB64) }, format: "jwk" });
  const pub = crypto.createPublicKey({ key: jwk("pub", pubB64), format: "jwk" });
  return crypto.diffieHellman({ privateKey: priv, publicKey: pub });
}

/** The public half of a raw X25519 scalar, so the JWK private key is complete. @param {string} privB64 */
function pubOfPriv(privB64) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([
    Buffer.from("302e020100300506032b656e04220420", "hex"),
    raw(privB64),
  ]), format: "der", type: "pkcs8" });
  return String(/** @type {any} */ (crypto.createPublicKey(priv).export({ format: "jwk" })).x);
}

/**
 * Seal 32-ish bytes to an X25519 public key. The ephemeral public half rides with the box.
 * @param {string} pubB64 @param {Buffer} plain @param {string} aad
 */
export function sealTo(pubB64, plain, aad) {
  const eph = x25519Pair();
  const kek = hkdf32(x25519Shared(eph.priv, pubB64), eph.pub, "vyre:space-vault:wrap:v1");
  return { eph: eph.pub, ...aesWrap(kek, plain, aad) };
}

/**
 * @param {string} privB64 @param {{ eph: string, iv: string, ct: string, tag: string }} box @param {string} aad
 */
export function openSeal(privB64, box, aad) {
  const kek = hkdf32(x25519Shared(privB64, box.eph), box.eph, "vyre:space-vault:wrap:v1");
  return aesUnwrap(kek, box, aad);
}
