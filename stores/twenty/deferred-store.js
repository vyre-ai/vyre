// @ts-check
// A record store that is not there yet. When a Space's Twenty cannot be set up (no Docker for the helper, a compose file the helper refuses, a full disk), the
// daemon must not die and be started again forever: it keeps running, every record call answers `unavailable` in plain words, and the stores layer keeps trying
// in the background. When the real store is ready it is attached and everything the kernel did meanwhile at start (`define`, the kernel's own types) is played
// onto it first, so the kernel never knows it had a gap.
//
// Never a quiet fallback: this store holds nothing and invents nothing. A read is an error, not an empty list. The one thing it accepts is a type definition made
// while the kernel is still starting (`bootDone()` not yet called): it is remembered and applied when the real store attaches.

const unavailable = (/** @type {string} */ why) => Object.assign(new Error(why), { code: "unavailable", name: "StoreError" });

/**
 * @param {{ reason: () => string, log?: (m: string) => void }} o `reason`: the plain sentence every refused call carries (read each time, it changes as attempts go on)
 * @returns {any} the store (a Proxy: it forwards to the real store once attached) with `attach(real)`, `bootDone()`, `attached()`, `kind: "twenty"`
 */
export function createDeferredStore(o) {
  const log = o.log ?? (() => {});
  /** @type {any} */ let real = null;
  let booting = true;
  /** @type {any[]} */ const defs = [];
  let attaching = false;
  const refuse = () => unavailable(o.reason());
  const own = {
    kind: "twenty",
    attached: () => real !== null,
    bootDone: () => { booting = false; },
    /** The real store is ready: play the definitions the kernel made at start onto it, then forward everything. @param {any} store */
    async attach(store) {
      if (real || attaching) return;
      attaching = true;
      try {
        for (const diff of defs) await store.define(diff);
        defs.length = 0;
        real = store;
        log("the record store is ready; the definitions made while it was away were applied");
      } finally { attaching = false; }
    },
    features: () => ({ aggregate: true, search: true, changes: true, cursor_paging: true, attr_filter: true }),
    async define(/** @type {any} */ diff, /** @type {any} */ opt) {
      if (real) return real.define(diff, opt);
      if (!booting) throw refuse();
      defs.push(diff);
      return { applied: false, changes: [] };
    },
    async types() { if (real) return real.types(); throw refuse(); },
    async health() { return real ? real.health() : { ok: false, detail: o.reason() }; },
  };
  return new Proxy(own, {
    get(target, prop, receiver) {
      if (prop === "then") return undefined;   // an `await store` must not wait on us
      if (real && !(prop in target)) { const v = real[prop]; return typeof v === "function" ? v.bind(real) : v; }
      if (real && ["define", "types", "health", "features"].includes(String(prop))) { const v = real[prop]; return typeof v === "function" ? v.bind(real) : v; }
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "symbol") return undefined;
      // any other method: an error the caller can show; a property that is not a method reads as undefined
      return (/** @type {any[]} */ ..._a) => { throw refuse(); };
    },
  });
}
