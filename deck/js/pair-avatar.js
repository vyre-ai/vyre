// @ts-check
// Scan your avatar to pair your phone: the SUCCESS screen shows the SAME avatar the person just
// scanned (user, 2026-09-28: "the phone shows the same avatar, not a camera crop"), rendered
// crisply from app-design's vendored renderer, not a photo of the camera frame. The camera crop
// (deck/js/scan.js's cropAvatar) is kept only as a fallback if rendering fails - team-lead's
// call, so a rendering bug never blank-screens the success moment.
//
// ASSUMED, not confirmed with app-design/tailnet: pairing (relay/client/client.js's pairTicket)
// doesn't hand back an avatar seed or option index today, so this derives one itself from the
// box's own verified public key the same way round5's identity.js describes avatars being
// seeded ("from the person's own public identity... never a secret") - sha256(box key), first
// byte mod the option count. If the box picks its own avatar some OTHER way (a stored choice,
// not a pure function of its key), this will render a DIFFERENT avatar than the one on the
// Deck, not "the same" one team-lead asked for. Flagged to app-design; swap `avatarOption()`
// below for whatever the real derivation turns out to be once confirmed.
//
// native-core will own the production renderer once the user locks the final design (team-lead,
// 2026-09-28); this file is the ONE place that imports it, so swapping renderers later is a
// one-file change, not a hunt through pair-scan.js.

import { userAvatar, USER_GRADIENTS } from "../vendor/vyrecode/identity.js";

/** @param {Uint8Array} boxKey the verified box public key (32 bytes) */
async function avatarOption(boxKey) {
  const digest = await crypto.subtle.digest("SHA-256", boxKey);
  return new Uint8Array(digest)[0] % USER_GRADIENTS.length;
}

/**
 * Renders the person's avatar (just the face art, not the Vyre-code ring - the ring's job ended
 * at pairing) as an SVG string, or throws if it can't (no SubtleCrypto, a malformed key).
 * @param {Uint8Array} boxKey @param {number} [size]
 */
export async function renderPersonAvatar(boxKey, size = 120) {
  const option = await avatarOption(boxKey);
  return userAvatar(option, size);
}
