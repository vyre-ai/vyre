// @ts-check
// A module's declared types are defined EXTENDING what the Space already holds, never replacing it (lead ruling 10 Oct): a Kit adds fields to a core type (the base Kit's Project adds `stage` to the core
// Project), so when the module that owns the core type defines it again, the fields another definer added are kept. The module's own fields update; dropping a field still takes an explicit migration.

/**
 * @param {readonly any[]} wanted the types a module declares
 * @param {readonly any[]} have the types the store holds now
 * @returns {any[]} the declared types, each with the fields only the store has appended after the module's own
 */
export function extending(wanted, have) {
  return wanted.map(t => {
    const was = have.find(h => h && h.name === t.name);
    if (!was || !Array.isArray(was.fields) || !Array.isArray(t.fields)) return t;
    const extra = was.fields.filter((/** @type {any} */ f) => !t.fields.some((/** @type {any} */ x) => x.name === f.name));
    return extra.length ? { ...t, fields: [...t.fields, ...extra] } : t;
  });
}

import { typesChanged } from "../kernel/store/types-signal.js";

/** One define at a time per store: reading what the store holds and defining on top of it is one step, or two modules starting together each extend a stale copy and the later define drops the earlier's field. @type {WeakMap<object, Promise<any>>} */
const lines = new WeakMap();

/** Read what the store holds and define on top of it: one step, run one at a time per store by the callers below. @param {{ types: () => Promise<any[]>, define: (d: any) => Promise<any> }} store @param {readonly any[]} wanted */
const defineOn = async (store, wanted) => { const r = await store.define({ add_types: extending(wanted, await store.types().catch(() => [])) }); typesChanged(store); return r; };

/**
 * Define a module's declared types on the store, extending what is there, one module at a time per store. A store that is not there yet (a Space's own record store on its first start takes minutes) is
 * not waited for: the define is kept with the store (`defer`) and played when it attaches, in the order asked and before anything else reaches it, so a starting module is not held up and still finds its types.
 * @param {{ types: () => Promise<any[]>, define: (d: any) => Promise<any>, attached?: () => boolean, defer?: (f: (real: any) => Promise<any>) => Promise<any> }} store @param {readonly any[]} wanted
 */
export function defineExtending(store, wanted) {
  if (typeof store.defer === "function" && typeof store.attached === "function" && !store.attached()) return store.defer(real => defineOn(real, wanted));
  const run = () => defineOn(store, wanted);
  const prev = lines.get(store) || Promise.resolve();
  const next = prev.then(run, run);
  lines.set(store, next.catch(() => {}));
  return next;
}
