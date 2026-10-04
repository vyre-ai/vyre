// @ts-check
// kernel/seal/strength.js: the strength of a presence key and the ONE rule for what a strength may do (lead's ruling on PW-1). The server decides the strength at enrolment, from what it verified itself:
// `hardware` only for a key an attestation verifier accepted (Apple App Attest for the iPhone; Mac and Windows hardware keys join in RC2), `software` for every other key, whatever the client says about its own storage.
// On a release-kind server a presence-required act takes a proof only from a `hardware` key (a `software` key gets a session and nothing that needs presence: the app says "Approve this in Vyre on your phone.");
// on a development-kind server a software key satisfies presence behind the dev switch and every use is marked method "software". The sealing process (refuse in proof.js) calls strengthRefusal today; the registry's presence option (core/presence verify) is to call the same function, keyed on the METHOD of the proof (strengthOfMethod
// below), once platform wires it: until it does, the registry does NOT call it, and "a software key gets a session and nothing that needs presence" is proven for kernel acts only. Built-ins only, like the rest of kernel/seal.

/** The stable refusal code for a software key on a release-kind server; the app turns it into "Approve this in Vyre on your phone." */
export const SOFTWARE_KEY = "software_key";

/** The strength a key has: decided by the server from its own verification, never from a client's claim. @param {boolean} attested did a verifier the server runs accept an attestation for this key? @returns {"hardware" | "software"} */
export const strengthOf = attested => (attested === true ? "hardware" : "software");

/** Does this strength satisfy a presence-required act here? null when it does, else the refusal code. @param {string} strength @param {boolean} devOn is this server's dev switch on (a development-kind build that was started with it)? */
export const strengthRefusal = (strength, devOn) => (strength === "hardware" || devOn === true ? null : SOFTWARE_KEY);

/** How a proof is marked in the log and in status: "software" for any software-strength key (and so for a dev walk), "attested" for a hardware key. @param {string} strength */
export const methodOf = strength => (strength === "hardware" ? "attested" : "software");

/**
 * The revised PW-1 rule is by METHOD for the registry's presence (lead's ruling): a method that needed a person's gesture when the proof was made keeps the strength it has today on release and dev alike (Touch ID through
 * the pinned Capsule, a passkey assertion with user verification on the box's own origin, the code typed at a login terminal, the phone's Enclave key behind Face ID once App Attest is verified): those count as `hardware`
 * here, meaning "a gesture was required". A `device`-method proof (a file key a daemon or browser can use with nobody there) is not a presence method: `software`, session only; refused on release by strengthRefusal.
 * An unknown method is software. @param {string} method @returns {"hardware" | "software"}
 */
export const strengthOfMethod = method => (GESTURE_METHODS.has(String(method)) ? "hardware" : "software");
const GESTURE_METHODS = new Set(["touchid", "capsule", "passkey", "tty", "code", "window"]);
