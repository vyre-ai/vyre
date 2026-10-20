// The person's chat (key-agreement, ECDH P-256) key, the one other devices wrap a chat key to. v0.6.5, password only: it is the master record's `agreePrivate`, opened with the password and held in memory
// while the person is unlocked (useRecordAgreeKey). Every device of the person uses that one key, so no device makes its own and nothing is kept in the Keychain, the Secure Enclave or IndexedDB.
// Its public point rides the person's identity list entry as `agree` (kernel/identity/chain.js), which is how a participant finds it. Locked means no key: nothing can open a chat until the password is typed.
import { fingerprint, b64, unb64, type Ecdh } from "../../../../lib/keywrap.js";

/** The device's one private-key step: ECDH with an ephemeral public point inside the keystore, so the key never leaves it. */
const keystoreEcdh = (priv: CryptoKey): Ecdh => async (epk) => {
  const pub = await crypto.subtle.importKey("raw", epk as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
};

export type AgreeKey = {
  /** The raw uncompressed P-256 point, base64url: what the identity entry's `agree` holds. */
  point: string;
  /** The holder name in a ring: the key's fingerprint. */
  holder: string;
  /** The public key as a JWK (x and y), for wrapping to it. */
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  /** The one thing the private key does: the shared secret with an ephemeral public point. */
  ecdh: Ecdh;
  /** Chat keys an older build left on this device, for opening older chats ONLY: they are never used to make a wrap and never sent anywhere. */
  legacy?: { holder: string; ecdh: Ecdh }[];
};

/** Where the key came from: the person's master record (the only source now; the others are what older builds kept on a device). */
export type AgreeStore = "native" | "webcrypto" | "jwk" | "record";
export type AgreeKeyResult = { key: AgreeKey; store: AgreeStore } | { key: null; reason: string };

/** What the person reads when no store kept the key. */
export const chatKeyProblem = (reason: string): string => `Vyre can't open your chat key yet: ${reason}.`;

/** Turn a key pair into the AgreeKey the app uses. */
export async function agreeKeyOf(pair: CryptoKeyPair): Promise<AgreeKey> {
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { x: string; y: string };
  const point = new Uint8Array(65); point[0] = 4;
  const x = Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=")), (c) => c.charCodeAt(0));
  const y = Uint8Array.from(atob(jwk.y.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=")), (c) => c.charCodeAt(0));
  point.set(x, 1); point.set(y, 33);
  const pub = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
  return { point: b64(point), holder: await fingerprint(pub), jwk: pub, ecdh: keystoreEcdh(pair.privateKey) };
}

/** An AgreeKey from a raw uncompressed point (base64url) and the ECDH of the key behind it (the shell's). */
export async function agreeKeyOfPoint(point: string, ecdh: Ecdh): Promise<AgreeKey> {
  const pt = unb64(point);
  if (pt.length !== 65 || pt[0] !== 4) throw new Error("the key it gave is not a P-256 point");
  const jwk = { kty: "EC" as const, crv: "P-256" as const, x: b64(pt.subarray(1, 33)), y: b64(pt.subarray(33, 65)) };
  return { point: b64(pt), holder: await fingerprint(jwk), jwk, ecdh };
}

const ALG = { name: "ECDH", namedCurve: "P-256" } as const;

// ---- Keys older builds kept on this device: read only ----
// Before v0.6.5 each device made its own chat key (the Mac's login Keychain or Secure Enclave, or the page's IndexedDB). Chats wrapped to such a key still open with it, so it is READ here (never made, never
// written) and handed out only as a second way to open a ring: `legacy` on the person's key. Nothing wraps to it and nothing sends it anywhere. Signing out wipes the page's database (identity/wipe-web.js).
const DB = "vyre-agree";
const STORE = "keys";
const idb = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => { try { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); } catch { resolve(null); } });
};
const row = (db: IDBDatabase, slot: string): Promise<unknown> => new Promise((resolve) => { try { const q = db.transaction(STORE).objectStore(STORE).get(slot); q.onsuccess = () => resolve(q.result ?? null); q.onerror = () => resolve(null); } catch { resolve(null); } });
/** The key a stored row holds (a CryptoKeyPair, or { v: 1, jwk } a private JWK), or null. */
async function legacyOfRow(r: unknown): Promise<AgreeKey | null> {
  if (!r || typeof r !== "object") return null;
  const x = r as { privateKey?: CryptoKey; publicKey?: CryptoKey; v?: number; jwk?: JsonWebKey };
  try {
    if (x.privateKey && x.publicKey) return await agreeKeyOf(x as CryptoKeyPair);
    if (x.v === 1 && x.jwk && typeof x.jwk.d === "string") {
      const privateKey = await crypto.subtle.importKey("jwk", { ...x.jwk, key_ops: ["deriveBits"] }, ALG, false, ["deriveBits"]);
      const publicKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: x.jwk.x, y: x.jwk.y }, ALG, true, []);
      return await agreeKeyOf({ privateKey, publicKey });
    }
  } catch { /* not a key this page can use */ }
  return null;
}
/** Every old per-device chat key this device still holds, without making one. @returns {Promise<{ holder: string, ecdh: Ecdh }[]>} */
async function readLegacy(): Promise<{ holder: string; ecdh: Ecdh }[]> {
  const out: { holder: string; ecdh: Ecdh }[] = [];
  try {
    const db = await idb();
    if (db) for (const slot of ["self", "mac-fallback"]) { const k = await legacyOfRow(await row(db, slot)); if (k) out.push({ holder: k.holder, ecdh: k.ecdh }); }
  } catch { /* none */ }
  try {
    const { shellIdentity, shellKind } = await import("../shell/shell.ts");
    const id = shellKind() === "mac" ? shellIdentity() : null;
    if (id?.agreePublic && id.agree) {
      const agree = id.agree;
      const point = await id.agreePublic(false); // never create
      const k = await agreeKeyOfPoint(point, async (epk) => { const s = unb64(await agree(b64(epk))); if (s.length !== 32) throw new Error("bad answer"); return s; });
      out.push({ holder: k.holder, ecdh: k.ecdh });
    }
  } catch { /* no old Mac key */ }
  return out;
}

// ---- The person's one chat key: the master record's agreePrivate (v0.6.5, password only) ----
// The record (kernel/identity/master.js, apps/app/src/host/master-web.js) holds the chat key, wrapped under the password's key. Once it is opened, every device of the person uses that one key, so no device
// makes its own (no Keychain, no Secure Enclave, no IndexedDB key) and "this device is not ready for private chats" has nothing left to say. It lives in memory only: locking drops it.
let recordKey: AgreeKey | null = null;

/** A new chat key for a record that has none: the private half as a JWK string (what the record's agreePrivate holds) and its point. Nothing is stored here. */
export async function makeRecordAgreeKey(): Promise<{ point: string; priv: string }> {
  const pair = (await crypto.subtle.generateKey(ALG, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { point: (await agreeKeyOf(pair)).point, priv: JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }) };
}

/** Hold the record's chat key (`priv`: the JWK string), or drop it (null: the person locked). Returns its point. A key that is not a P-256 private JWK is refused. */
export async function useRecordAgreeKey(priv: string | null): Promise<string | null> {
  if (priv === null) { recordKey = null; return null; }
  let jwk: JsonWebKey;
  try { jwk = JSON.parse(priv) as JsonWebKey; } catch { throw new Error("the chat key in your record is not readable"); }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("the chat key in your record is not a P-256 key");
  const privateKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, key_ops: ["deriveBits"] }, ALG, false, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, ALG, true, []);
  const made = await agreeKeyOf({ privateKey, publicKey });
  recordKey = { ...made, legacy: (await readLegacy()).filter((l) => l.holder !== made.holder) };
  return recordKey.point;
}


/** This device's agree key and the store holding it, made once and kept; or the reason no store kept one. A failure is not remembered, so the next ask (the readiness timer, an unlock) tries again. */
export function agreeKeyResult(): Promise<AgreeKeyResult> {
  // The record's key is the only chat key. Before the person has unlocked there is none, and no device makes one of its own.
  return Promise.resolve(recordKey ? { key: recordKey, store: "record" as AgreeStore } : { key: null, reason: "type your password to unlock" });
}

/** This device's agree key, or null where no store keeps one (agreeKeyResult says why). */
export async function getAgreeKey(): Promise<AgreeKey | null> {
  return (await agreeKeyResult()).key;
}

/** Tests only: forget the cached key so a test can change the page around it. */
export function _forgetAgreeKey(): void { recordKey = null; }
