// @ts-check
// Keep spaces.compute (terms, maxSessions, member accept records) aligned with kernel Offers on every path that changes consent: space allow, member lend, compute tools.

/**
 * After the kernel's space_allows Offer changed, mirror the same fact into the compute store.
 * @param {{ allowSpace(a: any): Promise<any> }} compute
 * @param {{ actor: string, enabled: boolean, terms?: any }} a
 */
export async function syncComputeSpaceAllow(compute, a) {
  return compute.allowSpace({ actor: a.actor, enabled: a.enabled, terms: a.terms });
}

/**
 * When a member lends a device, record compute acceptance of the space's current terms (Offers already carry member_accepts from lend).
 * @param {{ status(a: any): Promise<any>, acceptMember(a: any): Promise<any> }} compute
 * @param {string} person
 */
export async function syncComputeMemberAcceptForLend(compute, person) {
  const st = await compute.status({ person });
  if (!st.spaceAllows) return { accepted: false, skipped: "space_not_allowed" };
  if (st.acceptedCurrentTerms) return { accepted: true, hash: st.hash };
  if (!st.hash) return { accepted: false, skipped: "no_terms" };
  const r = await compute.acceptMember({ person, enabled: true, terms: st.hash });
  return { accepted: true, hash: r.hash };
}

/**
 * When compute.allow changes the space side, member accept records that no longer match the hash are stale; acceptMember with new terms is required before lend — status() already exposes needs.
 * @param {{ allowSpace(a: any): Promise<any> }} compute
 * @param {{ actor: string, enabled: boolean, maxSessions?: number }} a
 */
export async function applyComputeAllow(compute, a) {
  const terms = a.maxSessions === undefined ? undefined : { maxSessions: a.maxSessions };
  return compute.allowSpace({ actor: a.actor, enabled: a.enabled, terms });
}
