// This device's key-agreement (ECDH P-256) key, the one other devices wrap a chat key to. One interface for every platform: getAgreeKey(). A browser keeps a non-extractable WebCrypto key in IndexedDB; a phone or
// Mac answers through native-core's hook (the Secure Enclave key, ECDH is what that key does besides sign), which is not built into the app yet, so there it answers null and chats stay in the clear.
// The device's public point rides its identity list entry as `agree` (kernel/identity/chain.js), which is how a participant finds it.
import { fingerprint, ecdhFrom, b64, type Ecdh } from "./ring.js";

export type AgreeKey = {
  /** The raw uncompressed P-256 point, base64url: what the identity entry's `agree` holds. */
  point: string;
  /** The holder name in a ring: the key's fingerprint. */
  holder: string;
  /** The public key as a JWK (x and y), for wrapping to it. */
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  /** The one thing the private key does: the shared secret with an ephemeral public point. */
  ecdh: Ecdh;
};

const DB = "vyre-agree";
const STORE = "keys";
const KEY = "self";

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
}
const get = (db: IDBDatabase): Promise<CryptoKeyPair | null> => new Promise((resolve) => { const q = db.transaction(STORE).objectStore(STORE).get(KEY); q.onsuccess = () => resolve((q.result as CryptoKeyPair) ?? null); q.onerror = () => resolve(null); });
const put = (db: IDBDatabase, v: CryptoKeyPair): Promise<void> => new Promise((resolve) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).put(v, KEY); t.oncomplete = () => resolve(); t.onerror = () => resolve(); });

let cached: Promise<AgreeKey | null> | null = null;

/** Turn a key pair into the AgreeKey the app uses. */
export async function agreeKeyOf(pair: CryptoKeyPair): Promise<AgreeKey> {
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { x: string; y: string };
  const point = new Uint8Array(65); point[0] = 4;
  const x = Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=")), (c) => c.charCodeAt(0));
  const y = Uint8Array.from(atob(jwk.y.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=")), (c) => c.charCodeAt(0));
  point.set(x, 1); point.set(y, 33);
  const pub = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
  return { point: b64(point), holder: await fingerprint(pub), jwk: pub, ecdh: ecdhFrom(pair.privateKey) };
}

/** This device's agree key, made once and kept; null where there is no WebCrypto or no place to keep a key (a phone before native-core's hook, a private window with IndexedDB off). */
export function getAgreeKey(): Promise<AgreeKey | null> {
  cached ??= (async () => {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const db = await open();
    if (!db) return null;
    let pair = await get(db);
    if (!pair) {
      pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as CryptoKeyPair;
      await put(db, pair);
    }
    return agreeKeyOf(pair);
  })().catch(() => null);
  return cached;
}
