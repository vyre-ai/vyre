// @ts-check
// The identity home's cryptography (team/0.3/DESIGN-memory-layers.md, "Where the identity layer lives").
//
// The person's identity memory is encrypted under one random key, the IMK, before it leaves the process that holds it; a space server stores ciphertext and wrapped copies of the IMK and
// never the IMK itself, so an admin or root on the server reads nothing at rest. The IMK is wrapped to what the PERSON holds: each of their devices' P-256 key (the key a phone keeps in
// its Secure Enclave behind Face ID: ECDH is what that key does besides sign) and their recovery code (Argon2id, kernel/identity/stretch.js). Unwrapping needs the device or the code;
// it is never done by a server.
//
// Only node:crypto. Formats, all versioned in the first byte of `v`:
//   box      { v: 1, iv, ct, tag }                 AES-256-GCM under a 32-byte key, with associated data
//   wrapped  { v: 1, epk, iv, ct, tag }            ECDH-ES on P-256 (an ephemeral key per wrap), HKDF-SHA256 over the shared secret, the wrap's own AES-256-GCM
//   coded    { v: 1, salt, iv, ct, tag }           the recovery code stretched with Argon2id, then AES-256-GCM

import crypto from "node:crypto";
import { argon2id } from "../../../kernel/identity/stretch.js";

const b64 = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64url");
const unb64 = (/** @type {string} */ s) => Buffer.from(String(s), "base64url");
const enc = (/** @type {string} */ s) => Buffer.from(String(s), "utf8");

/** A new identity memory key. */
export const newKey = () => crypto.randomBytes(32);

/**
 * Encrypt under a 32-byte key, bound to `aad` (what the ciphertext is for: the identity, the object, its version), so a ciphertext moved to another place does not open there.
 * @param {Uint8Array|string} plain @param {Buffer} key @param {string} aad
 */
export function seal(plain, key, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(enc(aad));
  const ct = Buffer.concat([c.update(typeof plain === "string" ? enc(plain) : Buffer.from(plain)), c.final()]);
  return { v: 1, iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

/** @param {{ v: number, iv: string, ct: string, tag: string }} box @param {Buffer} key @param {string} aad @returns {Buffer} @throws when the key or the binding is wrong */
export function open(box, key, aad) {
  if (!box || box.v !== 1) throw Object.assign(new Error("unknown format"), { code: "bad_format" });
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, unb64(box.iv));
    d.setAAD(enc(aad));
    d.setAuthTag(unb64(box.tag));
    return Buffer.concat([d.update(unb64(box.ct)), d.final()]);
  } catch { throw Object.assign(new Error("cannot open"), { code: "cannot_open" }); }
}

/** A device key pair for the wraps: P-256, as JWK. In life the private half stays in the phone's Secure Enclave; tests hold it. */
export function newDeviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { publicJwk: publicKey.export({ format: "jwk" }), privateJwk: privateKey.export({ format: "jwk" }) };
}

const kek = (/** @type {Buffer} */ shared, /** @type {Buffer} */ epk, /** @type {string} */ info) => Buffer.from(crypto.hkdfSync("sha256", shared, epk, enc(info), 32));

/**
 * Wrap a key to a device's public key (ECDH-ES, P-256).
 * @param {Buffer} key @param {import("node:crypto").JsonWebKey} publicJwk @param {string} aad
 */
export function wrapForDevice(key, publicJwk, aad) {
  const eph = crypto.createECDH("prime256v1");
  eph.generateKeys();
  const peer = crypto.createPublicKey({ key: publicJwk, format: "jwk" });
  const peerRaw = Buffer.from(/** @type {any} */ (peer.export({ format: "jwk" })).x, "base64url");
  const peerPoint = Buffer.concat([Buffer.from([4]), peerRaw, Buffer.from(/** @type {any} */ (peer.export({ format: "jwk" })).y, "base64url")]);
  const shared = eph.computeSecret(peerPoint);
  const epk = eph.getPublicKey();
  const box = seal(key, kek(shared, epk, "vyre-identity-wrap-v1"), aad);
  return { v: 1, epk: b64(epk), iv: box.iv, ct: box.ct, tag: box.tag };
}

/** @param {{ v: number, epk: string, iv: string, ct: string, tag: string }} w @param {import("node:crypto").JsonWebKey} privateJwk @param {string} aad @returns {Buffer} */
export function unwrapWithDevice(w, privateJwk, aad) {
  if (!w || w.v !== 1) throw Object.assign(new Error("unknown format"), { code: "bad_format" });
  const priv = crypto.createPrivateKey({ key: privateJwk, format: "jwk" });
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(/** @type {any} */ (priv.export({ format: "jwk" })).d, "base64url"));
  const epk = unb64(w.epk);
  let shared;
  try { shared = ecdh.computeSecret(epk); } catch { throw Object.assign(new Error("cannot open"), { code: "cannot_open" }); }
  return open({ v: 1, iv: w.iv, ct: w.ct, tag: w.tag }, kek(shared, epk, "vyre-identity-wrap-v1"), aad);
}

/** Wrap a key under the recovery code. @param {Buffer} key @param {string} code @param {string} aad */
export function wrapWithCode(key, code, aad) {
  const salt = crypto.randomBytes(16);
  const box = seal(key, argon2id(enc(code), salt), aad);
  return { v: 1, salt: b64(salt), iv: box.iv, ct: box.ct, tag: box.tag };
}

/** @param {{ v: number, salt: string, iv: string, ct: string, tag: string }} w @param {string} code @param {string} aad @returns {Buffer} */
export function unwrapWithCode(w, code, aad) {
  if (!w || w.v !== 1) throw Object.assign(new Error("unknown format"), { code: "bad_format" });
  return open({ v: 1, iv: w.iv, ct: w.ct, tag: w.tag }, argon2id(enc(code), unb64(w.salt)), aad);
}

/** A fingerprint of a public key, to name a wrap by without carrying the key. @param {import("node:crypto").JsonWebKey} jwk */
export const fingerprint = jwk => crypto.createHash("sha256").update(`${jwk.x}.${jwk.y}`).digest("hex").slice(0, 16);

export const sha256 = (/** @type {Uint8Array|string} */ b) => crypto.createHash("sha256").update(b).digest("hex");
