// @ts-check
// core/vault/person.js: is this call the person's own? Decided by the kernel's chain for the call (`ctx.kernel.chain(meta)`: exactly one person hop, no agent hop), never by the caller's label
// or by a session id a client sent. A call with no kernel chain is nobody's.

/**
 * @param {any} ctx the module's ctx @returns {(meta: any) => Promise<boolean>}
 */
export function personCall(ctx) {
  return async meta => {
    if (!ctx.kernel || typeof ctx.kernel.chain !== "function") return false;
    try {
      const c = await ctx.kernel.chain(meta);
      return Boolean(c && Array.isArray(c.hops) && c.hops.length === 1 && c.hops[0].actor && c.hops[0].actor.kind === "person");
    } catch { return false; }
  };
}
