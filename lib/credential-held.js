// @ts-check
// lib/credential-held.js: does a person hold a vault credential now (an answer only, never a chain or a value)? The owner holds all of the vault they own; anyone else, what a grant gives.
// Asked for a lend (the approver must hold what they lend) and, at each use, of a lease's approver. Any error counts as not held.

/** @param {{ grantsStore: any, gateway: { authorize: (q: any) => Promise<any> }, chains: any, space: string }} o */
export function createCredentialHeld(o) {
  /** @param {string} person @param {string} action @param {string} resource @param {boolean} [asks] a use that waits for a yes at the Gate (an outward call at Fill in) counts as held: the grant matches and only the approval is missing; every deny stays no @returns {Promise<boolean>} */
  return async (person, action, resource, asks = false) => o.grantsStore.roleOf({ kind: "person", id: person, space: o.space }) === "owner" || Promise.resolve().then(() => o.gateway.authorize({ chain: o.chains.fromFacts({ kind: "device", device_key_id: "lend-check", person, path: "direct", session: "lend-check" }), action, resource })).then(r => r.effect === "allow" || (asks === true && r.effect === "ask" && /needs_approval|needs_presence/.test(String(r.reason || ""))), () => false);
}
