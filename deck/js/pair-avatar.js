// @ts-check
// Scan your avatar to pair your phone: the SUCCESS screen shows the SAME avatar the person just
// scanned (user, 2026-09-28: "the phone shows the same avatar, not a camera crop"), rendered
// crisply from app-design's vendored renderer, not a photo of the camera frame. The camera crop
// (deck/js/scan.js's cropAvatar) is kept only as a fallback if rendering fails - team-lead's
// call, so a rendering bug never blank-screens the success moment.
//
// The real design (team-lead's ruling, ADR 0043 2d, app-design's identity.js): the default
// avatar option is deterministic from the identity's own 8-byte public fingerprint (the same one
// deck/vyrecode/payload.js's fingerprint8 produces, and what the Vyre code itself encodes) - NOT
// a hash of the box's key, which is a different, unstable identity. `defaultAvatarOption()` is
// app-design's own function; this file just calls it.
//
// STILL PENDING from tailnet: the owner's identity fingerprint isn't in resolveTicket()'s
// verified record yet (team-lead is asking them to add it). Until it lands, `renderPersonAvatar`
// falls back to a derivation from the box's own key (this file's earlier, ASSUMED-wrong guess) -
// app-design's own words: "keep your derived fallback until that lands; just don't treat it as
// the intended mechanism." Swap the call site (deck/js/pair-scan.js's `renderAvatar()`) to pass
// the real fingerprint the moment it's available, and delete `fallbackOptionFromBoxKey` then.
//
// native-core will own the production renderer once the user locks the final design (team-lead,
// 2026-09-28); this file is the ONE place that imports it, so swapping renderers later is a
// one-file change, not a hunt through pair-scan.js.

// The renderer itself now comes through js/avatars.js, the Deck's one importer of the vendored
// avatar files (native-core, 0.1.1), so a locked-renderer swap never touches this file.
import { avatarSource, PERSON_OPTIONS } from "./avatars.js";

/** The wrong-but-stopgap derivation this file used before ADR 0043 2d ruled on the real one.
 * @param {Uint8Array} boxKey */
async function fallbackOptionFromBoxKey(boxKey) {
  const digest = await crypto.subtle.digest("SHA-256", boxKey);
  return new Uint8Array(digest)[0] % PERSON_OPTIONS;
}

/**
 * Renders the person's avatar (just the face art, not the Vyre-code ring - the ring's job ended
 * at pairing) as an SVG string, or throws if it can't (no SubtleCrypto, a malformed key).
 * @param {{ identityFingerprint?: Uint8Array | number[], boxKey: Uint8Array }} o
 * @param {number} [size]
 */
export async function renderPersonAvatar(o, size = 120) {
  if (o.identityFingerprint) return avatarSource("person", "", size, { fp: Array.from(o.identityFingerprint) });
  return avatarSource("person", "", size, { option: await fallbackOptionFromBoxKey(o.boxKey) });
}
