// @ts-check
// Key wrapping, the one library (team/0.3/DESIGN-memory-layers.md "Where the identity layer lives"; team/0.3/DESIGN-chat-keys.md): the identity home and every per-chat key use these functions and no copy of them.
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
import { argon2id } from "../kernel/identity/stretch.js";

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

// ---------------------------------------------------------------------------------------------------- the ring: the one engine for a key shared by many holders (a chat, a project)
//
// A ring is epochs of a random key, each wrapped to the device keys that may read it, plus a name key sealed under every epoch. A server stores the document and never a key. The chat and project
// stores (lib/chat-keys.js) use it; nothing else keeps a ring (the identity home and the backup seal under the identity memory key).
//   ring doc   { v: 1, id, epoch, epochs: { [n]: { wraps: { [holder]: wrapped } } }, names: { [n]: box } }      holder = a device key's name (its fingerprint)
const ringAad = (/** @type {string} */ id, /** @type {number} */ epoch) => `ring:${id}:${epoch}`;
const nameAad = (/** @type {string} */ id, /** @type {number} */ epoch) => `ring-names:${id}:${epoch}`;
const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });

/** @typedef {{ v: 1, id: string, epoch: number, epochs: Record<string, { wraps: Record<string, any> }>, names: Record<string, any> }} RingDoc */

/** What one holder can read of a ring: every epoch key it holds a wrap of, and the name key. Held in process memory, never written. */
export class Keys {
  /** @param {string} id @param {Map<number, Buffer>} keys @param {Buffer} nameKey @param {number} epoch the ring's current epoch */
  constructor(id, keys, nameKey, epoch) { this.id = id; this.keys = keys; this.nameKey = nameKey; this.epoch = epoch; }
  /** The key a new thing is sealed under: the newest epoch this holder has. */
  current() { const n = Math.max(...this.keys.keys()); return { epoch: n, key: /** @type {Buffer} */ (this.keys.get(n)) }; }
  /** @param {number} epoch */
  at(epoch) { const k = this.keys.get(epoch); if (!k) throw bad("this holder holds no key of that epoch", "denied"); return k; }
  toJSON() { throw bad("a key is never serialised", "denied"); }
  [Symbol.for("nodejs.util.inspect.custom")]() { return `Keys(${this.id}, epochs ${[...this.keys.keys()].join(",")})`; }
  lock() { for (const k of this.keys.values()) k.fill(0); this.nameKey.fill(0); this.keys.clear(); }
}

/** @param {Record<string, any>} holders @param {Buffer} key @param {string} aad */
const wrapAll = (holders, key, aad) => Object.fromEntries(Object.entries(holders).map(([h, jwk]) => [h, wrapForDevice(key, jwk, aad)]));

/**
 * A new ring (a chat's or a project's): epoch 1 and a name key, wrapped to each holder.
 * @param {string} id @param {Record<string, any>} holders name to P-256 public JWK
 * @returns {{ doc: RingDoc, keys: Keys }}
 */
export function createRing(id, holders) {
  if (!Object.keys(holders).length) throw bad("a ring needs a holder");
  const key = newKey(), nameKey = newKey();
  /** @type {RingDoc} */ const doc = { v: 1, id, epoch: 1, epochs: { 1: { wraps: wrapAll(holders, key, ringAad(id, 1)) } }, names: { 1: seal(nameKey, key, nameAad(id, 1)) } };
  return { doc, keys: new Keys(id, new Map([[1, key]]), nameKey, 1) };
}

/** What a holder reads with its own device key (no prompt on the person's own device). @param {RingDoc} doc @param {string} holder @param {any} privateJwk */
export function openRing(doc, holder, privateJwk) {
  const keys = new Map();
  for (const [n, e] of Object.entries(doc.epochs)) {
    const w = e.wraps[holder];
    if (w) keys.set(Number(n), unwrapWithDevice(w, privateJwk, ringAad(doc.id, Number(n))));
  }
  if (!keys.size) throw bad("this device holds no wrap of the key", "denied");
  const top = Math.max(...keys.keys());
  const nameKey = open(doc.names[top], /** @type {Buffer} */ (keys.get(top)), nameAad(doc.id, top));
  return new Keys(doc.id, keys, nameKey, doc.epoch);
}

/** The next epoch: a new key wrapped to `to`, the name key sealed under it. @param {RingDoc} doc @param {Keys} k @param {Record<string, any>} to */
function rotate(doc, k, to) {
  const n = doc.epoch + 1, key = newKey();
  const next = { ...doc, epoch: n, epochs: { ...doc.epochs, [n]: { wraps: wrapAll(to, key, ringAad(doc.id, n)) } }, names: { ...doc.names, [n]: seal(k.nameKey, key, nameAad(doc.id, n)) } };
  k.keys.set(n, key); k.epoch = n;
  return next;
}

/**
 * Add holders (a participant's devices). `history` (the adder's choice, default on): the new holders also get every earlier epoch's key, so they read what came before; off, the ring rotates and
 * they read from now on. `all` is every holder that stays, with its public key (a rotation wraps to all of them).
 * @param {RingDoc} doc @param {Keys} k the adder's keys @param {{ add: Record<string, any>, all?: Record<string, any>, history?: boolean }} o
 */
export function addHolders(doc, k, o) {
  if (o.history === false) {
    if (!o.all) throw bad("adding without history rotates the ring: name every holder that stays");
    return rotate(doc, k, { ...o.all, ...o.add });
  }
  const epochs = { ...doc.epochs };
  for (const [n, key] of k.keys) epochs[n] = { wraps: { ...epochs[n].wraps, ...wrapAll(o.add, key, ringAad(doc.id, n)) } };
  return { ...doc, epochs };
}

/**
 * Remove holders: rotate. A new epoch, wrapped to `keep` only; the removed holders' wraps are deleted from every epoch (they keep what they already read and read nothing new).
 * @param {RingDoc} doc @param {Keys} k @param {{ keep: Record<string, any>, drop: string[] }} o
 */
export function removeHolders(doc, k, o) {
  const next = rotate(doc, k, o.keep);
  for (const n of Object.keys(next.epochs)) { const w = { ...next.epochs[n].wraps }; for (const d of o.drop) delete w[d]; next.epochs[n] = { wraps: w }; }
  return next;
}

