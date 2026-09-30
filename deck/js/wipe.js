// @ts-check
// Removing a phone wipes it (plans/pwa.md section 5 check 6, reviewer P-M2). A phone that the owner
// removed from Settings > Devices must not keep the box's session titles, Needs rows, chat
// snippets, its device key or its push subscription. This clears Cache Storage, IndexedDB (the
// resilience store and the device key live there), this app's localStorage and sessionStorage, the
// push subscription and the app badge, and the service workers, then shows one plain screen.
//
// What says "this phone was removed":
//   presence.removed { id }  whose id is this phone's passkey (localStorage "vyre.passkey"),
//   device.removed { id }    whose id is this phone's push device or relay device,
//   a launch check          the phone has a passkey note but presence.keys no longer lists it
//                           (it was removed while the phone was away), asked once per launch.
// Nothing polls. A box that cannot be asked (offline, unreachable) wipes nothing.

import { h, put } from "./dom.js";

const get = (/** @type {any} */ store, /** @type {string} */ k) => { try { return store?.getItem(k) ?? null; } catch { return null; } };

/**
 * The ids that mean "this phone": its passkey, its push device, its relay device.
 * @param {any} store localStorage
 * @returns {string[]}
 */
export function myIds(store) {
  /** @type {string[]} */ const ids = [];
  try { const p = JSON.parse(get(store, "vyre.passkey") || "null"); if (p && typeof p.id === "string") ids.push(p.id); } catch {}
  for (const k of ["vyre.push.device", "vyre.relay.device"]) { const v = get(store, k); if (v) ids.push(v); }
  return ids;
}

/** Is this event the removal of this phone? @param {{ type?: string, payload?: any }} e @param {string[]} ids */
export function isMyRemoval(e, ids) {
  if (!e || (e.type !== "presence.removed" && e.type !== "device.removed")) return false;
  const id = e.payload && e.payload.id;
  return typeof id === "string" && ids.includes(id);
}

/**
 * Clear everything this phone holds of the box. Each step is tried alone, so one failing does not
 * leave the rest behind. Returns what it did, for the test.
 * @param {{ caches?: any, indexedDB?: any, localStorage?: any, sessionStorage?: any, navigator?: any }} env
 * @returns {Promise<string[]>}
 */
export async function wipeThisPhone(env) {
  /** @type {string[]} */ const done = [];
  const step = async (/** @type {string} */ name, /** @type {() => Promise<any> | any} */ fn) => { try { await fn(); done.push(name); } catch { /* keep going */ } };
  // The push subscription first: it is the one thing that keeps the box reaching this phone.
  await step("push", async () => {
    const reg = await env.navigator?.serviceWorker?.getRegistration?.();
    const sub = await reg?.pushManager?.getSubscription?.();
    if (sub) await sub.unsubscribe();
  });
  await step("badge", () => env.navigator?.clearAppBadge?.());
  await step("caches", async () => { for (const k of await env.caches.keys()) await env.caches.delete(k); });
  await step("indexedDB", async () => {
    const dbs = typeof env.indexedDB.databases === "function" ? await env.indexedDB.databases() : [{ name: "vyre-resilience" }];
    for (const d of dbs) if (d && d.name) await new Promise(res => { const r = env.indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = () => res(undefined); });
  });
  await step("localStorage", () => {
    const s = env.localStorage;
    for (const k of Object.keys(s)) if (k.startsWith("vyre.")) s.removeItem(k);
  });
  await step("sessionStorage", () => env.sessionStorage.clear());
  await step("workers", async () => { for (const r of await env.navigator.serviceWorker.getRegistrations()) await r.unregister(); });
  return done;
}

/** The one screen left behind. @param {HTMLElement} root */
export function showRemoved(root) {
  put(root, h("main", { class: "page-wait", role: "status", style: { padding: "48px 24px" } },
    h("h1", { class: "h2" }, "This phone was removed."),
    h("p", { class: "muted" }, "Everything Vyre kept on it is gone. To use it again, add it from your computer.")));
}

/**
 * Watch for this phone's removal. `on` is api.js's on(type, fn); `attempt` its attempt. Returns a stop.
 * @param {{ on: (type: string, fn: (e: any) => void) => () => void, attempt: (n: string) => Promise<{ data?: any, error?: any }>, env?: any, root?: HTMLElement, store?: any, onWiped?: () => void }} d
 */
export function watchRemoval(d) {
  const env = d.env || globalThis;
  const store = d.store || env.localStorage;
  let wiped = false;
  const wipe = async () => {
    if (wiped) return;
    wiped = true;
    await wipeThisPhone(env);
    if (d.root) showRemoved(d.root);
    d.onWiped?.();
  };
  const offs = ["presence.removed", "device.removed"].map(type => d.on(type, (/** @type {any} */ e) => { if (isMyRemoval({ type, payload: e && (e.payload ?? e) }, myIds(store))) wipe(); }));
  // Removed while away: the passkey note is here, the box no longer lists the key.
  (async () => {
    let mine = null;
    try { mine = JSON.parse(get(store, "vyre.passkey") || "null"); } catch {}
    if (!mine || typeof mine.id !== "string") return;
    const r = await d.attempt("presence.keys");
    if (r.error || !Array.isArray(r.data)) return; // cannot ask: wipe nothing
    if (!r.data.some((/** @type {any} */ k) => k && k.id === mine.id)) wipe();
  })().catch(() => {});
  return () => { for (const off of offs) off(); };
}
