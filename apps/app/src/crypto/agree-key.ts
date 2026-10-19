// This device's key-agreement (ECDH P-256) key, the one other devices wrap a chat key to. One interface for every platform: getAgreeKey() (or agreeKeyResult(), which also says why there is none).
// The device's public point rides its identity list entry as `agree` (kernel/identity/chain.js), which is how a participant finds it.
//
// Where the key lives, strongest first, and a weaker store only when the stronger one refuses:
//   1. The Mac app's window: the shell's agreement key (Host/MacAgree.swift). The Secure Enclave when the Mac will make one there; otherwise a software key in the Mac's login Keychain (KeyBundle.swift),
//      which needs no entitlement, so an app signed ad hoc (no Developer ID yet) keeps it. This is the store chats on a Mac use.
//   2. The page's own non-extractable WebCrypto key in IndexedDB: what a browser (and the Windows panel) uses, and the Mac's last resort when its Keychain refused.
//   3. The same key kept as JWK in IndexedDB, when IndexedDB will not give a stored CryptoKey back. An ad-hoc-signed Mac window is such a page: WebKit wraps a stored CryptoKey with a master key it keeps
//      in the Keychain, and without an entitlement that fails, so the key came back as nothing and a NEW key was made on every launch. The point on the person's list was then never this launch's
//      key, and every chat said "This device isn't ready for private chats yet." (v0.6.1 and v0.6.2 on the owner's Mac.)
// Every store is checked by reading the key back before it is used; if none keeps it, the caller gets the reason ("Vyre couldn't save this device's chat key: ..."), never a key that is gone next launch.
//
// BACKLOG (when the Mac app is signed with a Developer ID): migrate fallback keys into the Enclave or data-protection Keychain. The list holds one agree point per device, set once, so that move needs a
// chain op that replaces a device's point; until then a fallback key stays the device's key.
import { fingerprint, b64, unb64, type Ecdh } from "../../../../lib/keywrap.js";
import { shellIdentity, shellKind } from "../shell/shell.ts";

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
};

/** Which store holds this device's key: the shell's (Keychain or Secure Enclave), the page's WebCrypto key, or the page's JWK. */
export type AgreeStore = "native" | "webcrypto" | "jwk";
export type AgreeKeyResult = { key: AgreeKey; store: AgreeStore } | { key: null; reason: string };

/** What the person reads when no store kept the key. */
export const chatKeyProblem = (reason: string): string => `Vyre couldn't save this device's chat key: ${reason}.`;

const DB = "vyre-agree";
const STORE = "keys";
/** A browser's key (and the Windows panel's). */
const KEY = "self";
/** A Mac window's last-resort key, kept only when the shell's Keychain refused. Its own row: the key an older Mac build left under "self" never came back, and must not be taken for this one. */
const MAC_FALLBACK = "mac-fallback";

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
const get = (db: IDBDatabase, slot: string): Promise<unknown> => new Promise((resolve) => {
  try { const q = db.transaction(STORE).objectStore(STORE).get(slot); q.onsuccess = () => resolve(q.result ?? null); q.onerror = () => resolve(null); } catch { resolve(null); }
});
/** Resolves when the write is done; rejects when the page would not store the value (a CryptoKey it cannot wrap throws here). */
const put = (db: IDBDatabase, slot: string, v: unknown): Promise<void> => new Promise((resolve, reject) => {
  const t = db.transaction(STORE, "readwrite");
  t.objectStore(STORE).put(v, slot);
  t.oncomplete = () => resolve();
  t.onerror = () => reject(t.error ?? new Error("the write failed"));
});

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

const reasonOf = (e: unknown): string => String((e as { message?: string } | null)?.message || e || "an unknown error").replace(/[.\s]+$/, "");
const ALG = { name: "ECDH", namedCurve: "P-256" } as const;

/** The key a stored row holds, or null: a CryptoKeyPair, or { v: 1, jwk } (a private JWK). */
async function fromRow(row: unknown): Promise<{ key: AgreeKey; store: AgreeStore } | null> {
  if (!row || typeof row !== "object") return null;
  const r = row as { privateKey?: CryptoKey; publicKey?: CryptoKey; v?: number; jwk?: JsonWebKey };
  try {
    if (r.privateKey && r.publicKey) return { key: await agreeKeyOf(r as CryptoKeyPair), store: "webcrypto" };
    if (r.v === 1 && r.jwk && typeof r.jwk.d === "string") {
      const privateKey = await crypto.subtle.importKey("jwk", { ...r.jwk, key_ops: ["deriveBits"] }, ALG, false, ["deriveBits"]);
      const publicKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: r.jwk.x, y: r.jwk.y }, ALG, true, []);
      return { key: await agreeKeyOf({ privateKey, publicKey }), store: "jwk" };
    }
  } catch { /* not a key this page can use */ }
  return null;
}

/** The page's key in `slot`: the one kept there, else a new one, kept and read back before it is used. A reason when the page keeps none. */
async function pageKey(slot: string, make: boolean): Promise<{ key: AgreeKey; store: AgreeStore } | string> {
  if (typeof crypto === "undefined" || !crypto.subtle) return "this page has no WebCrypto";
  const db = await open();
  if (!db) return "this page has no IndexedDB to keep it in";
  const kept = await fromRow(await get(db, slot));
  if (kept || !make) return kept ?? "no key is kept";
  // A non-extractable CryptoKey first: the private key cannot be read out of the page.
  try {
    const pair = (await crypto.subtle.generateKey(ALG, false, ["deriveBits"])) as CryptoKeyPair;
    const want = (await agreeKeyOf(pair)).point;
    await put(db, slot, pair);
    const back = await fromRow(await get(db, slot));
    if (back && back.key.point === want) return back;
  } catch { /* the page would not store a CryptoKey */ }
  // A page that does not give a stored CryptoKey back keeps JSON: the key as a private JWK (the owner's ruling, 19 Oct: make it work now, the stronger store comes with Apple signing).
  try {
    const pair = (await crypto.subtle.generateKey(ALG, true, ["deriveBits"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await put(db, slot, { v: 1, jwk });
    const back = await fromRow(await get(db, slot));
    if (back && back.key.jwk.x === jwk.x && back.key.jwk.y === jwk.y) return back;
    return "this page's storage did not give the key back";
  } catch (e) { return `this page's storage refused it (${reasonOf(e)})`; }
}

/** The Mac shell's agreement key, a reason when the shell refused, or null where there is no Mac shell with one. The Windows panel keeps its page key, the one its list already holds. */
async function macKey(): Promise<AgreeKey | string | null> {
  if (shellKind() !== "mac") return null;
  const id = shellIdentity();
  if (!id?.agreePublic || !id.agree) return null;
  const agree = id.agree;
  try {
    const point = await id.agreePublic(true);
    return await agreeKeyOfPoint(point, async (epk) => {
      const s = unb64(await agree(b64(epk)));
      if (s.length !== 32) throw new Error("The agreement key gave a bad answer.");
      return s;
    });
  } catch (e) { return reasonOf(e); }
}

let cached: Promise<AgreeKeyResult> | null = null;

/** This device's agree key and the store holding it, made once and kept; or the reason no store kept one. A failure is not remembered, so the next ask (the readiness timer, an unlock) tries again. */
export function agreeKeyResult(): Promise<AgreeKeyResult> {
  if (cached) return cached;
  const p: Promise<AgreeKeyResult> = (async (): Promise<AgreeKeyResult> => {
    if (shellKind() === "mac" && shellIdentity()?.agreePublic) {
      // A fallback key made on an earlier launch (when the Keychain refused) stays this Mac's key: its point is the one on the list.
      const earlier = await pageKey(MAC_FALLBACK, false);
      if (typeof earlier !== "string") return earlier;
      const mac = await macKey();
      if (mac && typeof mac !== "string") return { key: mac, store: "native" };
      const page = await pageKey(MAC_FALLBACK, true);
      if (typeof page !== "string") return page;
      return { key: null, reason: `the Mac's Keychain said "${mac || "no key"}", and ${page}` };
    }
    const page = await pageKey(KEY, true);
    return typeof page === "string" ? { key: null, reason: page } : page;
  })().catch((e) => ({ key: null, reason: reasonOf(e) }));
  cached = p;
  void p.then((r) => { if (!r.key && cached === p) cached = null; });
  return p;
}

/** This device's agree key, or null where no store keeps one (agreeKeyResult says why). */
export async function getAgreeKey(): Promise<AgreeKey | null> {
  return (await agreeKeyResult()).key;
}

/** Tests only: forget the cached key so a test can change the page around it. */
export function _forgetAgreeKey(): void { cached = null; }
