// @ts-check
// The one published-key check. Install redeem, owner adopt, the setup offer, a phone enrol and the invitee door all call this.
// fullDevice keeps a current Ed25519 device key (an install code). A phone, a passkey or an enclave key is still a device key, so the default counts those.

const PERSON_ID_RE = /^per_[a-z2-7]{26}$/;

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * Device public keys on a verified person chain.
 * @param {{ entries?: { kind?: string, held?: string, alg?: string, pub?: string }[] } | null | undefined} state
 * @param {{ fullDevice?: boolean }} [o]
 * @returns {string[]}
 */
export function devicePubs(state, o = {}) {
  const full = o.fullDevice === true;
  return (state && state.entries || []).filter((e) => {
    if (!e || e.kind !== "device" || typeof e.pub !== "string") return false;
    if (full && (e.held || e.alg)) return false;
    return true;
  }).map((e) => /** @type {string} */ (e.pub));
}

/** Current full device keys: the published Ed25519 keys, not a passkey and not a key the web or the relay holds. @param {{ entries?: { kind?: string, held?: string, alg?: string, pub?: string }[] }} state */
export function publishedDeviceKeys(state) {
  return devicePubs(state, { fullDevice: true });
}

/**
 * The person id resolves to a published chain. When a key is offered, that key is on the chain.
 * A bad id or a missing chain is denied. An unreachable directory is unavailable. Nothing here writes.
 * @param {{ resolveById: (id: string) => Promise<any> }} dir
 * @param {string} personId
 * @param {string} [pub]
 * @param {{ fullDevice?: boolean }} [o]
 */
export async function assertPublishedKey(dir, personId, pub, o = {}) {
  if (!PERSON_ID_RE.test(String(personId || ""))) throw fail("denied", "That is not a person id. Pair again from the Vyre app.");
  /** @type {any} */
  let state;
  try { state = await dir.resolveById(String(personId)); }
  catch (e) {
    const c = /** @type {any} */ (e).code;
    if (c === "not_found" || c === "denied") throw fail("denied", "That person has no published key. Open the Vyre app and finish starting, then pair again.");
    throw fail("unavailable", "The directory could not confirm this key. Wait a minute and try again.");
  }
  if (typeof pub === "string" && pub) {
    if (!devicePubs(state, { fullDevice: o.fullDevice === true }).includes(pub)) throw fail("denied", "That key is not one this person has published. Pair again from the Vyre app.");
  }
  return state;
}
