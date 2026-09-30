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

// --- Palette contrast (28 Sep, lead's ruling): the person and assistant families above use an
// abstract gradient, never a skin tone, on purpose - it sidesteps this problem entirely. The
// teammate family (round3b/original.js's `character()`) does draw a real skin tone on the head,
// light to deep, and that is where the user's "some of them were getting too dark ... weren't
// clearly visible" note landed. Two separate legibility failures, measured, not guessed:
//   1. Feature ink (eyes, mouth, glasses) was a single fixed near-black regardless of skin tone -
//      on the three deepest tones that's 1.3-2.6:1 against the skin, below any usable floor.
//   2. The head sits on whatever the surface's own backdrop is (an --hover tile in a list row, or
//      bare on --panel/--bg in a chat avatar) - the four lightest tones wash out on paper's light
//      backdrops (1.05-2.9:1) the same way the four deepest tones wash out on dark's (1.15-3.9:1).
//      Both ends needed a fix, in opposite themes, not just the dark end.
// Fixed at the source, in this shared identity module, so every family that ever draws a skin
// tone reads from one palette and one pair of helpers rather than each caller re-deriving its own
// ink/rim logic. Keeps the full range: nothing here removes or lightens a tone, only how its
// features and edge render.

/** Relative luminance and WCAG contrast ratio, plain sRGB hex in, no deps. */
function hexToRgb(hex) { hex = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)); }
function relLuminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [R, G, B] = [r, g, b].map(f);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(hex1, hex2) {
  const l1 = relLuminance(hexToRgb(hex1)), l2 = relLuminance(hexToRgb(hex2));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
function hexBlend(fg, bg, alpha) {
  const [fr, fgc, fb] = hexToRgb(fg), [br, bgc, bb] = hexToRgb(bg);
  const mix = (a, b) => Math.round(a * alpha + b * (1 - alpha));
  return "#" + [mix(fr, br), mix(fgc, bgc), mix(fb, bb)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// Warm, realistic skin tones, light to deep - kept here as the canonical copy; round3b/original.js
// imports this array rather than restating it. Nothing removed, nothing lightened: the fix is
// ink and edge treatment, never the tones themselves.
const SKIN_TONES = ["#FBE0C6", "#F1C79B", "#E0AC7C", "#C98A57", "#A8683D", "#7D4C2C", "#5C3620", "#3E2417"];

const CONTRAST_FLOOR = 3; // the floor this ruling holds every combination to, both checks below
const DARK_INK = "#141311";
const LIGHT_INK = "#F1EEE6"; // the same cream creature.js already uses for its eye sparkle

/** The feature ink (eyes, mouth, glasses) for a given skin tone: dark ink everywhere it clears
 * the floor, a light ink only on the tones dark enough that dark ink no longer would. Never a
 * per-seed choice - the same skin tone always gets the same ink, so a reroll never flips a
 * teammate's feature colour on its own. */
function featureInkFor(skinHex) {
  return contrastRatio(skinHex, DARK_INK) >= CONTRAST_FLOOR ? DARK_INK : LIGHT_INK;
}

// The two backdrop sets a skin tone actually renders against in product surfaces: an --hover
// tile in a list row, or bare on --panel/--bg in a chat avatar (avatar-showcase/build.js's
// tokens, the newest render of the real system palette). Both themes' full set is checked, not
// just the closest one, since a rim's blended result differs per backdrop.
const BACKDROPS = {
  dark: { bg: "#111110", panel: "#1A1917", hover: "#221F1C" },
  paper: { bg: "#F4F1EA", panel: "#FFFFFF", hover: "#EEEAE0" },
};
// A rim drawn just inside the head's edge, opaque enough on its own theme's ink to guarantee
// >=3:1 against every backdrop in that theme (see round4/check-palette.js for the tuning pass:
// 0.4 was the minimum for dark, 0.5 for paper; both carry a margin here, landing at 5.2:1 and
// 4.6:1 worst-case rather than sitting on the floor). Colour is the theme's own ink, inverted from
// the feature ink above (light rim in dark theme, dark rim in paper theme) - this is a backdrop
// treatment, unrelated to which ink the features inside the head are using.
const RIM = {
  dark: { color: LIGHT_INK, opacity: 0.55 },
  paper: { color: DARK_INK, opacity: 0.6 },
};

/** Whether skinHex needs the rim in this theme: true if it fails the floor against any backdrop
 * that theme actually uses. */
function needsRim(skinHex, theme) {
  return Object.values(BACKDROPS[theme]).some((bd) => contrastRatio(skinHex, bd) < CONTRAST_FLOOR);
}

/** The rim spec to draw for this skin tone and theme, or null if the tone already clears the
 * floor against every backdrop in that theme unaided. `character()` in round3b/original.js calls
 * this once per render. */
function rimFor(skinHex, theme) {
  return needsRim(skinHex, theme) ? RIM[theme] : null;
}

// --- Project tiles (28 Sep, the user's approved 5th family) ---------------------------------
// A project isn't a being - a rounded tile with a mark and colour, not a creature or a face.
// Seeded from the project's own stored avatar_seed (falling back to its permanent id, never its
// name, so a rename never reseeds it). 8 hues, spread across three arcs (0-50, 115-225,
// 285-360deg) that keep the same wide margin from lime (~80deg) and violet (~253deg) every other
// palette here already keeps - an even 45deg step would land two hues inside the lime band, so
// these are picked by hand within the allowed arcs instead. Saturation and lightness are tuned
// per hue (not one fixed S/L) so every hue clears the dark-ink floor with margin (3.3-10.8:1) AND
// clears its backdrop floor without needing rimFor()'s help where avoidable (4.6-9.5:1 worst
// case) - a flat S=60/L=48 across all 8 left one hue (a magenta-pink) sitting at 3.13:1, legal but
// too close to the floor for comfort.
const PROJECT_COLORS = ["#A34F3E", "#DA932F", "#2FDA4B", "#2FDA93", "#2FDADA", "#2F93DA", "#B620AA", "#BC2F6A"];

/** Validates every skin tone against every theme's full backdrop set, and every skin tone against
 * its own derived feature ink - the two checks this ruling requires. Throws with the specific
 * failing combination rather than letting a bad palette edit ship silently, the same contract
 * geometry.js's validateGeometry() gives the Vyre code ring. Also validates PROJECT_COLORS the
 * same way (fill-vs-backdrop via rimFor, mark-vs-fill via featureInkFor) - one function, one
 * floor, for every palette in this module, per the lead's "same contrast floors" instruction.
 * Call after editing SKIN_TONES, PROJECT_COLORS, DARK_INK, LIGHT_INK, RIM or BACKDROPS. */
function validatePalette({ floor = CONTRAST_FLOOR } = {}) {
  const results = [];
  for (const [group, tones] of [["skin", SKIN_TONES], ["project", PROJECT_COLORS]]) {
    for (const tone of tones) {
      const ink = featureInkFor(tone);
      const inkContrast = contrastRatio(tone, ink);
      if (inkContrast < floor) {
        throw new Error(`${group} tone ${tone}: mark/feature ink ${ink} is ${inkContrast.toFixed(2)}:1, ` +
          `below the ${floor}:1 floor.`);
      }
      for (const theme of Object.keys(BACKDROPS)) {
        const rim = rimFor(tone, theme);
        for (const [name, bd] of Object.entries(BACKDROPS[theme])) {
          const rendered = rim ? hexBlend(rim.color, bd, rim.opacity) : tone;
          const c = contrastRatio(rendered, bd);
          if (c < floor) {
            throw new Error(`${group} tone ${tone} in ${theme} theme against ${name} (${bd}): ` +
              `${c.toFixed(2)}:1${rim ? " even with the rim" : " (no rim applied)"}, below the ` +
              `${floor}:1 floor.`);
          }
          results.push({ group, tone, theme, backdrop: name, contrast: c, rim: !!rim, ink, inkContrast });
        }
      }
    }
  }
  return results;
}

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

export {
  userAvatar, assistantAvatar, USER_GRADIENTS, ASSISTANT_GRADIENTS, defaultAvatarOption,
  SKIN_TONES, PROJECT_COLORS, DARK_INK, LIGHT_INK, RIM, BACKDROPS, CONTRAST_FLOOR,
  featureInkFor, needsRim, rimFor, validatePalette, contrastRatio,
};
