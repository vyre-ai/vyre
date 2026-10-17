// @ts-check
// core/connectors/who: whose call is this, for the connect tools. A member's connections are hers, so every tool that shows or changes one asks the Vault who is calling (vault.me.who) and keeps the answer's
// person, never anything in the input. `memberOf` is for the tools that change something: a call that carries a claim the Vault cannot name as one person (a forged or expired token, an assistant, two people)
// is refused, never served as the owner's; a call with no claim at all is the home's own work (a timer, a module), which is the owner's. `viewerOf` is for the two reads (the catalog's connected marks and the
// list): an assistant acting for one person reads that person's view, because those reads were open to assistants before connections belonged to people; it never writes.

const claimed = (/** @type {any} */ meta) => Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
const fail = (/** @type {string} */ msg, /** @type {string} */ code) => Object.assign(new Error(msg), { code });

/** @param {any} ctx the module's context: `call`, and `kernel` (`owner`, `chain`) */
export function createWho(ctx) {
  /** The member's person id, or "" for the owner and for work with no claim. @param {any} meta @returns {Promise<string>} */
  async function memberOf(meta) {
    if (!claimed(meta)) return "";
    const w = await ctx.call("vault.me.who", {}, { relay: true });
    if (w.error) throw fail(w.error.message, w.error.code || "denied");
    return w.data && w.data.kind === "member" ? String(w.data.person) : "";
  }

  /** Like memberOf, and an assistant with one person behind it reads that person's view (the owner's, or the member's). Anything else the Vault refuses stays refused. @param {any} meta @returns {Promise<string>} */
  async function viewerOf(meta) {
    try { return await memberOf(meta); } catch (e) {
      if (!e || /** @type {any} */ (e).code !== "denied") throw e;
      let hops;
      try { hops = ((await ctx.kernel.chain(meta || {})) || {}).hops; } catch { throw e; }
      const ids = [...new Set((Array.isArray(hops) ? hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id)))];
      if (ids.length !== 1) throw e;
      return String(ctx.kernel.owner) === ids[0] ? "" : ids[0];
    }
  }
  return { memberOf, viewerOf };
}
