// Where the in-page host keeps what first run makes (host-core.js): JSON only. The chain is public; the master record holds every key wrapped by the master password or the recovery key. Never a
// CryptoKey (a Mac window does not give a stored CryptoKey back) and never anything unwrapped. IndexedDB, with a memory fallback for a page that has none (a private window): then the identity lasts
// until the page closes, and the recovery key is the way back.
import type { Kept, KeptStore } from "./host-core.js";

const DB = "vyre-host";
const KEY = "self";
let memory: Kept | null = null;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kept");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
}

export const hostStore: KeptStore = {
  async load() {
    const db = await open();
    if (!db) return memory;
    return new Promise<Kept | null>((resolve) => {
      const req = db.transaction("kept", "readonly").objectStore("kept").get(KEY);
      req.onsuccess = () => { db.close(); resolve((req.result as Kept | undefined) ?? null); };
      req.onerror = () => { db.close(); resolve(memory); };
    });
  },
  async save(k) {
    memory = k;
    try { if (typeof navigator !== "undefined" && navigator.storage?.persist) await navigator.storage.persist(); } catch { /* best effort */ }
    const db = await open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kept", "readwrite");
      tx.objectStore("kept").put(k, KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    }).catch(() => { /* kept in memory for this page */ });
  },
};
