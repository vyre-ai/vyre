// kernel/spaces/namespace.js: the sealing process is one process per home; each Space it serves is its own sealing namespace. `namespaced(sealer, space)` is the handle one
// Space's kernel is given: its `kernel.mac` and `kernel.verify` cover `<space>\n<data>`, so a MAC the grants store or chain builder made in one Space verifies in no other
// (K-3: no key lives on the host, and no key file is kept per Space). Everything else (presence, seal, leases) is the sealing process's own and already takes the Space in its ctx.
/** @param {any} sealer the home's sealing client @param {string} space */
export function namespaced(sealer, space) {
  if (!sealer || !sealer.kernel) throw new Error("a Space's kernel needs the sealing process's kernel.mac and verify");
  const wrap = (/** @type {{ purpose: string, data: string, mac?: string }} */ i) => ({ ...i, data: `${space}\n${i.data}` });
  const kernel = Object.freeze({
    mac: (/** @type {any} */ i) => sealer.kernel.mac(wrap(i)),
    verify: (/** @type {any} */ i) => sealer.kernel.verify(wrap(i)),
  });
  return new Proxy(sealer, { get: (t, p) => (p === "kernel" ? kernel : typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
}
