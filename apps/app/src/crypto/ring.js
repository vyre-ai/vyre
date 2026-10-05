// @ts-check
// Chat keys on a device (team/0.3/DESIGN-chat-keys.md, "Device side"), in WebCrypto, once: the same formats as lib/keywrap.js and lib/chat-keys.js (memory's node reference), so a ring this makes opens
// there and the other way round. A chat has a ring: epochs of a random key, each wrapped to the device keys that may read it, plus a name key sealed under every epoch. A server stores the document and
// never a key. Formats, byte for byte the reference's:
//   box      { v: 1, iv, ct, tag }            AES-256-GCM under a 32-byte key, with associated data (WebCrypto's output is ct then the 16-byte tag, split here)
//   wrapped  { v: 1, epk, iv, ct, tag }       ECDH-ES on P-256 (an ephemeral key per wrap), HKDF-SHA256 (salt the ephemeral public point, info "vyre-identity-wrap-v1"), AES-256-GCM
//   ring doc { v: 1, id, epoch, epochs: { [n]: { wraps: { [holder]: wrapped } } }, names: { [n]: box } }     holder = the device key's fingerprint
// The device's private key is never read here: an `ecdh(epk)` function does the one thing the key does (a CryptoKey on the web, the Secure Enclave on a phone or Mac).

const enc = (/** @type {string} */ s) => new TextEncoder().encode(s);
const dec = (/** @type {Uint8Array} */ b) => new TextDecoder().decode(b);
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** @param {Uint8Array} b */
export function b64(b) {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63];
    if (i + 1 < b.length) out += ALPHA[(n >> 6) & 63];
    if (i + 2 < b.length) out += ALPHA[n & 63];
  }
  return out;
}
/** @param {string} s */
export function unb64(s) {
  const clean = String(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  /** @type {number[]} */ const out = [];
  let acc = 0, bits = 0;
  for (const ch of clean) {
    const v = ALPHA.indexOf(ch);
    if (v < 0) throw Object.assign(new Error("not base64url"), { code: "bad_format" });
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  return new Uint8Array(out);
}
const cat = (/** @type {Uint8Array[]} */ ...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
const subtle = () => /** @type {SubtleCrypto} */ (globalThis.crypto.subtle);
const rand = (/** @type {number} */ n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** A new 32-byte key. */
export const newKey = () => rand(32);

/** @typedef {{ v: 1, iv: string, ct: string, tag: string }} Box */
/** @typedef {{ v: 1, epk: string, iv: string, ct: string, tag: string }} Wrapped */

/** Encrypt under a 32-byte key, bound to `aad`. @param {Uint8Array | string} plain @param {Uint8Array} key @param {string} aad @returns {Promise<Box>} */
export async function seal(plain, key, aad) {
  const iv = rand(12);
  const k = await subtle().importKey("raw", /** @type {BufferSource} */ (key), "AES-GCM", false, ["encrypt"]);
  const out = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: enc(aad), tagLength: 128 }, k, /** @type {BufferSource} */ (typeof plain === "string" ? enc(plain) : plain)));
  return { v: 1, iv: b64(iv), ct: b64(out.subarray(0, out.length - 16)), tag: b64(out.subarray(out.length - 16)) };
}

/** @param {Box} box @param {Uint8Array} key @param {string} aad @returns {Promise<Uint8Array>} @throws when the key or the binding is wrong */
export async function open(box, key, aad) {
  if (!box || box.v !== 1) throw bad("unknown format", "bad_format");
  try {
    const k = await subtle().importKey("raw", /** @type {BufferSource} */ (key), "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: /** @type {BufferSource} */ (unb64(box.iv)), additionalData: enc(aad), tagLength: 128 }, k, /** @type {BufferSource} */ (cat(unb64(box.ct), unb64(box.tag)))));
  } catch { throw bad("cannot open", "cannot_open"); }
}

const INFO = "vyre-identity-wrap-v1";
/** @param {Uint8Array} shared @param {Uint8Array} epk */
async function kek(shared, epk) {
  const ikm = await subtle().importKey("raw", /** @type {BufferSource} */ (shared), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: /** @type {BufferSource} */ (epk), info: enc(INFO) }, ikm, 256));
}

/** The 65-byte uncompressed point of a P-256 public JWK. @param {{ x?: string, y?: string }} jwk */
export const pointOf = (jwk) => cat(Uint8Array.of(4), unb64(String(jwk.x)), unb64(String(jwk.y)));

/** Wrap a key to a device's public key (ECDH-ES, P-256). @param {Uint8Array} key @param {{ x?: string, y?: string, kty?: string, crv?: string }} publicJwk @param {string} aad @returns {Promise<Wrapped>} */
export async function wrapForDevice(key, publicJwk, aad) {
  const eph = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const peer = await subtle().importKey("jwk", { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: peer }, /** @type {CryptoKey} */ (eph.privateKey), 256));
  const epk = new Uint8Array(await subtle().exportKey("raw", /** @type {CryptoKey} */ (eph.publicKey)));
  const box = await seal(key, await kek(shared, epk), aad);
  return { v: 1, epk: b64(epk), iv: box.iv, ct: box.ct, tag: box.tag };
}

/** @typedef {(epk: Uint8Array) => Promise<Uint8Array>} Ecdh  the device key's one job: the shared secret with an ephemeral public point */

/** @param {Wrapped} w @param {Ecdh} ecdh @param {string} aad @returns {Promise<Uint8Array>} */
export async function unwrapWithDevice(w, ecdh, aad) {
  if (!w || w.v !== 1) throw bad("unknown format", "bad_format");
  const epk = unb64(w.epk);
  let shared;
  try { shared = await ecdh(epk); } catch { throw bad("cannot open", "cannot_open"); }
  return open({ v: 1, iv: w.iv, ct: w.ct, tag: w.tag }, await kek(shared, epk), aad);
}

/** An Ecdh from a private key held as a CryptoKey (a browser's key), or as JWK (a test's). @param {CryptoKey | { d?: string, x?: string, y?: string }} priv @returns {Ecdh} */
export function ecdhFrom(priv) {
  return async (epk) => {
    const key = "algorithm" in priv ? /** @type {CryptoKey} */ (priv) : await subtle().importKey("jwk", { kty: "EC", crv: "P-256", ...priv, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const peer = await subtle().importKey("raw", /** @type {BufferSource} */ (epk), { name: "ECDH", namedCurve: "P-256" }, false, []);
    return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: peer }, key, 256));
  };
}

/** A fingerprint of a public key, to name a wrap by: SHA-256 of "<x>.<y>", the first 16 hex characters (lib/keywrap.js fingerprint). @param {{ x?: string, y?: string }} jwk */
export async function fingerprint(jwk) {
  const h = new Uint8Array(await subtle().digest("SHA-256", enc(`${jwk.x}.${jwk.y}`)));
  return [...h.subarray(0, 8)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// ---- the ring ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const ringAad = (/** @type {string} */ id, /** @type {number} */ epoch) => `ring:${id}:${epoch}`;
const nameAad = (/** @type {string} */ id, /** @type {number} */ epoch) => `ring-names:${id}:${epoch}`;

/** @typedef {{ v: 1, id: string, epoch: number, epochs: Record<string, { wraps: Record<string, Wrapped> }>, names: Record<string, Box> }} RingDoc */

/** What one holder can read of a ring: every epoch key it holds a wrap of, and the name key. In memory only, never written. */
export class Keys {
  /** @param {string} id @param {Map<number, Uint8Array>} keys @param {Uint8Array} nameKey @param {number} epoch */
  constructor(id, keys, nameKey, epoch) { this.id = id; this.keys = keys; this.nameKey = nameKey; this.epoch = epoch; }
  current() { const n = Math.max(...this.keys.keys()); return { epoch: n, key: /** @type {Uint8Array} */ (this.keys.get(n)) }; }
  /** @param {number} epoch */ at(epoch) { const k = this.keys.get(epoch); if (!k) throw bad("this holder holds no key of that epoch", "denied"); return k; }
  toJSON() { throw bad("a key is never serialised", "denied"); }
  lock() { for (const k of this.keys.values()) k.fill(0); this.nameKey.fill(0); this.keys.clear(); }
}

/** @param {Record<string, any>} holders @param {Uint8Array} key @param {string} aad */
const wrapAll = async (holders, key, aad) => Object.fromEntries(await Promise.all(Object.entries(holders).map(async ([h, jwk]) => [h, await wrapForDevice(key, jwk, aad)])));

/** A new ring: epoch 1 and a name key, wrapped to each holder (name to P-256 public JWK). @param {string} id @param {Record<string, any>} holders @returns {Promise<{ doc: RingDoc, keys: Keys }>} */
export async function createRing(id, holders) {
  if (!Object.keys(holders).length) throw bad("a ring needs a holder");
  const key = newKey(), nameKey = newKey();
  /** @type {RingDoc} */ const doc = { v: 1, id, epoch: 1, epochs: { 1: { wraps: await wrapAll(holders, key, ringAad(id, 1)) } }, names: { 1: await seal(nameKey, key, nameAad(id, 1)) } };
  return { doc, keys: new Keys(id, new Map([[1, key]]), nameKey, 1) };
}

/** What a holder reads with its own device key. @param {RingDoc} doc @param {string} holder @param {Ecdh} ecdh @returns {Promise<Keys>} */
export async function openRing(doc, holder, ecdh) {
  /** @type {Map<number, Uint8Array>} */ const keys = new Map();
  for (const [n, e] of Object.entries(doc.epochs)) {
    const w = e.wraps[holder];
    if (w) keys.set(Number(n), await unwrapWithDevice(w, ecdh, ringAad(doc.id, Number(n))));
  }
  if (!keys.size) throw bad("this device holds no wrap of the key", "denied");
  const top = Math.max(...keys.keys());
  const nameKey = await open(doc.names[top], /** @type {Uint8Array} */ (keys.get(top)), nameAad(doc.id, top));
  return new Keys(doc.id, keys, nameKey, doc.epoch);
}

/** @param {RingDoc} doc @param {Keys} k @param {Record<string, any>} to */
async function rotate(doc, k, to) {
  const n = doc.epoch + 1, key = newKey();
  const next = { ...doc, epoch: n, epochs: { ...doc.epochs, [n]: { wraps: await wrapAll(to, key, ringAad(doc.id, n)) } }, names: { ...doc.names, [n]: await seal(k.nameKey, key, nameAad(doc.id, n)) } };
  k.keys.set(n, key); k.epoch = n;
  return next;
}

/** Add holders: with history (the default) the new holders also get every earlier epoch's key; without, the ring rotates (`all` names every holder that stays). @param {RingDoc} doc @param {Keys} k @param {{ add: Record<string, any>, all?: Record<string, any>, history?: boolean }} o */
export async function addHolders(doc, k, o) {
  if (o.history === false) {
    if (!o.all) throw bad("adding without history rotates the ring: name every holder that stays");
    return rotate(doc, k, { ...o.all, ...o.add });
  }
  const epochs = { ...doc.epochs };
  for (const [n, key] of k.keys) epochs[n] = { wraps: { ...epochs[n].wraps, ...(await wrapAll(o.add, key, ringAad(doc.id, n))) } };
  return { ...doc, epochs };
}

/** Remove holders: rotate to `keep` only, and delete the removed holders' wraps from every epoch. @param {RingDoc} doc @param {Keys} k @param {{ keep: Record<string, any>, drop: string[] }} o */
export async function removeHolders(doc, k, o) {
  const next = await rotate(doc, k, o.keep);
  for (const n of Object.keys(next.epochs)) { const w = { ...next.epochs[n].wraps }; for (const d of o.drop) delete w[d]; next.epochs[n] = { wraps: w }; }
  return next;
}

// ---- lending the key to the server (an agent working in the chat) ---------------------------------------------------------------------------------------------------------------------
/** A bundle of a ring's keys wrapped to the server's one-use session public key (work.chat.keys.begin's session_pub, a P-256 JWK). @param {Keys} k @param {{ x?: string, y?: string }} sessionPub @returns {Promise<Wrapped>} */
export async function bundleFor(k, sessionPub) {
  const body = JSON.stringify({ id: k.id, epoch: k.epoch, nameKey: b64(k.nameKey), keys: Object.fromEntries([...k.keys].map(([n, v]) => [n, b64(v)])) });
  return wrapForDevice(enc(body), sessionPub, `chat-bundle:${k.id}`);
}

/** @param {Wrapped} bundle @param {string} id @param {Ecdh} ecdh @returns {Promise<Keys>} (the server's side; here for the tests) */
export async function openBundle(bundle, id, ecdh) {
  const b = JSON.parse(dec(await unwrapWithDevice(bundle, ecdh, `chat-bundle:${id}`)));
  return new Keys(b.id, new Map(Object.entries(b.keys).map(([n, v]) => [Number(n), unb64(String(v))])), unb64(b.nameKey), b.epoch);
}
