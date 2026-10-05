// @ts-check
// Key wrapping, the one library (team/0.3/DESIGN-memory-layers.md "Where the identity layer lives"; team/0.3/DESIGN-chat-keys.md): the identity home and every per-chat key use these functions and no other.
// @noble/ciphers, @noble/hashes and @noble/curves and Uint8Array only, so the server, the phone and the browser run THE SAME FILE, and everything is synchronous (a store's write-through hooks need that) except the
// one step that uses a device's own PRIVATE key: ECDH with its agree key. That step is async, `ecdh(epk) -> shared secret`, so the key never leaves the keystore (a CryptoKey on the web, the Secure Enclave or
// Keystore on a phone or Mac, through getAgreeKey()). Wrapping to other devices' PUBLIC agree points is pure noble.
// Formats, all versioned in the first byte of `v` (lib/vectors/keywrap.json pins them byte for byte):
//   box      { v: 1, iv, ct, tag }                 AES-256-GCM under a 32-byte key, with associated data
//   wrapped  { v: 1, epk, iv, ct, tag }            ECDH-ES on P-256 (an ephemeral key per wrap), HKDF-SHA256 (salt the ephemeral public point, info "vyre-identity-wrap-v1"), the wrap's own AES-256-GCM

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 as sha256Bytes } from "@noble/hashes/sha2";
import { p256 } from "@noble/curves/p256";
import { newKey, seal, open, toB64u as b64, fromB64u as unb64, utf8 as enc, text as dec, sha256Hex } from "./databox.js";

const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
const cat = (/** @type {Uint8Array[]} */ ...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

// The data boxes (seal, open, newKey) are lib/databox.js: the same box on Node, a phone and a browser. Re-exported here so callers of the key wrap keep one import.
export { newKey, seal, open, b64, unb64 };

/** @typedef {{ v: 1, iv: string, ct: string, tag: string }} Box */
/** @typedef {{ v: 1, epk: string, iv: string, ct: string, tag: string }} Wrapped */

const INFO = enc("vyre-identity-wrap-v1");
const kek = (/** @type {Uint8Array} */ shared, /** @type {Uint8Array} */ epk) => hkdf(sha256Bytes, shared, epk, INFO, 32);

/** The 65-byte uncompressed point of a P-256 public JWK. @param {{ x?: string, y?: string }} jwk */
export const pointOf = (jwk) => cat(Uint8Array.of(4), unb64(String(jwk.x)), unb64(String(jwk.y)));

/** The public JWK of a 65-byte uncompressed point. @param {Uint8Array} pt @returns {{ kty: "EC", crv: "P-256", x: string, y: string }} */
export const jwkOfPoint = (pt) => ({ kty: "EC", crv: "P-256", x: b64(pt.subarray(1, 33)), y: b64(pt.subarray(33, 65)) });

/** The ECDH shared secret (the 32-byte X coordinate) of a private scalar and a public point. @param {Uint8Array} priv @param {Uint8Array} point */
const shared = (priv, point) => p256.getSharedSecret(priv, point, true).subarray(1, 33);

/** A device key pair for the wraps: P-256, as JWK. In life the private half stays in the device's keystore (the agree key); tests hold it. */
export function newDeviceKey() {
  const priv = p256.utils.randomPrivateKey();
  const pub = jwkOfPoint(p256.getPublicKey(priv, false));
  return { publicJwk: pub, privateJwk: { ...pub, d: b64(priv) } };
}

/** Wrap a key to a device's PUBLIC key (ECDH-ES, P-256): pure noble, no device involved. @param {Uint8Array} key @param {{ x?: string, y?: string }} publicJwk @param {string} aad @returns {Wrapped} */
export function wrapForDevice(key, publicJwk, aad) {
  const eph = p256.utils.randomPrivateKey();
  const epk = p256.getPublicKey(eph, false);
  const box = seal(key, kek(shared(eph, pointOf(publicJwk)), epk), aad);
  return { v: 1, epk: b64(epk), iv: box.iv, ct: box.ct, tag: box.tag };
}

/** @typedef {(epk: Uint8Array) => Promise<Uint8Array>} Ecdh  the device key's one job: the shared secret with an ephemeral public point (async: the key stays in its keystore) */

/** An Ecdh from a private JWK (a test's, or a server's own key), pure noble. The device's own key is an Ecdh from getAgreeKey(). @param {{ d?: string } | Ecdh} priv @returns {Ecdh} */
export function ecdhFrom(priv) {
  if (typeof priv === "function") return priv;
  const d = unb64(String(priv.d));
  return async (epk) => shared(d, epk);
}

/** Open a wrap with the device's private key. Async because that key's ECDH is. @param {Wrapped} w @param {Ecdh | { d?: string }} device the device's ECDH function, or its private JWK @param {string} aad @returns {Promise<Uint8Array>} */
export async function unwrapWithDevice(w, device, aad) {
  if (!w || w.v !== 1) throw bad("unknown format", "bad_format");
  const epk = unb64(w.epk);
  let secret;
  try { secret = await ecdhFrom(device)(epk); } catch { throw bad("cannot open", "cannot_open"); }
  return open({ v: 1, iv: w.iv, ct: w.ct, tag: w.tag }, kek(secret, epk), aad);
}

/** A fingerprint of a public key, to name a wrap by without carrying the key: SHA-256 of "<x>.<y>", the first 16 hex characters. @param {{ x?: string, y?: string }} jwk */
export const fingerprint = (jwk) => sha256Hex(enc(`${jwk.x}.${jwk.y}`)).slice(0, 16);

/** SHA-256 as hex. @param {Uint8Array | string} b */
export const sha256 = (b) => sha256Hex(typeof b === "string" ? enc(b) : b);

// ---------------------------------------------------------------------------------------------------- the ring: the one engine for a key shared by many holders (a chat, a project)
//
// A ring is epochs of a random key, each wrapped to the device keys that may read it, plus a name key sealed under every epoch. A server stores the document and never a key. The chat and project stores
// (lib/chat-keys.js) use it; nothing else keeps a ring.
//   ring doc   { v: 1, id, epoch, epochs: { [n]: { wraps: { [holder]: wrapped } } }, names: { [n]: box } }      holder = a device key's name (its fingerprint)
const ringAad = (/** @type {string} */ id, /** @type {number} */ epoch) => `ring:${id}:${epoch}`;
const nameAad = (/** @type {string} */ id, /** @type {number} */ epoch) => `ring-names:${id}:${epoch}`;

/** @typedef {{ v: 1, id: string, epoch: number, epochs: Record<string, { wraps: Record<string, Wrapped> }>, names: Record<string, Box> }} RingDoc */

/** What one holder can read of a ring: every epoch key it holds a wrap of, and the name key. In process memory only, never written. */
export class Keys {
  /** @param {string} id @param {Map<number, Uint8Array>} keys @param {Uint8Array} nameKey @param {number} epoch the ring's current epoch */
  constructor(id, keys, nameKey, epoch) { this.id = id; this.keys = keys; this.nameKey = nameKey; this.epoch = epoch; }
  /** The key a new thing is sealed under: the newest epoch this holder has. */
  current() { const n = Math.max(...this.keys.keys()); return { epoch: n, key: /** @type {Uint8Array} */ (this.keys.get(n)) }; }
  /** @param {number} epoch */ at(epoch) { const k = this.keys.get(epoch); if (!k) throw bad("this holder holds no key of that epoch", "denied"); return k; }
  toJSON() { throw bad("a key is never serialised", "denied"); }
  lock() { for (const k of this.keys.values()) k.fill(0); this.nameKey.fill(0); this.keys.clear(); }
}

/** @param {Record<string, any>} holders @param {Uint8Array} key @param {string} aad */
const wrapAll = (holders, key, aad) => Object.fromEntries(Object.entries(holders).map(([h, jwk]) => [h, wrapForDevice(key, jwk, aad)]));

/** A new ring (a chat's or a project's): epoch 1 and a name key, wrapped to each holder (name to P-256 public JWK). @param {string} id @param {Record<string, any>} holders @returns {{ doc: RingDoc, keys: Keys }} */
export function createRing(id, holders) {
  if (!Object.keys(holders).length) throw bad("a ring needs a holder");
  const key = newKey(), nameKey = newKey();
  /** @type {RingDoc} */ const doc = { v: 1, id, epoch: 1, epochs: { 1: { wraps: wrapAll(holders, key, ringAad(id, 1)) } }, names: { 1: seal(nameKey, key, nameAad(id, 1)) } };
  return { doc, keys: new Keys(id, new Map([[1, key]]), nameKey, 1) };
}

/** What a holder reads with its own device key (async: that key's ECDH is). @param {RingDoc} doc @param {string} holder @param {Ecdh | { d?: string }} device @returns {Promise<Keys>} */
export async function openRing(doc, holder, device) {
  /** @type {Map<number, Uint8Array>} */ const keys = new Map();
  for (const [n, e] of Object.entries(doc.epochs)) {
    const w = e.wraps[holder];
    if (w) keys.set(Number(n), await unwrapWithDevice(w, device, ringAad(doc.id, Number(n))));
  }
  if (!keys.size) throw bad("this device holds no wrap of the key", "denied");
  const top = Math.max(...keys.keys());
  const nameKey = open(doc.names[top], /** @type {Uint8Array} */ (keys.get(top)), nameAad(doc.id, top));
  return new Keys(doc.id, keys, nameKey, doc.epoch);
}

/** The next epoch: a new key wrapped to `to`, the name key sealed under it. @param {RingDoc} doc @param {Keys} k @param {Record<string, any>} to @returns {RingDoc} */
function rotate(doc, k, to) {
  const n = doc.epoch + 1, key = newKey();
  const next = { ...doc, epoch: n, epochs: { ...doc.epochs, [n]: { wraps: wrapAll(to, key, ringAad(doc.id, n)) } }, names: { ...doc.names, [n]: seal(k.nameKey, key, nameAad(doc.id, n)) } };
  k.keys.set(n, key); k.epoch = n;
  return next;
}

/**
 * Add holders (a participant's devices). `history` (the adder's choice, default on): the new holders also get every earlier epoch's key, so they read what came before; off, the ring rotates and they read from now on.
 * `all` is every holder that stays, with its public key (a rotation wraps to all of them).
 * @param {RingDoc} doc @param {Keys} k the adder's keys @param {{ add: Record<string, any>, all?: Record<string, any>, history?: boolean }} o @returns {RingDoc}
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

/** Remove holders: rotate. A new epoch, wrapped to `keep` only; the removed holders' wraps are deleted from every epoch (they keep what they already read and read nothing new). @param {RingDoc} doc @param {Keys} k @param {{ keep: Record<string, any>, drop: string[] }} o @returns {RingDoc} */
export function removeHolders(doc, k, o) {
  const next = rotate(doc, k, o.keep);
  for (const n of Object.keys(next.epochs)) { const w = { ...next.epochs[n].wraps }; for (const d of o.drop) delete w[d]; next.epochs[n] = { wraps: w }; }
  return next;
}

export { enc as utf8, dec as fromUtf8 };
