// @ts-check
// webcrypto: the crypto provider on globalThis.crypto.subtle (X25519, AES-GCM, SHA-256, HMAC), for
// the web app and for Node 22+. The device's static key is made with its private half
// NON-EXTRACTABLE: a script on the page can use it for the handshake but can never read it out, so
// even the hosted web app's own code cannot copy the key off the device. AES keys are imported
// non-extractable too. A CryptoKey structured-clones into IndexedDB, which is how the key persists.

import { base64url, fromBase64url, concat, fromHex, toBytes } from "./bytes.js";

const X = { name: "X25519" };
const PKCS8 = fromHex("302e020100300506032b656e04220420");

/**
 * @param {{ subtle?: SubtleCrypto, getRandomValues?: (a: Uint8Array) => Uint8Array }} [o]
 * @returns {import("./noise.js").CryptoProvider & { importKeyPair(raw: Uint8Array): Promise<import("./noise.js").KeyPair> }}
 */
export function webCrypto(o = {}) {
  const subtle = o.subtle || globalThis.crypto?.subtle;
  if (!subtle) throw new Error("no WebCrypto here: inject a provider (see noble.js)");
  const rand = o.getRandomValues || (a => globalThis.crypto.getRandomValues(a));
  const raw = async key => new Uint8Array(await subtle.exportKey("raw", key));
  const aes = k => k instanceof Uint8Array ? subtle.importKey("raw", k, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]) : k;
  return {
    async generateKeyPair() {
      const kp = /** @type {CryptoKeyPair} */ (await subtle.generateKey(X, false, ["deriveBits"]));
      return { privateKey: kp.privateKey, publicKey: await raw(kp.publicKey) };
    },
    async dh(privateKey, peerPub) {
      const pub = await subtle.importKey("raw", peerPub, X, true, []);
      return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, privateKey, 256));
    },
    async sha256(bytes) { return new Uint8Array(await subtle.digest("SHA-256", bytes)); },
    async hmacSha256(key, bytes) {
      const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await subtle.sign("HMAC", k, bytes));
    },
    aesKey: raw => subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    async aesGcmEncrypt(key, nonce, ad, pt) {
      return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: ad, tagLength: 128 }, await aes(key), pt));
    },
    async aesGcmDecrypt(key, nonce, ad, ct) {
      return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: ad, tagLength: 128 }, await aes(key), ct));
    },
    randomBytes: n => rand(new Uint8Array(n)),
    /**
     * A key pair from a raw private key. Only for test vectors and for moving a key made
     * elsewhere: a key that was ever raw bytes was readable once. The result is non-extractable.
     */
    async importKeyPair(rawPriv) {
      const der = concat(PKCS8, toBytes(rawPriv));
      const tmp = await subtle.importKey("pkcs8", der, X, true, ["deriveBits"]);
      const jwk = await subtle.exportKey("jwk", tmp);
      const privateKey = await subtle.importKey("pkcs8", der, X, false, ["deriveBits"]);
      der.fill(0);
      return { privateKey, publicKey: fromBase64url(String(jwk.x)) };
    },
  };
}

/** A new device key: X25519, private half non-extractable. @param {import("./noise.js").CryptoProvider} [provider] */
export const createDeviceKey = (provider = webCrypto()) => provider.generateKeyPair();

/**
 * @typedef {{ get(): Promise<import("./noise.js").KeyPair | null>, set(keyPair: import("./noise.js").KeyPair): Promise<void> }} KeyStore
 */

/** A key store in memory, for tests and for a session that should forget its key. @returns {KeyStore} */
export function memoryKeyStore() {
  /** @type {any} */
  let v = null;
  return { async get() { return v; }, async set(k) { v = k; } };
}

/**
 * The browser's key store: the CryptoKey itself goes into IndexedDB (structured clone keeps it
 * non-extractable), and the public key as base64url beside it.
 * @param {{ indexedDB?: IDBFactory, db?: string, store?: string, key?: string }} [o]
 * @returns {KeyStore}
 */
export function indexedDbKeyStore(o = {}) {
  const idb = o.indexedDB || globalThis.indexedDB;
  const dbName = o.db || "vyre-relay", store = o.store || "keys", id = o.key || "device";
  /** @type {Promise<IDBDatabase> | null} */
  let opening = null;
  const open = () => opening || (opening = new Promise((resolve, reject) => {
    if (!idb) { reject(new Error("no IndexedDB here")); return; }
    const req = idb.open(dbName, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(store); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("aborted"));
    });
  };
  return {
    async get() {
      const v = await run("readonly", s => s.get(id));
      return v && v.privateKey ? { privateKey: v.privateKey, publicKey: fromBase64url(v.publicKey) } : null;
    },
    async set(k) { await run("readwrite", s => s.put({ privateKey: k.privateKey, publicKey: base64url(k.publicKey) }, id)); },
  };
}
