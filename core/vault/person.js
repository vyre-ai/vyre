// @ts-check
// core/vault/person.js: is this call the person's own? Decided by the kernel's chain for the call (`ctx.kernel.chain(meta)`: exactly one person hop, no agent hop), never by the caller's label
// or by a session id a client sent. Only a build with no kernel (development) falls back to the daemon's own verified person-session fact; a packaged daemon always has the kernel.
// SHIM(legacy labels): the kernel-off branch goes with the cut-over (kernel on by default plus the packaged refusal to boot kernel-off).

/**
 * @param {any} ctx the module's ctx @returns {(meta: any) => Promise<boolean>}
 */
export function personCall(ctx) {
  return async meta => {
    if (!ctx.kernel || typeof ctx.kernel.chain !== "function") return Boolean(meta && meta.person); // SHIM(legacy labels)
    try {
      const c = await ctx.kernel.chain(meta);
      return Boolean(c && Array.isArray(c.hops) && c.hops.length === 1 && c.hops[0].actor && c.hops[0].actor.kind === "person");
    } catch { return false; }
  };
}
