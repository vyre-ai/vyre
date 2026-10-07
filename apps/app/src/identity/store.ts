// Where this device keeps the identity it made: the name, the id, the chain (public), and the device key (a non-extractable CryptoKey pair, or the
// software seed). IndexedDB on the web, where a CryptoKey can be stored without ever being readable. The phone keeps it in the secure store next
// (a follow-up: until then a phone keeps it for the session only). The recovery code is never here: it is shown once and dropped.

import { restoreDeviceKey, wrapKept, type DeviceKey } from "./keys.js";
import { MAC_KEPT, macDeviceKey } from "./mac-key.ts";

export type KeptIdentity = { name: string; id: string; eid: string; ops: unknown[]; pin: { id: string; seq: number; head: string }; kept: unknown; software: boolean; createdAt: number };

const DB = "vyre-identity";
const KEY = "self";
let memory: KeptIdentity | null = null;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("identity");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
}

/** The marker (not the key) that this device once held a name: a phone that lost its key opens at "This iPhone no longer has your key". localStorage on the web; the phone's store sets its own. */
const HAD = "vyre.had-identity";
export async function hadIdentity(): Promise<boolean> {
  try { if (localStorage.getItem(HAD) === "1") return true; } catch { /* no localStorage here */ }
  try { return Boolean(await loadIdentity()); } catch { return false; }
}

export async function saveIdentity(i: { name: string; id: string; eid: string; ops: unknown[]; pin: KeptIdentity["pin"]; key: DeviceKey }): Promise<void> {
  const rec: KeptIdentity = { name: i.name, id: i.id, eid: i.eid, ops: i.ops, pin: i.pin, kept: await wrapKept(i.key.keep()), software: i.key.software, createdAt: Date.now() };
  // Safari drops script-written storage after about a week unseen unless the browser is asked to keep it; a refusal changes nothing here.
  try { if (typeof navigator !== "undefined" && navigator.storage?.persist) await navigator.storage.persist(); } catch { /* best effort */ }
  try { localStorage.setItem(HAD, "1"); } catch { /* no storage here */ }
  const db = await open();
  if (!db) { memory = rec; return; }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("identity", "readwrite");
    tx.objectStore("identity").put(rec, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadIdentity(): Promise<(KeptIdentity & { key: DeviceKey }) | null> {
  const db = await open();
  const rec: KeptIdentity | null = db
    ? await new Promise((resolve) => { const q = db.transaction("identity").objectStore("identity").get(KEY); q.onsuccess = () => resolve((q.result as KeptIdentity) ?? null); q.onerror = () => resolve(null); })
    : memory;
  if (!rec) return null;
  // The Mac app's window keeps the seed in the Mac's Keychain: the record says so, and the key is the shell's.
  if ((rec.kept as { kind?: string } | null)?.kind === MAC_KEPT.kind) {
    const key = await macDeviceKey();
    return key ? { ...rec, key } : null;
  }
  return { ...rec, key: await restoreDeviceKey(rec.kept) };
}

/** Forget what was kept (a claim that did not go through must not leave a key behind that names nothing). */
export async function forgetIdentity(): Promise<void> {
  memory = null;
  try { localStorage.removeItem(HAD); } catch { /* none */ }
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => { const tx = db.transaction("identity", "readwrite"); tx.objectStore("identity").delete(KEY); tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); });
}

/** Is there an identity key on this device? */
export async function hasIdentity(): Promise<boolean> { return (await loadIdentity()) !== null; }

/** The identity key made before a claim (the browser keeps it with the record, so the claim makes its own): none. */
export const createIdentityKey = async (): Promise<DeviceKey | undefined> => (await macDeviceKey(true)) ?? undefined;

/** The key kept on this device, or null. */
export async function identityKey(): Promise<DeviceKey | null> { return (await loadIdentity())?.key ?? null; }
