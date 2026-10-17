// @ts-check
// person-id: who is at the keyboard for a computers tool call (from the kernel chain, never the input).

import { personOfMeta } from "../../lib/lent-placement.js";
import { isPerson } from "../../lib/caller.js";

/**
 * The one person behind this call: meta.person, kernelFacts.person, or the sole person hop on the chain.
 * On the owner's own surface with no session, falls back to kernel.owner.
 * @param {any} ctx @param {any} meta
 * @returns {Promise<string|null>}
 */
export async function personIdOf(ctx, meta) {
  const direct = personOfMeta(meta);
  if (direct) return String(direct);
  const k = ctx && ctx.kernel;
  if (k && typeof k.chain === "function" && (meta && (meta.token || meta.kernelFacts))) {
    try {
      const c = await k.chain(meta);
      const persons = (c && Array.isArray(c.hops) ? c.hops : [])
        .filter(h => h && h.actor && h.actor.kind === "person")
        .map(h => String(h.actor.id));
      if (persons.length === 1) return persons[0];
    } catch { /* unreadable chain */ }
  }
  if (k && k.owner && isPerson(meta)) return String(k.owner);
  return null;
}
