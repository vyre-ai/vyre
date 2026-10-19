// The pages that only exist in the sample world or a proof build: demos, galleries, proofs and the screenshot pages. A release build must not register them as routes. One list, read by metro.config.js (which
// leaves them out of every build but the mock build), by scripts/check-release-routes.mjs (which fails the release export if one is in it) and by scripts/shot-routes.test.js.

/** Pages left out of every build except the mock build (EXPO_PUBLIC_VYRE_MOCK=1): a path under app/ without .tsx, "/" between folders. A name may be a pattern (letters and - only). */
export const MOCK_ONLY = ["gallery", "shots-[a-z]+", "terminal-demo", "keycheck", "chat-demo", "connect-demo", "glass-relay-proof", "notices-proof", "u/vault-design", "u/flows/shot"];

/** Pages left out of every build except the mock build and the proof build (EXPO_PUBLIC_VYRE_PROOF=1). */
export const PROOF_OR_MOCK = ["two-servers-proof"];

/** The file regex Metro's block list takes for some names: app/<name>.tsx on either kind of path separator. @param {string[]} names */
export const blockRe = (names) => new RegExp(`[\\\\/]app[\\\\/](${names.map((n) => n.replace(/\//g, "[\\\\/]")).join("|")})\\.tsx$`);
