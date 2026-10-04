// @ts-check
// The one vocabulary for the strength of a person session's key (DESIGN-one-yes): two values.
//   software  a key held in a file or a browser store: counts only where the build takes software keys (a development build)
//   real      a key of a real device: the Secure Enclave, an Android keystore, a passkey with user verification, Touch ID through the pinned Capsule (attested or not: ruling 6410c6a)
// What the server verified decides which one a row records, never what an app says about its own key storage. Rows written before the words were cut name `enclave`, `enclave, unattested` or `passkey`:
// they read as real, so nothing already stored changes meaning.
export const STRENGTHS = Object.freeze(["software", "real"]);
const LEGACY_REAL = Object.freeze(["enclave", "enclave, unattested", "passkey", "unattested"]);
/** @param {unknown} s @returns {"software" | "real"} */
export const normalizeStrength = s => (String(s) === "real" || LEGACY_REAL.includes(String(s)) ? "real" : "software");
/** The strengths that count as a person's gesture on a release server: real (and the words older rows hold). */
export const NOT_SOFTWARE = Object.freeze(new Set(["real", ...LEGACY_REAL]));
/** @param {unknown} s @returns {boolean} */
export const isNotSoftware = s => NOT_SOFTWARE.has(String(s));
