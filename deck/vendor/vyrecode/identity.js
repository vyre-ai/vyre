// Round 4: two new identity families, the same hand as agents/teammates but clearly their own.
//
// Shape family, extending avatar.md's existing rule ("only the person gets a circle"):
//   agent    = an organic blob, no tile at all (round3/round3b, unchanged)
//   teammate = rounded-square tile, radius size/4 (round3b, unchanged)
//   person   = a true circle (avatar.md's existing rule) - a warm gradient disc, a calm face,
//              no hair, no headwear, no role prop: this is the one person, not a role
//   assistant = a soft squircle (radius size/2.2, rounder than a teammate tile, short of a full
//              circle so it never gets mistaken for the person): a luminous mark, not a face,
//              since it is not a creature and not a person
//
// A few numbered options per identity, picked once and kept. Ruling (lead, 28 Sep, ADR 0043):
// the DEFAULT option is derived deterministically from the identity's own 8-byte fingerprint
// (payload.js's fingerprint8 - the same public id the Vyre code encodes, never a secret), so
// everyone gets a unique, stable avatar with zero setup - "unique by design." A stored pick is
// optional, overrides the default, and only the person themself can set it (never derived from a
// device or box key - that was a stopgap someone else guessed at, not the design). See
// defaultAvatarOption below.

/**
 * The default avatar option for an identity, derived from its own 8-byte public fingerprint
 * (payload.js's fingerprint8 output - never a secret). Deterministic and stable: the same
 * fingerprint always yields the same option, with no storage or setup needed. Any single byte of
 * a SHA-256 digest is uniformly distributed, so byte 0 is as good as any - picked for simplicity,
 * not significance. Used for both the person (their own fingerprint) and the assistant
 * (creature.js: "seeded from the ASSISTANT's own public id, never the person's" - pass its
 * fingerprint here too, never the person's, so the two are never accidentally in lockstep).
 * A caller with a stored, person-set override should use that value instead and never call this
 * at all - this is the zero-setup default, not a fallback to blend with a stored pick.
 * @param {number[]} fingerprint8Bytes
 * @param {number} optionCount
 */
function defaultAvatarOption(fingerprint8Bytes, optionCount) {
  return fingerprint8Bytes[0] % optionCount;
}

function hashSeed(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

// Warm gradient pairs for the person, kept off lime/violet the same way every other palette here
// is (swept in round4/check.js before export).
const USER_GRADIENTS = [
  ["#F7C9A6", "#EE9B6B"], ["#F6E0A6", "#EFC15E"], ["#F3B3C4", "#E6789A"], ["#A9E0C9", "#5FBE95"],
];
const USER_FACE = "#141311";

/**
 * The person: a true circle, a warm two-tone gradient, a calm closed-eye or gentle-smile face,
 * nothing else (no hair, no accessory) - the point is that it is always the same one identity,
 * not a rolled character. `option` 0-3 picks the gradient and the small facial variation; the
 * shape and technique never change, so a reroll always still reads as "this same product."
 */
function userAvatar(option = 0, size = 120) {
  const [c1, c2] = USER_GRADIENTS[option % USER_GRADIENTS.length];
  const gid = `ug${option}`;
  const closedEyes = option % 2 === 0;
  const face = closedEyes
    ? `<path d="M44 54 Q48 50 52 54" stroke="${USER_FACE}" stroke-width="3" fill="none" stroke-linecap="round"/>
       <path d="M68 54 Q72 50 76 54" stroke="${USER_FACE}" stroke-width="3" fill="none" stroke-linecap="round"/>
       <path d="M50 68 Q60 76 70 68" stroke="${USER_FACE}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`
    : `<circle cx="48" cy="54" r="4" fill="${USER_FACE}"/><circle cx="72" cy="54" r="4" fill="${USER_FACE}"/>
       <path d="M50 68 Q60 74 70 68" stroke="${USER_FACE}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">
    <defs><radialGradient id="${gid}" cx="35%" cy="30%" r="80%">
      <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
    </radialGradient></defs>
    <circle cx="60" cy="60" r="58" fill="url(#${gid})"/>
    ${face}
  </svg>`;
}

// Cool-to-warm luminous pairs for the assistant, a different family from the person's palette so
// the two are never confusable even in monochrome (paper theme, print, a colour-blind check).
const ASSISTANT_GRADIENTS = [
  ["#EAF3E8", "#F0E6C9"], // a pale sage-to-straw wash, checked well clear of the true lime hex
  ["#FDEFD8", "#F0C97A"], ["#E4F1F0", "#8FC7C2"],
];
// ui-ux found this live: a soft light-to-mid gradient like the ones above has almost no contrast
// against a near-white paper ground (#F5F2EA/#FBFAF6) on its own (checked: ~1.0-1.1:1, nowhere
// near usable) - that's true of every option here, not just the one they hit, since it's the
// gradient technique itself, not one bad colour pick. A caller-side border works but makes every
// caller responsible for a fix that belongs in the source. Fixed at the source instead: every
// assistant avatar carries its own hairline ink ring, so it always has a defining edge regardless
// of what it sits on, the same principle avatar.md already uses for the person's 1px ring (see
// the status-mark overlay). Kept faint (14% opacity) so it reads as an edge, not a border, on the
// dark ground where the gradient already has real contrast.
const ASSISTANT_RING = "#141311";
const ASSISTANT_RING_OPACITY = 0.14;
const MARKS = ["spark", "ring", "chevron"];

/**
 * The assistant (juno): a soft squircle, never a face, never a creature - a luminous mark, three
 * directions to choose a favourite from. `option` 0-2 picks both the gradient and the mark, kept
 * together so each option is a complete, considered look, not a shuffle of independent parts.
 */
function assistantAvatar(option = 0, size = 120) {
  const [c1, c2] = ASSISTANT_GRADIENTS[option % ASSISTANT_GRADIENTS.length];
  const mark = MARKS[option % MARKS.length];
  const gid = `ag${option}`;
  const r = size >= 120 ? 46 : 46; // radius in the 120-unit canvas; scales with viewBox, not px
  const glyph = {
    spark: `<path d="M60 30 L66 54 L90 60 L66 66 L60 90 L54 66 L30 60 L54 54 Z" fill="#141311" opacity="0.86"/>`,
    ring: `<circle cx="60" cy="60" r="20" fill="none" stroke="#141311" stroke-width="7" opacity="0.86"/>
      <circle cx="60" cy="60" r="5" fill="#141311" opacity="0.86"/>`,
    chevron: `<path d="M42 44 L60 62 L42 80" stroke="#141311" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.86"/>
      <path d="M64 44 L82 62 L64 80" stroke="#141311" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>`,
  }[mark];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">
    <defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect x="2" y="2" width="116" height="116" rx="${r}" fill="url(#${gid})"
      stroke="${ASSISTANT_RING}" stroke-opacity="${ASSISTANT_RING_OPACITY}" stroke-width="2"/>
    ${glyph}
  </svg>`;
}

export { userAvatar, assistantAvatar, USER_GRADIENTS, ASSISTANT_GRADIENTS, defaultAvatarOption };
