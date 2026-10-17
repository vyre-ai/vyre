// @ts-check
// The key the shared computers' member tokens and the agents' screen passwords are derived from. It is made on first need, and only when the vault item is truly absent: a read that fails (a missing grant, a
// locked or unreadable vault) is never taken for "absent", because the put that follows would otherwise replace an owner's key and change every token derived from it. The value is never held here: each use reads it.
import crypto from "node:crypto";

/**
 * @param {{ fetch: () => Promise<string | null | undefined>, put: (value: string) => Promise<{ existed?: boolean } | null | undefined>, bytes?: () => string }} d
 *   fetch reads the item through the module's declared need (throws when it cannot); put creates it only if the name is absent and answers { existed: true } without writing when it is not.
 */
export function createMemberKey(d) {
  const bytes = d.bytes || (() => crypto.randomBytes(32).toString("base64url"));
  /** Only the creation is single-flight, never the value. @type {Promise<void> | null} */ let making = null;
  /** Counts finished creations, so a caller whose read began before one does not make a second. */ let epoch = 0;
  const make = () => making || (making = (async () => { try { await d.put(bytes()); } finally { epoch++; making = null; } })());
  return async function memberKey() {
    const seen = epoch;
    try { const v = await d.fetch(); if (v) return String(v); } catch { /* absent, or unreadable: put decides which, and it writes only on absent */ }
    if (seen === epoch) await make(); else if (making) await making;
    const v = await d.fetch();   // after a create, or after the item turned out to exist: a read that still fails is the vault's own refusal, and nothing was written
    if (!v) throw new Error("the shared computers' member key could not be read");
    return String(v);
  };
}
