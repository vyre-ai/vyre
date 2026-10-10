// @ts-check
// A record store that is not there yet. When a Space's Twenty cannot be set up (no Docker for the helper, a compose file the helper refuses, a full disk), the
// daemon must not die and be started again forever: it keeps running, every record call answers `unavailable` in plain words, and the stores layer keeps trying
// in the background. When the real store is ready it is attached and everything the kernel did meanwhile at start (`define`, the kernel's own types) is played
// onto it first, so the kernel never knows it had a gap.
//
// Never a quiet fallback: this store holds nothing and invents nothing. A read is an error, not an empty list. The one thing it accepts is a type definition made
// while the kernel is still starting (`bootDone()` not yet called): it is remembered and applied when the real store attaches.

/** The most definitions kept while the store is away; past it a define is refused in words, never dropped quietly. */
export const MAX_DEFS = 500;
const unavailable = (/** @type {string} */ why) => Object.assign(new Error(why), { code: "unavailable", name: "StoreError" });

/**
 * @param {{ reason: () => string, log?: (m: string) => void, waitMs?: number, waits?: () => boolean }} o `reason`: the plain sentence every refused call carries (read each time, it changes as attempts go on). `waitMs` (default 56 s, the first start) is how long a definition or a type read made after the kernel booted waits for the store to attach before it is refused in those words; `waits()` (default: never wait) says whether one is on its way at all (a store that failed to start is not waited for)
 * @returns {any} the store (a Proxy: it forwards to the real store once attached) with `attach(real)`, `bootDone()`, `attached()`, `kind: "twenty"`
 */
export function createDeferredStore(o) {
  const log = o.log ?? (() => {});
  /** @type {any} */ let real = null;
  let booting = true;
  /** @type {any[]} */ const defs = [];
  let attaching = false;
  const refuse = () => unavailable(o.reason());
  const waitMs = o.waitMs ?? 56_000;
  /** After boot, a caller that needs the store waits for it a bounded while (the first start is about a minute) rather than failing on the first second. True once attached. */
  const settle = () => real ? Promise.resolve(true) : (o.waits ? o.waits() : false) && waitMs > 0 ? new Promise(res => { const t = setTimeout(() => res(false), waitMs); if (t.unref) t.unref(); ready.push(() => { clearTimeout(t); res(true); }); }) : Promise.resolve(false);
  /** @type {Array<() => any>} work the kernel could not do while the store was away (its task records), run once the real store is attached */
  const ready = [];
  // The kernel's per-record attributes (`store.meta`, a Map the gateway reads and writes as it goes). The gateway takes hold of this object when it is built, which is
  // before the real store is attached, so it must be a real Map from the start (it was a function that refused, and every gated call then failed closed as "no such
  // record"). While the store is away it keeps the attributes here; when the real store attaches they are written onto its own map (which mirrors them to the
  // records), and from then on every call goes straight to that map.
  /** @type {Map<string, any>} */ const away = new Map();
  const meta = new Proxy(away, {
    get(target, prop) {
      const m = real && real.meta ? real.meta : target;
      const v = /** @type {any} */ (m)[prop];
      return typeof v === "function" ? v.bind(m) : v;
    },
  });
  const own = {
    kind: "twenty",
    /** Run `f` when the real store is attached (now, if it already is). @param {() => any} f */
    whenReady: (f) => { if (real) return f(); ready.push(f); },
    attached: () => real !== null,
    meta,
    bootDone: () => { booting = false; },
    /** The real store is ready: play the definitions the kernel made at start onto it, then forward everything. @param {any} store */
    async attach(store) {
      if (real || attaching) return;
      attaching = true;
      try {
        // A define that arrives while this replay runs is pushed to the same queue, so take from the front until it is empty; `real` is set in the
        // same turn as the last empty check (no await between), so nothing can be queued after the loop and lost.
        while (defs.length) await store.define(/** @type {any} */ (defs.shift()));
        if (store.meta) { for (const [u, a] of away) store.meta.set(u, a); away.clear(); }
        real = store;
        log("the record store is ready; the definitions made while it was away were applied");
        for (const f of ready.splice(0)) { try { await f(); } catch (e) { log(`something waiting for the record store failed: ${/** @type {Error} */ (e).message}`); } }
      } finally { attaching = false; }
    },
    features: () => ({ aggregate: true, search: true, changes: true, cursor_paging: true, attr_filter: true }),
    async define(/** @type {any} */ diff, /** @type {any} */ opt) {
      if (real) return real.define(diff, opt);
      if (!booting) { if (await settle()) return real.define(diff, opt); throw refuse(); }
      if (defs.length >= MAX_DEFS) throw unavailable("the store is not ready and too many changes are waiting");
      defs.push(diff);
      return { applied: false, changes: [] };
    },
    async types() { if (real) return real.types(); if (!booting && await settle()) return real.types(); throw refuse(); },
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
