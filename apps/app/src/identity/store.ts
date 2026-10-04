// Where this device keeps the identity it made: the name, the id, the chain (public), and the device key (a non-extractable CryptoKey pair, or the
// software seed). IndexedDB on the web, where a CryptoKey can be stored without ever being readable. The phone keeps it in the secure store next
// (a follow-up: until then a phone keeps it for the session only). The recovery code is never here: it is shown once and dropped.

import { restoreDeviceKey, type DeviceKey } from "./keys.js";

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

export async function saveIdentity(i: { name: string; id: string; eid: string; ops: unknown[]; pin: KeptIdentity["pin"]; key: DeviceKey }): Promise<void> {
  const rec: KeptIdentity = { name: i.name, id: i.id, eid: i.eid, ops: i.ops, pin: i.pin, kept: i.key.keep(), software: i.key.software, createdAt: Date.now() };
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
  return { ...rec, key: await restoreDeviceKey(rec.kept) };
}
