// The person session in a browser at another origin (app.vyre.run): where the key and the token
// live, and the sign-in hop (see person.ts for the protocol).
//
//   key     one ECDSA P-256 pair for this browser, made once, kept in IndexedDB as CryptoKey
//           objects (structured clone keeps them non-extractable)
//   token   per box, in the same database
//   hop     a full-page redirect to the box's /person/signin; the verifier waits in
//           sessionStorage and the code comes back as ?code= on this page
//
// Where IndexedDB is refused (a private window), both live in memory for the page: the person
// signs in again on the next load, and nothing weaker is written anywhere.

import { memorySlot, newKey, personSession, pkce, type PersonSession, type Slot } from "./person.ts";

const DB = "vyre-person";
const STORE = "person";
const PENDING = "vyre-person-pkce";
/** A sign-in started this recently is not started again on its own, so a failed hop cannot loop. */
const QUIET_MS = 30_000;

let dbP: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  return (dbP ??= new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB, 1);
    } catch {
      return resolve(null);
    }
    const stuck = setTimeout(() => resolve(null), 3_000);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      clearTimeout(stuck);
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(stuck);
      resolve(null);
    };
  }));
}

/** A Slot in IndexedDB, or in memory when the browser refuses it. */
function idbSlot<T>(key: string): Slot<T> {
  const mem = memorySlot<T>();
  const run = async <R>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<R | undefined> => {
    const d = await db();
    if (!d) return undefined;
    return new Promise((resolve) => {
      try {
        const tx = d.transaction(STORE, mode);
        const r = f(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(r.result as R);
        tx.onerror = tx.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  };
  return {
    async load() {
      const v = await run<T>("readonly", (s) => s.get(key));
      return v ?? (await mem.load());
    },
    async save(v) {
      await mem.save(v);
      await run("readwrite", (s) => (v === null ? s.delete(key) : s.put(v, key)));
    },
  };
}

/** Go to the box's sign-in page. The page leaves, so the promise never settles here; the code
 * arrives on the next load (finishSignIn). A native build answers with the code instead. */
export function openSignIn(url: string): Promise<string> {
  location.assign(url);
  return new Promise<string>(() => {});
}

const session = {
  read(): { box: string; verifier: string; at: number } | null {
    try {
      const v = JSON.parse(sessionStorage.getItem(PENDING) ?? "null");
      return v && typeof v.verifier === "string" && typeof v.box === "string" ? v : null;
    } catch {
      return null;
    }
  },
  write(v: { box: string; verifier: string; at: number } | null) {
    try {
      if (v) sessionStorage.setItem(PENDING, JSON.stringify(v));
      else sessionStorage.removeItem(PENDING);
    } catch {}
  },
};

/** This page's address without a code: where the box sends the person back. */
function here(): string {
  const u = new URL(location.href);
  u.searchParams.delete("code");
  u.hash = "";
  return u.origin + u.pathname + u.search;
}

/**
 * Start the hop to `box`. Returns false, without leaving, when a hop for this box started in the
 * last 30 s (it came back without a code, or the code did not trade): the UI offers a button,
 * which passes force.
 */
export async function startSignIn(box: string, o: { force?: boolean } = {}): Promise<boolean> {
  const last = session.read();
  if (!o.force && last && last.box === box && Date.now() - last.at < QUIET_MS) return false;
  const { verifier, challenge } = await pkce();
  session.write({ box, verifier, at: Date.now() });
  const url = `${box}/person/signin?cc=${challenge}&return=${encodeURIComponent(here())}`;
  await openSignIn(url);
  return true;
}

/**
 * Back from the box with ?code=: trade it, and take the code out of the address. Resolves true
 * when a token was stored, false when there was nothing to finish or the trade was refused.
 */
export async function finishSignIn(box: string, person: PersonSession): Promise<boolean> {
  const u = new URL(location.href);
  const code = u.searchParams.get("code");
  if (!code) return false;
  u.searchParams.delete("code");
  try {
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  } catch {}
  const pending = session.read();
  if (!pending || pending.box !== box) return false;
  const r = await person.exchange(code, pending.verifier);
  // Keep the timestamp on failure so the next 401 does not bounce straight back to the box.
  session.write(r.ok ? null : { ...pending, verifier: "" });
  return r.ok;
}

const keySlot = () => idbSlot<CryptoKeyPair>("key");

/**
 * This browser's one ECDSA P-256 pair (the person session's key), made on first use. Pairing
 * offers its public half to the box as the device's presence key.
 */
export async function personKey(): Promise<CryptoKeyPair> {
  const slot = keySlot();
  const k = await slot.load();
  if (k) return k;
  const made = await newKey();
  await slot.save(made);
  return made;
}

/** The person session for `box` in this browser. `onSignIn` hears every request for one. */
export function webPerson(box: string, onSignIn?: () => void): PersonSession {
  const origin = new URL(box).origin;
  return personSession({
    box: origin,
    stores: { key: keySlot(), token: idbSlot<string>("token:" + origin) },
    signIn: () => {
      onSignIn?.();
      void startSignIn(origin);
    },
  });
}
