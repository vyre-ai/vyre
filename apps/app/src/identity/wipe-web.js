// @ts-check
// What a browser holds, and how it is forgotten (wipe.js has the rule for when). `env` is the page's globals, so a test passes fakes; nothing here is browser-only code at import time.

/** The databases this app keeps, by name: the device's identity key, its agreement key, its person key, and the resilience store (the cache of recent views, the pins and the outbox). */
export const KNOWN_DATABASES = Object.freeze(["vyre-identity", "vyre-agree", "vyre-person", "vyre-resilience"]);

/** Delete one IndexedDB database. A database another tab still holds open ("blocked") is deleted as soon as it lets go; the wipe does not wait for that. @param {any} idb @param {string} name */
function deleteDatabase(idb, name) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = idb.deleteDatabase(name); } catch (e) { reject(e); return; }
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(req.error || new Error(`could not delete ${name}`));
    req.onblocked = () => resolve(undefined);
  });
}

/** Every database of this origin, by name: the browser's own list where it has one, else the names this app keeps. @param {any} env @returns {Promise<string[]>} */
async function databaseNames(env) {
  try { if (typeof env.indexedDB?.databases === "function") return (await env.indexedDB.databases()).map((/** @type {any} */ d) => String(d.name)).filter(Boolean); } catch { /* fall back */ }
  return [...KNOWN_DATABASES];
}

/** @param {any} env @param {string[]} only the names to delete (all of them are, afterwards, in the last step) */
const dropDatabases = async (env, only) => {
  if (!env.indexedDB) return;
  const have = new Set(await databaseNames(env));
  for (const n of only) if (have.has(n) || !env.indexedDB.databases) await deleteDatabase(env.indexedDB, n);
};

/** @param {any} env @returns {import("./wipe.js").WipeStep[]} */
export function webSteps(env) {
  return [
    { name: "device keys", run: () => dropDatabases(env, ["vyre-identity", "vyre-agree", "vyre-person"]) },
    // the pairing, the push subscription, the settings and the person's marks are kept in the page's storage; the pins are in the resilience store, deleted below
    { name: "pairing", run: async () => { env.localStorage?.clear(); } },
    { name: "settings and pins", run: async () => { env.localStorage?.clear(); env.sessionStorage?.clear(); await dropDatabases(env, ["vyre-resilience"]); } },
    { name: "recent views", run: () => dropDatabases(env, ["vyre-resilience"]) },
    // undelivered writes wait in the same store; deleting it again is harmless and keeps the outbox's own line in the report
    { name: "outbox", run: () => dropDatabases(env, ["vyre-resilience"]) },
    { name: "cached app files", run: async () => {
      const keys = env.caches ? await env.caches.keys() : [];
      for (const k of keys) await env.caches.delete(k);
      const regs = env.navigator?.serviceWorker?.getRegistrations ? await env.navigator.serviceWorker.getRegistrations() : [];
      for (const r of regs) await r.unregister();
    } },
    // the unlock session lives in the page's memory and in the cookie the box set; a reload ends the first, and the cookie is the box's to expire (it is refused from here on: the device is no longer paired)
    { name: "unlock session", run: async () => { env.sessionStorage?.clear(); } },
    // anything else this origin kept in a database
    { name: "every other database", run: async () => { for (const n of await databaseNames(env)) await deleteDatabase(env.indexedDB, n); } },
  ];
}
