// @ts-check
// requester: whose a held item is. The Gate records, from the kernel's verified chain and never from input, the first person on the chain that asked (a member's own agent files an item in the member's
// turn, and the chain says so). A member's item is the member's alone: only that person sees it and answers it, and neither the owner nor an admin does (the owner never approves a member's mail, 18 Oct 2026).
// An item with no requester (older ones, and any asked with no person on the chain) and an item that is the owner's own keep the old rule.

/** The first person on the verified chain of the call, or null (no kernel, a chain that cannot be read, or no person in it). @param {any} K @param {any} meta @returns {Promise<string | null>} */
export async function personOnChain(K, meta) {
  try {
    const c = K && typeof K.chain === "function" ? await K.chain(meta) : null;
    const h = c && Array.isArray(c.hops) ? c.hops.find((/** @type {any} */ x) => x && x.actor && x.actor.kind === "person") : null;
    return h && h.actor && typeof h.actor.id === "string" && h.actor.id ? h.actor.id : null;
  } catch { return null; }
}

/** Whether an item belongs to a member: it has a requester and that is not the owner (an item asked under the owner's id from before it adopted its identity is still the owner's). @param {any} row @param {any} K */
export const isMemberItem = (row, K) => Boolean(row && typeof row.requester === "string" && row.requester && canon(row.requester, K) !== (K && K.owner));

/** A person id kept from before the owner adopted an identity opens as the identity (the kernel's canonicalPerson); any other id is as given. @param {string} id @param {any} K */
const canon = (id, K) => (K && typeof K.canonicalPerson === "function" ? K.canonicalPerson(id) : id);

/**
 * May the person on this call see and answer the item? A member's item: only its requester. Any other item (the owner's own, or one with no requester): the owner and the admins, and a module (the internal
 * callers that hold no person: a sender's release tool, the approvals queue); a plain member never sees it, and neither does any other call with no person on its chain (a chain that could not be read fails
 * closed, since members now reach the Gate for their own items). A build with no kernel has no roles, so everything is as before.
 * @param {any} row @param {string | null} person @param {any} K @param {boolean} isModule whether the caller is a module (its label starts with "module:")
 */
export function mayHandle(row, person, K, isModule = false) {
  if (isMemberItem(row, K)) return person !== null && person === row.requester;
  if (!K || typeof K.roleOf !== "function") return true;
  if (person === null) return isModule;
  const role = K.roleOf(person);
  return role === "owner" || role === "admin";
}

/** Whether a call's caller label is a module's. @param {any} meta */
export const fromModule = meta => String((meta && meta.caller) || "").startsWith("module:");
