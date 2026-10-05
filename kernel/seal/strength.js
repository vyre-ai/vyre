// @ts-check
// kernel/seal/strength.js: the strength of a presence key and the ONE rule for what a strength may do (lead's ruling on PW-1). The server decides the strength at enrolment, from what it verified itself:
// `hardware` only for a key an attestation verifier accepted (Apple App Attest for the iPhone; Mac and Windows hardware keys join in RC2), `software` for every other key, whatever the client says about its own storage.
// On a release-kind server a presence-required act takes a proof only from a `hardware` key (a `software` key gets a session and nothing that needs presence: the app says "Approve this in Vyre on your phone.");
// on a development-kind server a software key satisfies presence behind the dev switch and every use is marked method "software". The sealing process (refuse in proof.js) and the registry's presence option (core/presence verify, session open and window; platform, work/kernel-reg 0c447c396) both call strengthRefusal, keyed on the METHOD of the proof
// (strengthOfMethod below), so a tool checked by the registry and an op checked by the kernel cannot differ.

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
 * A presence SESSION (and the terminal WINDOW, a reuse window opened by a proof) is not a method of its own: it inherits the method of the proof that opened it (PS-1), so the registry records the opener's method on the session row and passes it as `opener`; a session opened by
 * a gesture method keeps satisfying what it satisfies today for its lifetime, a session opened by `device` (never on release; on dev only) is software, and a session row with no opener recorded (an old row) is
 * software: fail closed. An unknown method is software. @param {string} method @param {string | null} [opener] the method that opened the session, when `method` is "session" @returns {"hardware" | "software"}
 */
export const strengthOfMethod = (method, opener = null) => (INHERITS.has(String(method)) ? strengthOfMethod(String(opener || ""), null) : GESTURE_METHODS.has(String(method)) ? "hardware" : "software");
/** A presence session and the terminal's reuse window are not gestures: each is opened by a proof and inherits that proof's method (record the opener on the row and on the window). */
const INHERITS = new Set(["session", "window"]);
/** The methods that needed a person's gesture when the proof was made. Everything else is software by default; named here so a new method is a decision: `grant` enrols the first passkey only (it is not an act: the registry exempts it explicitly, so it is software here only because nothing may satisfy an act with it), `stand-in` is development only. */
const GESTURE_METHODS = new Set(["touchid", "capsule", "passkey", "tty", "code"]);

/**
 * UY-2 (ruling 6410c6a): on a release build an enclave or Android Keystore key the server could NOT attest (the sideloaded iPhone, an Android phone whose attestation chain is not yet verified) is enrolled and says yes, marked
 * `unattested`: its method is "unattested" and its strength "unattested", never "hardware" and never "attested" (hardware means attested, or it is not said). A software key is not one of these and stays refused on release.
 * An attested key keeps its own mark. Only these signer names: the keys a phone's or a PC's secure chip holds.
 */
// A PC's TPM (Windows Hello, a P-256 key behind the user's gesture, `tpm`) is the same kind of key as a phone's chip: admitted on release when no attestation can be checked, marked unattested.
export const UNATTESTED_SIGNERS = new Set(["secure_enclave", "strongbox", "tpm"]);
/** Is this an unattested key of a signer the release rule admits? @param {{ attested?: boolean, signer?: string }} k */
export const isUnattestedEnclave = k => k.attested !== true && UNATTESTED_SIGNERS.has(String(k.signer));
