// @ts-check
// lib/member-reach: who a call is for, read from the verified chain, and whether she is staff (the Space's owner, an admin, or a call with no person on it) or a member.
// The chain is built by the kernel from the session token the daemon verified; a label a caller sets is never read. A chain that cannot be read is no one: it is a member with nothing,
// not staff (the same fail-closed rule agents.seesFull and projects.list keep). Pure: the kernel is passed in, so any part may import this (test/boundaries.test.js).

/**
 * @typedef {{ staff: boolean, person: string | null, unreadable: boolean, canon: (id: string) => string }} Asker
 * staff: the owner's surfaces, the owner, an admin, or a Space with no kernel. person: the member's id (null for staff with no person on the chain). unreadable: the chain could not be read.
 */

/**
 * @param {any} K the kernel (ctx.kernel), or null where there is none @param {any} meta the call's meta
 * @returns {Promise<Asker>}
 */
export async function askerOf(K, meta) {
  const canon = K && typeof K.canonicalPerson === "function" ? (/** @type {string} */ x) => String(K.canonicalPerson(x)) : (/** @type {string} */ x) => String(x);
  if (!K || typeof K.chain !== "function") return { staff: true, person: null, unreadable: false, canon };
  let chain;
  try { chain = await K.chain(meta); } catch { return { staff: false, person: null, unreadable: true, canon }; }
  const hop = chain && Array.isArray(chain.hops) ? chain.hops.find((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person") : null;
  if (!hop) return { staff: true, person: null, unreadable: false, canon };
  const person = String(hop.actor.id);
  if (K.owner && canon(person) === canon(String(K.owner))) return { staff: true, person, unreadable: false, canon };
  const m = typeof K.membership === "function" ? await Promise.resolve(K.membership(person, K.space)).catch(() => null) : null;
  const staff = Boolean(m && m.member === true && (m.role === "owner" || m.role === "admin"));
  return { staff, person, unreadable: false, canon };
}
