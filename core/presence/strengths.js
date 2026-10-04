// @ts-check
// The one vocabulary for the strength of a person session's key (ruling 194b33c, 6410c6a), so the presence column and every module that reads it cannot drift.
//   software            a key held in a file or a browser store: a session and nothing that needs presence on a release server
//   enclave             an app Secure Enclave or Android keystore key the server saw attested
//   enclave, unattested the same kind of key whose attestation the server did not verify (a sideloaded iPhone, an Android phone): counts as hardware on release (6410c6a)
//   passkey             a web passkey with user verification
// What the server verified decides which one a row records (the opening proof's chain, the attestation, user verification), never what an app says about its own key storage.
export const STRENGTHS = Object.freeze(["software", "enclave", "enclave, unattested", "passkey"]);
/** The strengths that count as a person's gesture on a release server: every one but software. */
export const NOT_SOFTWARE = Object.freeze(new Set(["enclave", "enclave, unattested", "passkey"]));
/** @param {unknown} s @returns {boolean} */
export const isNotSoftware = s => NOT_SOFTWARE.has(String(s));
