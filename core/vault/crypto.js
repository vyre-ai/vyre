// @ts-check
// crypto — every primitive the Vault uses, from node:crypto and nothing else.
//
// The reasoning for each choice is in docs/adr/0001-vault-crypto.md. In short: one master key,
// a key per item derived with HKDF and bound to the item's id and name, AES-256-GCM everywhere,
// scrypt for a passphrase, Ed25519 to sign relay requests and X25519 to seal an item for another
// person's Vyre. Nothing here touches the disk; store.js and keys.js do that.

import crypto from "node:crypto";

const b64 = buf => Buffer.from(buf).toString("base64");
const unb64 = s => Buffer.from(String(s), "base64");

/** A fresh 32-byte master key. */
export const newMasterKey = () => crypto.randomBytes(32);

/** Stable JSON: keys sorted at every level, so a signature covers the same bytes on both ends. */
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

function gcmSeal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
}

function gcmOpen(key, { iv, tag, ct }, aad) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, unb64(iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(unb64(tag));
  return Buffer.concat([d.update(unb64(ct)), d.final()]);
}

const itemKey = (mk, id) => Buffer.from(crypto.hkdfSync("sha256", mk, Buffer.from(String(id)), "vyre vault item v1", 32));
const itemAad = (id, name) => `vyre:item:v1:${id}:${name}`;

/**
 * Seal one item's fields. The id and name are bound in, so a sealed file moved into another
 * item's slot fails to open rather than decrypting into the wrong grant.
 * @param {Buffer} mk @param {string} id @param {string} name @param {any} fields
 */
export function sealItem(mk, id, name, fields) {
  return { v: 1, alg: "A256GCM", ...gcmSeal(itemKey(mk, id), JSON.stringify(fields), itemAad(id, name)) };
}

/** Open one item's fields. Throws if the key, id, name or bytes are wrong. */
export function openItem(mk, id, name, sealed) {
  if (!sealed || sealed.v !== 1 || sealed.alg !== "A256GCM") throw new Error("not a sealed vault item");
  return JSON.parse(gcmOpen(itemKey(mk, id), sealed, itemAad(id, name)).toString("utf8"));
}

/** scrypt at N=2^17, r=8, p=1 needs 128 MB; maxmem has to allow it. */
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const scrypt = (pass, salt, o) => crypto.scryptSync(String(pass).normalize("NFKC"), salt, 32, { ...o, maxmem: 256 * 1024 * 1024 });

/** Wrap the master key under a passphrase, for the passphrase keystore. */
export function wrapKey(passphrase, mk, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  return { v: 1, kdf: "scrypt", ...params, salt: b64(salt), ...gcmSeal(scrypt(passphrase, salt, params), mk, "vyre:mk:v1") };
}

/** Unwrap it. A wrong passphrase throws, and says so in words. */
export function unwrapKey(passphrase, w) {
  if (!w || w.v !== 1 || w.kdf !== "scrypt") throw new Error("not a wrapped vault key");
  try { return gcmOpen(scrypt(passphrase, unb64(w.salt), { N: w.N, r: w.r, p: w.p }), w, "vyre:mk:v1"); }
  catch { throw new Error("that passphrase does not open this vault"); }
}

/** A device identity: Ed25519 to sign relay requests, X25519 to receive sealed items. DER, base64. */
export function newIdentity() {
  const s = crypto.generateKeyPairSync("ed25519"), x = crypto.generateKeyPairSync("x25519");
  const pub = k => b64(k.export({ format: "der", type: "spki" })), priv = k => b64(k.export({ format: "der", type: "pkcs8" }));
  return { sign: { public: pub(s.publicKey), private: priv(s.privateKey) }, box: { public: pub(x.publicKey), private: priv(x.privateKey) } };
}

const pubKey = der => crypto.createPublicKey({ key: unb64(der), format: "der", type: "spki" });
const privKey = der => crypto.createPrivateKey({ key: unb64(der), format: "der", type: "pkcs8" });

/** Sign a value (its canonical JSON). */
export const sign = (privDer, value) => b64(crypto.sign(null, Buffer.from(canonical(value)), privKey(privDer)));

/** Check a signature. Never throws: a malformed key or signature is simply not valid. */
export function verify(pubDer, value, sig) {
  try { return crypto.verify(null, Buffer.from(canonical(value)), pubKey(pubDer), unb64(sig)); } catch { return false; }
}

/**
 * Seal a value for one recipient's X25519 key (ECIES): an ephemeral key, HKDF over the shared
 * secret salted with the ephemeral public key, AES-256-GCM with the caller's AAD.
 */
export function sealFor(boxPubDer, value, aad) {
  const eph = crypto.generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ format: "der", type: "spki" });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubKey(boxPubDer) });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, epk, "vyre pass seal v1", 32));
  return { v: 1, epk: b64(epk), ...gcmSeal(key, JSON.stringify(value), aad) };
}

/** Open what sealFor made, with the recipient's private key and the same AAD. */
export function openFrom(boxPrivDer, sealed, aad) {
  const shared = crypto.diffieHellman({ privateKey: privKey(boxPrivDer), publicKey: pubKey(sealed.epk) });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, unb64(sealed.epk), "vyre pass seal v1", 32));
  return JSON.parse(gcmOpen(key, sealed, aad).toString("utf8"));
}

/** Compare two strings in constant time (for tokens and nonces, never for values). */
export function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
