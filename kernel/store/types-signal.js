// @ts-check
// A record store's definitions can change behind the gateway's back (a replay when the store attaches, a kit extending a store, a bridge): whoever changes them says so here, and whoever keeps a copy of what they say
// (the gateway's protected types) listens. Keyed by the store object the listener and the changer both hold.
/** @type {WeakMap<object, Set<() => void>>} */ const heard = new WeakMap();
/** @param {object} store @param {() => void} fn */
export const onTypesChanged = (store, fn) => { let s = heard.get(store); if (!s) heard.set(store, s = new Set()); s.add(fn); };
/** @param {object} store */
export const typesChanged = store => { for (const fn of heard.get(store) || []) fn(); };
