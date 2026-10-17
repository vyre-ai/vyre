// @ts-check
// lib/credential-held.js: does a person hold a vault credential now (an answer only, never a chain or a value)? The owner holds all of the vault they own; anyone else, what a grant gives.
// Asked for a lend (the approver must hold what they lend) and, at each use, of a lease's approver. Any error counts as not held.

/** @param {{ grantsStore: any, gateway: { authorize: (q: any) => Promise<any> }, chains: any, space: string }} o */
export function createCredentialHeld(o) {
  /** @param {string} person @param {string} action @param {string} resource @returns {Promise<boolean>} */
  return async (person, action, resource) => o.grantsStore.roleOf({ kind: "person", id: person, space: o.space }) === "owner" || Promise.resolve().then(() => o.gateway.authorize({ chain: o.chains.fromFacts({ kind: "device", device_key_id: "lend-check", person, path: "direct", session: "lend-check" }), action, resource })).then(r => r.effect === "allow" || (action === "vault.call" && r.effect === "ask" && r.reason === "needs_approval"), () => false);   // vault.call is an outward act: once every hop holds the grant the kernel's word is its ask, and holding is what is asked here (the Gate holds the send)
}
