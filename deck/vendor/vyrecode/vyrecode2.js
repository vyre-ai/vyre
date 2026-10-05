// The beauty pass (the lead, the user's "eww" on round 5's first look): the face fills ~60% of
// the diameter, at most 2 rings, ticks/dots coloured from the avatar's OWN palette on a soft
// tint (never stark black/white), the orientation marker disguised as a small ornamental detail.
// 144 bits still fits: 2 rings x 36 positions x 2 bits each (four discrete lengths/sizes per
// mark, not just on/off) = 144 bits, same total as round 5's first pass, half the marks.
//
// Three visual directions, one geometry, so a decode pass (once the direction is picked) only
// has to support one physical layout: dots-palette (size = 2-bit value), dashes-rounded (pill
// length = 2-bit value, the Spotify-code look), ticks-sunburst (thin radial line, length = 2-bit
// value - the direction the lead flagged as most promising).
import { userAvatar, USER_GRADIENTS } from "./identity.js";
// Geometry constants (RING_R, tick/marker reach formulas, the outer-margin invariant) now live
// in geometry.js, the single shared source pwa's decoder also imports (ADR 0033 2a: the two
// files drifted out of sync by hand once already, which is what this consolidation fixes).
import * as geo from "../../../lib/wink-code/geometry.js";
const { CENTER, FACE_D, FACE_R, RINGS, PER_RING, ANGLE_STEP, RING_R, LEVELS, tickLength } = geo;
geo.validateGeometry(); // throws loudly if a future edit here breaks the margin/gap invariant

/** Two bits at position i (0..143) -> one of 4 levels for mark floor(i/2). */
function bitsToLevels(bits) {
  const levels = [];
  for (let i = 0; i < bits.length; i += 2) levels.push((bits[i] << 1) | bits[i + 1]);
  return levels;
}
function levelsToBits(levels) {
  const bits = [];
  for (const lv of levels) { bits.push((lv >> 1) & 1, lv & 1); }
  return bits;
}

function markGeometry(i) {
  const ring = Math.floor(i / PER_RING);
  const slot = i % PER_RING;
  const angleDeg = slot * ANGLE_STEP;
  return { ring, slot, angleDeg, r: RING_R[ring] };
}

/** A soft tint of a gradient's warm stop, for the ground; a deeper shade of the same stop for
 * the marks - "the avatar's own palette," never a flat black/white pair. */
function paletteFor(theme, option) {
  const [warm, deep] = USER_GRADIENTS[option % USER_GRADIENTS.length];
  // "tint" is mostly the theme's own neutral ground with only a whisper of the avatar's hue
  // (first attempt had this backwards - 86% hue, 14% neutral - and the whole disc read as a flat
  // saturated pink block instead of a soft wash, which is exactly the "eww" the user flagged).
  //
  // pwa's decode pass rate dropped against the REAL palette (vs. their earlier flat-color test
  // fixture): measured why rather than guessing - dark theme's mark/markDeep sit at 8.5-12.3:1
  // contrast against the tint (light-on-near-black, plenty of headroom), but paper theme's old
  // formula (mark at a 0.3 ink-mix, markDeep as the raw "deep" gradient stop with NO ink mix at
  // all) measured only 2.96-4.44:1 for mark and a genuinely weak 1.59-2.57:1 for markDeep across
  // the 4 USER_GRADIENTS options - not enough margin to survive blur/scale degradation, which is
  // exactly the failure pwa reported. Deepened both paper mixes (0.3->0.5, and markDeep's
  // implicit 0->0.65) to a worst-case 4.86:1 / 7.35:1 across all 4 options - still the gradient's
  // own hue, just enough ink to hold up under real-camera conditions, not the "eww" flat block.
  return theme === "dark"
    ? { ground: "#0E0D0C", tint: hexMix(warm, "#161513", 0.92), mark: hexMix(warm, "#F1EEE6", 0.4), markDeep: warm }
    : { ground: "#F4F1EA", tint: hexMix(warm, "#FBFAF6", 0.92), mark: hexMix(deep, "#141311", 0.5), markDeep: hexMix(deep, "#141311", 0.65) };
}
function hexMix(a, b, t) {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  const m = pa.map((v, i) => Math.round(v * (1 - t) + pb[i] * t));
  return "#" + m.map(v => v.toString(16).padStart(2, "0")).join("");
}

/** The orientation cue, disguised: 3 small dots ascending in size at 12 o'clock, sitting in the
 * same visual language as the marks (not a separate glyph) - reads as an ornamental flourish, a
 * human "this is the top" cue, never load-bearing for decode (the rotation+RS search still does
 * the real work; see decode-core.js). */
function markerDots(pal, r0) {
  // Offsets/radii come from geometry.js (geo.markerOffset/markerRadius), the same formulas the
  // outer-margin invariant is computed against - see the ADR 0033 2a note there for why this
  // marker, not the ticks, was the real cause of the first pass's thin outer margin.
  return Array.from({ length: geo.MARKER_COUNT }, (_, k) => {
    const rad = -Math.PI / 2;
    const rr = r0 + geo.markerOffset(k);
    const x = CENTER + Math.cos(rad) * rr, y = CENTER + Math.sin(rad) * rr;
    return `<circle cx="${x}" cy="${y}" r="${geo.markerRadius(k)}" fill="${pal.markDeep}"/>`;
  }).join("");
}

const STYLES2 = {
  dotsPalette: {
    name: "Palette dots",
    mark(x, y, level, pal, angleDeg) {
      const r = 3.5 + level * 2.4; // 4 sizes
      const fill = level >= 2 ? pal.markDeep : pal.mark;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
    },
  },
  dashesRounded: {
    name: "Rounded dashes",
    mark(x, y, level, pal, angleDeg) {
      const len = 7 + level * 5; // 4 lengths
      const rad = (angleDeg - 90) * Math.PI / 180;
      const x2 = x + Math.cos(rad) * len / 2, y2 = y + Math.sin(rad) * len / 2;
      const x1 = x - Math.cos(rad) * len / 2, y1 = y - Math.sin(rad) * len / 2;
      const fill = level >= 2 ? pal.markDeep : pal.mark;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${fill}" stroke-width="6" stroke-linecap="round"/>`;
    },
  },
  ticksSunburst: {
    name: "Sunburst ticks",
    mark(x, y, level, pal, angleDeg) {
      const len = tickLength(level); // 6, 12, 18, 24 - from geometry.js, shared with the decoder
      const rad = (angleDeg - 90) * Math.PI / 180;
      const x1 = x, y1 = y;
      const x2 = x + Math.cos(rad) * len, y2 = y + Math.sin(rad) * len;
      const fill = level >= 2 ? pal.markDeep : pal.mark;
      // Level 0's opacity dip was 0.55 - stacked with the old paper-theme contrast gap above, the
      // shortest/lowest-value ticks were the least reliable mark in the whole ring. 0.55 was an
      // aesthetic softening with no decode headroom behind it; 0.85 keeps a little visual
      // hierarchy without giving blur/scale a mark that was already faint twice over.
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${fill}" stroke-width="${geo.TICK_STROKE_WIDTH}" stroke-linecap="round" opacity="${level === 0 ? 0.85 : 1}"/>`;
    },
  },
};

/**
 * Renders a beauty-pass Vyre code. `levels` is a 72-length array of 0-3 (see bitsToLevels).
 * `userOption` picks both the face and the palette (same seed drives both, "same hand").
 */
function renderCode2(levels, { userOption = 0, style = "ticksSunburst", theme = "dark", size = 600, faceSvg = null } = {}) {
  const pal = paletteFor(theme, userOption);
  const s = STYLES2[style];
  const marks = levels.map((level, i) => {
    const { angleDeg, r } = markGeometry(i);
    const rad = (angleDeg - 90) * Math.PI / 180;
    const x = CENTER + Math.cos(rad) * r, y = CENTER + Math.sin(rad) * r;
    return s.mark(x, y, level, pal, angleDeg);
  }).join("");
  // faceSvg lets a caller pass the assistant's creature instead of the person's face, so both
  // halves of a pair share this exact ring geometry and palette technique - "same hand."
  const face = faceSvg ? faceSvg(FACE_D) : userAvatar(userOption, FACE_D);
  // Both face sources (identity.js's userAvatar, creature.js) draw into their own fixed
  // viewBox (0 0 120 120) regardless of the width/height we pass them - stripping the outer
  // <svg> tag (below) throws away the browser's automatic viewBox->size scaling along with it,
  // so the content was rendering at its native 120 units inside a FACE_D=360 slot (a third of
  // the intended size) instead of filling it. Read the face's own viewBox and scale explicitly
  // so this holds for any face source, not just the current 120-unit ones.
  const faceViewBox = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(face);
  const faceNativeW = faceViewBox ? parseFloat(faceViewBox[1]) : FACE_D;
  const faceScale = FACE_D / faceNativeW;
  const faceWrapped = `<g transform="translate(${CENTER - FACE_R}, ${CENTER - FACE_R}) scale(${faceScale})">${face.replace(/<svg[^>]*>|<\/svg>/g, "")}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CENTER * 2} ${CENTER * 2}" width="${size}" height="${size}">
    <rect width="${CENTER * 2}" height="${CENTER * 2}" fill="${pal.ground}"/>
    <circle cx="${CENTER}" cy="${CENTER}" r="${RING_R[1] + 40}" fill="${pal.tint}"/>
    ${marks}
    ${markerDots(pal, RING_R[1])}
    ${faceWrapped}
  </svg>`;
}

export { renderCode2, STYLES2, bitsToLevels, levelsToBits, RINGS, PER_RING, ANGLE_STEP, RING_R, CENTER, FACE_R, paletteFor };
